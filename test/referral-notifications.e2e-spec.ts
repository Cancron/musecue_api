// Must be first: PostgreSQL-only infrastructure (no Redis), mock AI and local
// storage, set before any application module reads the environment.
import './support/env-postgres-mode';
import { userRole } from '@prisma/client';
import { NotificationService } from '../src/notifications/notification.service';
import { NotificationOutboxService } from '../src/notifications/delivery/notification-outbox.service';
import { createAccount, type TestAccount } from './support/discount-fixtures';
import { FakeStripeApi } from './support/fake-stripe-api';
import { eventually } from './support/infrastructure-flows';
import {
  applyMigrations,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';
import {
  bootReferralApp,
  dataOf,
  messageOf,
  referralFlows,
  type ReferralApp,
  type SignedUp,
} from './support/referral-flows';

jest.setTimeout(300_000);

interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

interface PageView {
  items: NotificationView[];
  nextCursor: string | null;
  unreadCount: number;
}

interface PreferencesView {
  email: {
    referralRewards: boolean;
    referralMilestones: boolean;
    gifts: boolean;
    security: boolean;
  };
  updatedAt: string | null;
}

const INBOX = '/v1/notifications';

/**
 * Notifications of referral rewards and milestones (and security events),
 * through the complete application, the Stripe flow and the email queue:
 * - one inbox entry and at most one email per event, whatever the webhook
 *   retries, concurrency or application restarts;
 * - held referrals notify nothing until approved;
 * - the inbox is the owner's only (paging, read/unread, read-all);
 * - referral emails follow the user's preferences, security emails are
 *   mandatory.
 */
describeWithDatabase(
  'Referral notifications (PostgreSQL, full stack, Stripe, email queue)',
  () => {
    let app: ReferralApp;
    let r: ReturnType<typeof referralFlows>;
    let admin: TestAccount;

    const outbox = () =>
      app.ctx.get<NotificationOutboxService>(NotificationOutboxService);
    const inbox = async (account: TestAccount, query = '') =>
      dataOf<PageView>(await r.get(account, `${INBOX}${query}`).expect(200));
    /** Dispatches pending emails and waits until none is left in flight. */
    const deliverEmails = async () => {
      await outbox().dispatchPending();
      await eventually(
        async () =>
          (await app.ctx.client.notification.count({
            where: { emailStatus: { in: ['PENDING', 'SENDING'] } },
          })) === 0,
        30_000,
        'notification emails to be sent',
      );
    };
    const referred = async (): Promise<{
      referrer: SignedUp;
      friend: SignedUp;
    }> => {
      const referrer = await r.signUp({ prefix: 'ref' });
      const friend = await r.signUp({
        prefix: 'fr',
        referralCode: await r.codeOf(referrer),
      });
      return { referrer, friend };
    };
    let cardSeq = 0;
    const newCard = () => `card_nt_${Date.now().toString(36)}_${cardSeq++}`;

    beforeAll(async () => {
      app = await bootReferralApp();
      r = referralFlows(app);
      admin = await r.admin();
    });

    beforeEach(async () => {
      app.stripe.api = new FakeStripeApi(5);
      await r.setDiscountSettings(admin, {
        firstPurchaseDiscountPercent: 0,
        referralDiscountPercent: 0,
        referrerRewardCredits: 100,
      });
      await r.milestones(admin).reset();
    });

    afterAll(async () => {
      await app?.ctx.close();
    });

    describe('referral events', () => {
      it('notifies the referrer once, in the inbox and by one email, despite repeated and concurrent webhooks', async () => {
        const { referrer, friend } = await referred();
        const checkout = await r.checkout(friend);
        const sessionId = await r.payCheckout(checkout.checkoutSessionId);
        const invoiceId = app.stripe.api.sessions.get(sessionId)
          ?.invoice as string;
        const responses = await Promise.all([
          r.sessionEvent('checkout.session.completed', sessionId),
          r.sessionEvent('checkout.session.completed', sessionId),
          r.invoiceEvent('invoice.paid', invoiceId),
          r.invoiceEvent('invoice.paid', invoiceId),
        ]);
        expect(responses.map((res) => res.status)).toEqual([
          200, 200, 200, 200,
        ]);
        await r
          .sessionEvent('checkout.session.completed', sessionId)
          .expect(200);

        const referral = (await r.referralOf(friend.id))!;
        const page = await inbox(referrer);
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({
          type: 'REFERRAL_REWARD_EARNED',
          title: 'You earned 100 referral credits',
          data: { referralId: referral.id, credits: 100 },
          read: false,
        });
        expect(page.unreadCount).toBe(1);
        // The invited user is not notified of the referrer's reward.
        expect((await inbox(friend)).items).toEqual([]);

        // Concurrent and repeated dispatching emails once.
        await Promise.all([
          outbox().dispatchPending(),
          outbox().dispatchPending(),
        ]);
        await deliverEmails();
        await deliverEmails();
        expect(r.notificationEmailsTo(referrer.email)).toEqual([
          {
            kind: 'notification',
            to: referrer.email,
            subject: 'You earned 100 referral credits',
          },
        ]);
        await expect(
          app.ctx.client.notification.findFirstOrThrow({
            where: { authId: referrer.id },
          }),
        ).resolves.toMatchObject({ emailStatus: 'SENT', emailAttempts: 1 });
      });

      it('notifies a reached milestone once, next to the referral reward', async () => {
        await r.milestones(admin).ensure(1, 40);
        const { referrer, friend } = await referred();
        await r.buyPro(friend, undefined, { cardFingerprint: newCard() });
        await deliverEmails();

        const types = (await inbox(referrer)).items.map((n) => n.type).sort();
        expect(types).toEqual([
          'REFERRAL_MILESTONE_REACHED',
          'REFERRAL_REWARD_EARNED',
        ]);
        const milestone = (await inbox(referrer)).items.find(
          (n) => n.type === 'REFERRAL_MILESTONE_REACHED',
        )!;
        expect(milestone).toMatchObject({
          title: 'Milestone reached: 1 paid referral',
          data: { referralCount: 1, credits: 40 },
        });
        expect(
          r
            .notificationEmailsTo(referrer.email)
            .map((e) => e.subject)
            .sort(),
        ).toEqual([
          'Milestone reached: 1 paid referral',
          'You earned 100 referral credits',
        ]);
      });

      it('notifies nothing for a held referral until an administrator approves it, and nothing when rejected', async () => {
        const { referrer, friend } = await referred();
        const card = newCard();
        await r.buyPro(referrer, undefined, { cardFingerprint: card });
        await r.buyPro(friend, undefined, { cardFingerprint: card });
        const held = (await r.referralOf(friend.id))!;
        expect(held.status).toBe('HELD');
        await deliverEmails();
        expect((await inbox(referrer)).items).toEqual([]);
        expect(r.notificationEmailsTo(referrer.email)).toEqual([]);

        await r
          .post(admin, `/v1/admin/referrals/${held.id}/approve`)
          .expect(200);
        await r
          .post(admin, `/v1/admin/referrals/${held.id}/approve`)
          .expect(409);
        await deliverEmails();
        expect((await inbox(referrer)).items).toMatchObject([
          { type: 'REFERRAL_REWARD_EARNED', data: { referralId: held.id } },
        ]);
        expect(r.notificationEmailsTo(referrer.email)).toHaveLength(1);

        // Rejected: nothing at all.
        const other = await referred();
        const shared = newCard();
        await r.buyPro(other.referrer, undefined, { cardFingerprint: shared });
        await r.buyPro(other.friend, undefined, { cardFingerprint: shared });
        const rejected = (await r.referralOf(other.friend.id))!;
        await r
          .post(admin, `/v1/admin/referrals/${rejected.id}/reject`)
          .expect(200);
        await deliverEmails();
        expect((await inbox(other.referrer)).items).toEqual([]);
        expect(r.notificationEmailsTo(other.referrer.email)).toEqual([]);
      });
    });

    describe('inbox', () => {
      /** `count` notifications for the account, oldest first. */
      const seed = async (account: TestAccount, count: number) => {
        const service = app.ctx.get<NotificationService>(NotificationService);
        for (let i = 0; i < count; i += 1) {
          await service.notify(app.ctx.client, account.id, `test:seed:${i}`, {
            type: 'REFERRAL_REWARD_EARNED',
            title: `Seeded ${i}`,
            body: 'Seeded notification',
          });
        }
        // Seeded entries are not emailed by this test.
        await app.ctx.client.notification.updateMany({
          where: { authId: account.id, emailStatus: 'PENDING' },
          data: { emailStatus: 'NOT_REQUESTED' },
        });
      };

      it('pages the owner’s notifications newest first with a cursor', async () => {
        const user = await createAccount(app.ctx);
        await seed(user, 23);
        const seen: string[] = [];
        let cursor: string | null = null;
        const sizes: number[] = [];
        do {
          const page: PageView = await inbox(
            user,
            `?limit=10${cursor ? `&cursor=${cursor}` : ''}`,
          );
          sizes.push(page.items.length);
          seen.push(...page.items.map((n) => n.title));
          expect(page.unreadCount).toBe(23);
          cursor = page.nextCursor;
        } while (cursor);
        expect(sizes).toEqual([10, 10, 3]);
        expect(seen).toEqual(
          Array.from({ length: 23 }, (_, i) => `Seeded ${22 - i}`),
        );
        // Default page size 20.
        const first = await inbox(user);
        expect(first.items).toHaveLength(20);
        expect(first.nextCursor).not.toBeNull();

        for (const query of [
          '?limit=0',
          '?limit=51',
          '?limit=abc',
          '?status=archived',
          '?cursor=not-a-cursor',
          `?cursor=${Buffer.from('2025-01-01T00:00:00.000Z|x').toString('base64url')}`,
        ]) {
          await r.get(user, `${INBOX}${query}`).expect(400);
        }
        await r.http().get(INBOX).expect(401);
      });

      it('marks notifications read and unread, counts unread ones and marks all read', async () => {
        const user = await createAccount(app.ctx);
        await seed(user, 4);
        const [newest, second] = (await inbox(user)).items;

        const read = dataOf<NotificationView>(
          await r
            .patch(user, `${INBOX}/${newest.id}`, { read: true })
            .expect(200),
        );
        expect(read).toMatchObject({ id: newest.id, read: true });
        expect(read.readAt).not.toBeNull();
        // Marking read again keeps the first read time.
        const again = dataOf<NotificationView>(
          await r
            .patch(user, `${INBOX}/${newest.id}`, { read: true })
            .expect(200),
        );
        expect(again.readAt).toBe(read.readAt);
        await r
          .patch(user, `${INBOX}/${second.id}`, { read: true })
          .expect(200);
        expect(
          dataOf<{ unreadCount: number }>(
            await r.get(user, `${INBOX}/unread-count`).expect(200),
          ),
        ).toEqual({ unreadCount: 2 });
        expect((await inbox(user, '?status=unread')).items).toHaveLength(2);
        expect(
          (await inbox(user, '?status=read')).items.map((n) => n.id).sort(),
        ).toEqual([newest.id, second.id].sort());

        const unread = dataOf<NotificationView>(
          await r
            .patch(user, `${INBOX}/${second.id}`, { read: false })
            .expect(200),
        );
        expect(unread).toMatchObject({ read: false, readAt: null });

        for (const body of [
          {},
          { read: 'yes' },
          { read: null },
          { read: true, x: 1 },
        ]) {
          await r.patch(user, `${INBOX}/${newest.id}`, body).expect(400);
        }

        expect(
          dataOf<{ updated: number }>(
            await r.post(user, `${INBOX}/read-all`).expect(200),
          ),
        ).toEqual({ updated: 3 });
        expect(
          dataOf<{ unreadCount: number }>(
            await r.get(user, `${INBOX}/unread-count`).expect(200),
          ),
        ).toEqual({ unreadCount: 0 });
        expect(
          dataOf<{ updated: number }>(
            await r.post(user, `${INBOX}/read-all`).expect(200),
          ),
        ).toEqual({ updated: 0 });
      });

      it('never shows or changes another user’s notifications', async () => {
        const owner = await createAccount(app.ctx);
        const stranger = await createAccount(app.ctx);
        const adminViewer = await createAccount(app.ctx, userRole.ADMIN);
        await seed(owner, 2);
        const [target] = (await inbox(owner)).items;

        expect((await inbox(stranger)).items).toEqual([]);
        expect((await inbox(adminViewer)).items).toEqual([]);
        const missing = await r
          .patch(stranger, `${INBOX}/${target.id}`, { read: true })
          .expect(404);
        expect(messageOf(missing)).toBe('Notification not found');
        await r
          .patch(adminViewer, `${INBOX}/${target.id}`, { read: true })
          .expect(404);
        await r.post(stranger, `${INBOX}/read-all`).expect(200);
        await r
          .http()
          .patch(`${INBOX}/${target.id}`)
          .send({ read: true })
          .expect(401);

        const page = await inbox(owner);
        expect(page.unreadCount).toBe(2);
        expect(page.items.every((n) => !n.read)).toBe(true);
        // The notification cannot be rewritten in the database either.
        await expect(
          app.ctx.client.notification.update({
            where: { id: target.id },
            data: { title: 'Changed' },
          }),
        ).rejects.toThrow('A notification cannot be changed');
      });
    });

    describe('email preferences', () => {
      it('keeps referral emails on by default and follows the user’s choice; the inbox entry is always created', async () => {
        const { referrer, friend } = await referred();
        expect(
          dataOf<PreferencesView>(
            await r.get(referrer, `${INBOX}/preferences`).expect(200),
          ),
        ).toEqual({
          email: {
            referralRewards: true,
            referralMilestones: true,
            gifts: true,
            security: true,
          },
          updatedAt: null,
        });
        const updated = dataOf<PreferencesView>(
          await r
            .patch(referrer, `${INBOX}/preferences`, {
              referralRewards: false,
            })
            .expect(200),
        );
        expect(updated.email).toEqual({
          referralRewards: false,
          referralMilestones: true,
          gifts: true,
          security: true,
        });
        await r.milestones(admin).ensure(1, 10);
        await r.buyPro(friend, undefined, { cardFingerprint: newCard() });
        await deliverEmails();

        expect((await inbox(referrer)).items.map((n) => n.type).sort()).toEqual(
          ['REFERRAL_MILESTONE_REACHED', 'REFERRAL_REWARD_EARNED'],
        );
        expect(
          r.notificationEmailsTo(referrer.email).map((e) => e.subject),
        ).toEqual(['Milestone reached: 1 paid referral']);
        // Persisted.
        expect(
          dataOf<PreferencesView>(
            await r.get(referrer, `${INBOX}/preferences`).expect(200),
          ).email.referralRewards,
        ).toBe(false);
      });

      it('refuses to turn security emails off, and always emails security events', async () => {
        const user = await r.signUp({ prefix: 'sec' });
        const refused = await r
          .patch(user, `${INBOX}/preferences`, {
            referralRewards: false,
            security: false,
          })
          .expect(400);
        expect(JSON.stringify(refused.body)).toContain(
          'Security emails cannot be turned off',
        );
        // Nothing of the refused request was stored.
        await expect(
          app.ctx.client.notificationPreference.findUnique({
            where: { authId: user.id },
          }),
        ).resolves.toBeNull();
        for (const body of [
          { referralRewards: 'no' },
          { referralMilestones: null },
          { sms: true },
        ]) {
          await r.patch(user, `${INBOX}/preferences`, body).expect(400);
        }
        await r
          .patch(user, `${INBOX}/preferences`, {
            referralRewards: false,
            referralMilestones: false,
            security: true,
          })
          .expect(200);

        await r.post(user, '/auth/logout-all').expect(201);
        await deliverEmails();
        const notifications = await r.notificationsOf(user.id);
        expect(notifications).toMatchObject([
          {
            type: 'SECURITY_SIGNED_OUT_EVERYWHERE',
            title: 'You were signed out on all devices',
            emailStatus: 'SENT',
          },
        ]);
        expect(
          r.notificationEmailsTo(user.email).map((e) => e.subject),
        ).toEqual(['You were signed out on all devices']);
      });
    });

    describe('restarts', () => {
      const previous = process.env.NOTIFICATION_OUTBOX_ENABLED;
      afterEach(() => {
        if (previous === undefined) {
          delete process.env.NOTIFICATION_OUTBOX_ENABLED;
        } else {
          process.env.NOTIFICATION_OUTBOX_ENABLED = previous;
        }
      });

      it('emails notifications created before a restart, or whose sending was interrupted, once', async () => {
        const schema = await createSchema();
        await applyMigrations(schema, migrationNames());
        let first: ReferralApp | undefined;
        let second: ReferralApp | undefined;
        let third: ReferralApp | undefined;
        try {
          // Before the restart: the reward is notified, the email not sent.
          first = await bootReferralApp(schema);
          const before = referralFlows(first);
          const firstAdmin = await before.admin();
          await before.setDiscountSettings(firstAdmin, {
            firstPurchaseDiscountPercent: 0,
            referralDiscountPercent: 0,
            referrerRewardCredits: 100,
          });
          const referrer = await before.signUp({ prefix: 'ref' });
          const friend = await before.signUp({
            prefix: 'fr',
            referralCode: await before.codeOf(referrer),
          });
          const other = await before.signUp({ prefix: 'oth' });
          const stripeApi = first.stripe.api;
          const purchase = await before.buyPro(friend);
          await before.post(other, '/auth/logout-all').expect(201);
          // This one's email was being sent when the process stopped.
          const interrupted =
            await first.ctx.client.notification.findFirstOrThrow({
              where: { authId: other.id },
            });
          await first.ctx.client.notification.update({
            where: { id: interrupted.id },
            data: {
              emailStatus: 'SENDING',
              emailAttempts: 1,
              emailClaimedAt: new Date(Date.now() - 11 * 60_000),
            },
          });
          expect(before.notificationEmailsTo(referrer.email)).toEqual([]);
          await first.ctx.close();
          first = undefined;

          // After the restart, the outbox sends both, once.
          process.env.NOTIFICATION_OUTBOX_ENABLED = 'true';
          second = await bootReferralApp(schema);
          const after = referralFlows(second);
          await eventually(
            async () =>
              (await second!.ctx.client.notification.count({
                where: { emailStatus: 'SENT' },
              })) === 2,
            30_000,
            'the emails after the restart',
          );
          expect(
            after.notificationEmailsTo(referrer.email).map((e) => e.subject),
          ).toEqual(['You earned 100 referral credits']);
          expect(
            after.notificationEmailsTo(other.email).map((e) => e.subject),
          ).toEqual(['You were signed out on all devices']);
          // Stripe delivers the purchase's webhooks again after the
          // restart: no second notification or email.
          second.stripe.api = stripeApi;
          await after
            .sessionEvent('checkout.session.completed', purchase.sessionId)
            .expect(200);
          await after
            .invoiceEvent('invoice.paid', purchase.invoiceId)
            .expect(200);
          await second.ctx
            .get<NotificationOutboxService>(NotificationOutboxService)
            .dispatchPending();
          expect(after.notificationEmailsTo(referrer.email)).toHaveLength(1);
          await second.ctx.close();
          second = undefined;

          // Another restart sends nothing again.
          third = await bootReferralApp(schema);
          await third.ctx
            .get<NotificationOutboxService>(NotificationOutboxService)
            .dispatchPending();
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          expect(
            third.ctx.emails.sent.filter((e) => e.kind === 'notification'),
          ).toEqual([]);
          await expect(
            third.ctx.client.notification.count({
              where: { authId: { in: [referrer.id, other.id] } },
            }),
          ).resolves.toBe(2);
        } finally {
          await first?.ctx.close();
          await second?.ctx.close();
          await third?.ctx.close();
          await dropSchema(schema);
        }
      });
    });
  },
);
