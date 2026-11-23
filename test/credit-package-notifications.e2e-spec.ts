// Must be first: PostgreSQL-only infrastructure (no Redis), mock AI and local
// storage, set before any application module reads the environment.
import './support/env-postgres-mode';
import { CreditPackageSettingsService } from '../src/credit-packages/credit-package-settings.service';
import { CreditFulfillmentWorker } from '../src/credit-packages/fulfillment/credit-fulfillment.worker';
import { EmailQueueService } from '../src/common/queues/email/email.queue';
import { EmailOutboxService } from '../src/notifications/delivery/email-outbox.service';
import { creditPackageFlows } from './support/credit-package-flows';
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
import { MockSmtpTransport } from './support/mock-smtp';
import {
  bootReferralApp,
  dataOf,
  messageOf,
  type ReferralApp,
  type SignedUp,
} from './support/referral-flows';

jest.setTimeout(300_000);

const INBOX = '/v1/notifications';
const GIFTS = '/v1/credit-package-gifts';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface NotificationView {
  id: string;
  type: string;
  title: string;
  read: boolean;
}
interface PageView {
  items: NotificationView[];
  nextCursor: string | null;
  unreadCount: number;
}

/**
 * Notifications and email delivery through the complete application, the
 * real EmailService and templates, the PostgreSQL job queue and a mock SMTP
 * server (nothing is sent): purchase, gift, referral, account and security
 * emails with their delivery history, SMTP failures, retries and recovery,
 * and in-app notifications that are never duplicated.
 */
describeWithDatabase(
  'Credit package notifications and email delivery (PostgreSQL, mock SMTP)',
  () => {
    let schema: string;
    let app: ReferralApp;
    let p: ReturnType<typeof creditPackageFlows>;
    let admin: TestAccount;
    let smtp: MockSmtpTransport;
    let stripeApi: FakeStripeApi;

    const outbox = (target: ReferralApp = app) =>
      target.ctx.get<EmailOutboxService>(EmailOutboxService);
    const worker = () =>
      app.ctx.get<CreditFulfillmentWorker>(CreditFulfillmentWorker);
    const historyOf = (authId: string) =>
      app.ctx.client.emailHistory.findMany({
        where: { authId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    const typesOf = async (account: TestAccount) =>
      (await p.notificationsOf(account.id)).map((n) => n.type).sort();
    const subjectsTo = (email: string) =>
      smtp.to(email).map((message) => message.subject);
    const ACCOUNT_SUBJECTS = new Set([
      'Verify your MuseCue email address',
      'Welcome to MuseCue!',
      'Confirm the deletion of your MuseCue account',
    ]);
    /** Delivered notification emails (not the account emails). */
    const notificationSubjectsTo = (email: string) =>
      subjectsTo(email).filter((subject) => !ACCOUNT_SUBJECTS.has(subject));
    /**
     * Dispatches every due email and waits until none is pending or being
     * sent (failed ones wait for their next attempt).
     */
    const deliverEmails = async (now: Date = new Date()) => {
      await outbox().dispatchPending(now);
      await eventually(
        async () =>
          (await app.ctx.client.emailHistory.count({
            where: {
              OR: [
                {
                  emailStatus: { in: ['pending', 'failed'] },
                  retry_count: { lt: 8 },
                  nextAttemptAt: { lte: now },
                },
                { claimedAt: { not: null } },
              ],
            },
          })) === 0,
        60_000,
        'emails to be delivered',
      );
    };
    const boot = async () => {
      const next = await bootReferralApp(schema, { smtp });
      next.stripe.api = stripeApi;
      return next;
    };

    beforeAll(async () => {
      schema = await createSchema();
      await applyMigrations(schema, migrationNames());
      smtp = new MockSmtpTransport();
      stripeApi = new FakeStripeApi(5);
      app = await boot();
      p = creditPackageFlows(app);
      admin = await p.admin();
    });

    beforeEach(async () => {
      smtp.reset();
      await p.setDiscountSettings(admin, {
        firstPurchaseDiscountPercent: 0,
        referralDiscountPercent: 0,
        referrerRewardCredits: 0,
      });
      await app.ctx.client.creditPackage.deleteMany();
      await app.ctx
        .get<CreditPackageSettingsService>(CreditPackageSettingsService)
        .ensureDefaults();
    });

    afterAll(async () => {
      await app?.ctx.close();
      if (schema) await dropSchema(schema);
    });

    describe('account emails and their delivery history', () => {
      it('records and delivers verification, welcome and account deletion emails once, with sentAt after SMTP accepted them', async () => {
        const started = new Date();
        const user = await p.signUp({ prefix: 'acct' });
        await p
          .post(user, '/v1/privacy/account-deletion/confirmation-code')
          .expect(202);
        await eventually(
          async () =>
            (await historyOf(user.id)).filter((e) => e.emailStatus === 'sent')
              .length === 3,
          30_000,
          'three account emails',
        );
        const history = await historyOf(user.id);
        expect(
          history.map((e) => [e.emailType, e.emailStatus, e.retry_count]),
        ).toEqual([
          ['verification', 'sent', 0],
          ['welcome', 'sent', 0],
          ['account_deletion', 'sent', 0],
        ]);
        for (const email of history) {
          expect(email.sentAt!.getTime()).toBeGreaterThanOrEqual(
            started.getTime(),
          );
          expect(email.sentAt!.getTime()).toBeGreaterThanOrEqual(
            email.lastAttemptAt!.getTime(),
          );
          // Secrets (codes) are never kept once sent.
          expect(email.payload).toBeNull();
          expect(email.claimedAt).toBeNull();
        }
        expect(subjectsTo(user.email)).toEqual([
          'Verify your MuseCue email address',
          'Welcome to MuseCue!',
          'Confirm the deletion of your MuseCue account',
        ]);
        // Verifying again (or logging in) sends no second welcome email.
        await p
          .http()
          .post('/auth/verify-email')
          .send({ email: user.email, code: 'AAAAAA' });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(
          (await historyOf(user.id)).filter((e) => e.emailType === 'welcome'),
        ).toHaveLength(1);
      });

      it('retries failed SMTP deliveries; the failed record becomes sent, with its failures, once delivered', async () => {
        const identity = p.newIdentity('retry');
        // The first two attempts of every email to this address fail.
        smtp.failFor(identity.email, 2);
        await p
          .register({
            username: identity.username,
            email: identity.email,
            password: identity.password,
          })
          .expect(201);
        const user = await app.ctx.client.authUser.findUniqueOrThrow({
          where: { email: identity.email },
        });

        // While it fails, it stays failed (no sentAt) with the error.
        const failed = await eventually(
          async () => {
            const [email] = await historyOf(user.id);
            return email?.emailStatus === 'failed' && email.claimedAt === null
              ? email
              : null;
          },
          30_000,
          'the failed verification email',
        );
        expect(failed).toMatchObject({
          emailType: 'verification',
          sentAt: null,
        });
        expect(failed.errorMessage).toMatch(/^smtp:421/);

        // The job's retries deliver it: the same record becomes sent.
        const sent = await eventually(
          async () => {
            const [email] = await historyOf(user.id);
            return email?.emailStatus === 'sent' ? email : null;
          },
          30_000,
          'the retried verification email',
        );
        expect(sent).toMatchObject({
          id: failed.id,
          retry_count: 2,
          payload: null,
        });
        expect(sent.sentAt).not.toBeNull();
        expect(sent.errorMessage).toMatch(/^smtp:421/);
        expect(await historyOf(user.id)).toHaveLength(1);
        expect(subjectsTo(identity.email)).toEqual([
          'Verify your MuseCue email address',
        ]);
        expect(
          smtp.attempts.filter((a) => a.to === identity.email).map((a) => a.ok),
        ).toEqual([false, false, true]);
      });

      it('retries welcome emails too, through the outbox after the job’s attempts, and gives up only after the last attempt', async () => {
        const user = await p.signUp({ prefix: 'welc' });
        // The welcome email was already sent; a second account has an outage.
        const identity = p.newIdentity('outage');
        await p
          .register({
            username: identity.username,
            email: identity.email,
            password: identity.password,
          })
          .expect(201);
        const code = await eventually(
          () =>
            Promise.resolve(
              app.ctx.emails.sent.find(
                (e) => e.kind === 'verification' && e.to === identity.email,
              )?.code,
            ),
          30_000,
          'the verification code',
        );
        smtp.failFor(identity.email);
        await p
          .http()
          .post('/auth/verify-email')
          .send({ email: identity.email, code })
          .expect(201);
        const account = await app.ctx.client.authUser.findUniqueOrThrow({
          where: { email: identity.email },
        });
        // The job's three attempts fail.
        const welcome = await eventually(
          async () => {
            const email = (await historyOf(account.id)).find(
              (e) => e.emailType === 'welcome',
            );
            return email?.retry_count === 3 && email.claimedAt === null
              ? email
              : null;
          },
          60_000,
          'three failed welcome attempts',
        );
        expect(welcome).toMatchObject({ emailStatus: 'failed', sentAt: null });
        expect(welcome.nextAttemptAt).not.toBeNull();

        // SMTP recovers; the outbox delivers it at its next attempt.
        smtp.reset();
        await deliverEmails(new Date(Date.now() + HOUR));
        const delivered = (await historyOf(account.id)).find(
          (e) => e.emailType === 'welcome',
        )!;
        expect(delivered).toMatchObject({
          id: welcome.id,
          emailStatus: 'sent',
          retry_count: 3,
        });
        expect(subjectsTo(identity.email)).toContain('Welcome to MuseCue!');
        expect(
          subjectsTo(identity.email).filter((s) => s === 'Welcome to MuseCue!'),
        ).toHaveLength(1);
        expect(subjectsTo(user.email)).toContain('Welcome to MuseCue!');

        // An email that never gets through is given up after 8 attempts and
        // stays failed.
        smtp.failFor(identity.email);
        await p.post(account as TestAccount, '/auth/logout-all').expect(201);
        let now = Date.now();
        for (let round = 0; round < 4; round += 1) {
          now += DAY;
          await outbox().dispatchPending(new Date(now));
          await eventually(
            async () =>
              (await app.ctx.client.emailHistory.count({
                where: { authId: account.id, claimedAt: { not: null } },
              })) === 0,
            30_000,
            'the attempt to finish',
          );
          await new Promise((resolve) => setTimeout(resolve, 10_000));
        }
        const security = (await historyOf(account.id)).find(
          (e) => e.emailType === 'security',
        )!;
        expect(security).toMatchObject({
          emailStatus: 'failed',
          retry_count: 8,
          nextAttemptAt: null,
          sentAt: null,
        });
        smtp.reset();
        await outbox().dispatchPending(new Date(now + DAY));
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(
          (await historyOf(account.id)).find((e) => e.emailType === 'security'),
        ).toMatchObject({ emailStatus: 'failed', retry_count: 8 });
      });
    });

    describe('purchase notifications', () => {
      it('notifies the buyer once, in the inbox and by email, when the credits are granted; a failed payment is notified too', async () => {
        const buyer = await p.signUp({ prefix: 'buyer' });
        const bystander = await p.signUp({ prefix: 'byst' });
        const order = await p.orderPackage(buyer, 'MEDIUM');
        const sessionId = await p.payOrder(order.id);
        // Nothing before the credits are granted.
        expect(await typesOf(buyer)).toEqual([]);
        await Promise.all([
          p.sessionEvent('checkout.session.completed', sessionId),
          p.sessionEvent('checkout.session.completed', sessionId),
          p.sessionEvent('checkout.session.async_payment_succeeded', sessionId),
        ]);
        await p
          .sessionEvent('checkout.session.completed', sessionId)
          .expect(200);
        expect(await typesOf(buyer)).toEqual(['CREDIT_PURCHASE_COMPLETED']);

        // A delayed payment that fails.
        const failing = await p.orderPackage(buyer, 'SMALL');
        const failingSession = await p.payOrder(failing.id, {
          paymentStatus: 'unpaid',
        });
        await p
          .sessionEvent('checkout.session.completed', failingSession)
          .expect(200);
        stripeApi.failDelayedPayment(failingSession);
        await Promise.all([
          p.sessionEvent(
            'checkout.session.async_payment_failed',
            failingSession,
          ),
          p.sessionEvent(
            'checkout.session.async_payment_failed',
            failingSession,
          ),
        ]);
        expect(await typesOf(buyer)).toEqual([
          'CREDIT_PURCHASE_COMPLETED',
          'CREDIT_PURCHASE_FAILED',
        ]);

        await deliverEmails();
        expect(notificationSubjectsTo(buyer.email).sort()).toEqual([
          'Your 500 credits are ready',
          'Your payment did not go through',
        ]);
        const purchaseEmails = (await historyOf(buyer.id)).filter(
          (e) => e.emailType === 'purchase',
        );
        expect(
          purchaseEmails.map((e) => [e.emailStatus, e.sentAt !== null]),
        ).toEqual([
          ['sent', true],
          ['sent', true],
        ]);
        // Only the buyer.
        expect(await typesOf(bystander)).toEqual([]);
        expect(
          (await historyOf(bystander.id)).filter(
            (e) => e.emailType === 'purchase',
          ),
        ).toEqual([]);
      });

      it('follows the purchase email preference; the inbox entry is always created', async () => {
        const buyer = await p.signUp({ prefix: 'pref' });
        await p
          .patch(buyer, `${INBOX}/preferences`, { purchases: false })
          .expect(200);
        await p.buyPackage(buyer, 'SMALL');
        await deliverEmails();
        expect(await typesOf(buyer)).toEqual(['CREDIT_PURCHASE_COMPLETED']);
        expect(
          (await historyOf(buyer.id)).filter((e) => e.emailType === 'purchase'),
        ).toEqual([]);
        expect(subjectsTo(buyer.email)).not.toContain(
          'Your 250 credits are ready',
        );
      });
    });

    describe('gift notifications', () => {
      it('notifies the right user at each step of a gift, by inbox and email, once', async () => {
        const sender = await p.signUp({ prefix: 'gsnd' });
        const recipient = await p.signUp({ prefix: 'grcp' });
        const stranger = await p.signUp({ prefix: 'gstr' });
        const deliverAt = new Date(Date.now() + 2 * HOUR);
        const gift = await p.sendGift(sender, recipient.email, {
          deliverAt: deliverAt.toISOString(),
        });
        expect(await typesOf(recipient)).toEqual(['GIFT_RECEIVED']);
        await p.post(recipient, `${GIFTS}/${gift.id}/accept`).expect(200);
        await p.post(recipient, `${GIFTS}/${gift.id}/accept`).expect(409);
        expect(await typesOf(sender)).toEqual(['GIFT_ACCEPTED']);
        await p.payGift(sender, gift.id);
        expect(await typesOf(sender)).toEqual(['GIFT_ACCEPTED', 'GIFT_PAID']);
        // Not delivered yet: no delivery notification.
        expect(await typesOf(recipient)).toEqual(['GIFT_RECEIVED']);

        const later = new Date(deliverAt.getTime() + 60_000);
        await Promise.all([worker().runOnce(later), worker().runOnce(later)]);
        expect(await typesOf(recipient)).toEqual([
          'GIFT_DELIVERED',
          'GIFT_RECEIVED',
        ]);
        expect(await typesOf(sender)).toEqual([
          'GIFT_ACCEPTED',
          'GIFT_DELIVERED',
          'GIFT_PAID',
        ]);
        expect(await typesOf(stranger)).toEqual([]);

        await deliverEmails();
        expect(notificationSubjectsTo(recipient.email).sort()).toEqual(
          [
            `${sender.email.split('@')[0]} wants to give you 250 credits`,
            'You received 250 gift credits',
          ].sort(),
        );
        expect(notificationSubjectsTo(sender.email).sort()).toEqual(
          [
            `${recipient.email.split('@')[0]} accepted your gift`,
            `Your gift to ${recipient.email.split('@')[0]} is paid`,
            `Your gift to ${recipient.email.split('@')[0]} was delivered`,
          ].sort(),
        );
        const giftEmails = [
          ...(await historyOf(sender.id)),
          ...(await historyOf(recipient.id)),
        ].filter((e) => e.emailType === 'gift');
        expect(giftEmails).toHaveLength(5);
        expect(giftEmails.every((e) => e.emailStatus === 'sent')).toBe(true);
      });

      it('notifies declined, canceled, expired, reviewed and rejected gifts', async () => {
        const sender = await p.signUp({ prefix: 'gs2' });
        const recipient = await p.signUp({ prefix: 'gr2' });

        const declined = await p.sendGift(sender, recipient.email);
        await p.post(recipient, `${GIFTS}/${declined.id}/decline`).expect(200);
        const canceled = await p.sendGift(sender, recipient.email);
        await p.post(sender, `${GIFTS}/${canceled.id}/cancel`).expect(200);
        await p.sendGift(sender, recipient.email);
        await worker().runOnce(new Date(Date.now() + 8 * DAY));

        const reviewed = await p.sendGift(sender, recipient.email);
        await p.post(recipient, `${GIFTS}/${reviewed.id}/accept`).expect(200);
        await app.ctx.client.authUser.update({
          where: { id: recipient.id },
          data: { verified: false },
        });
        const { order } = await p.payGift(sender, reviewed.id);
        const fulfillment = await p.fulfillmentOf(order.id);
        await p
          .post(admin, `/v1/admin/credit-fulfillments/${fulfillment.id}/reject`)
          .expect(200);

        expect(await typesOf(sender)).toEqual([
          'GIFT_ACCEPTED',
          'GIFT_DECLINED',
          'GIFT_EXPIRED',
          'GIFT_PAID',
          'GIFT_REJECTED',
          'GIFT_UNDER_REVIEW',
        ]);
        expect(await typesOf(recipient)).toEqual([
          'GIFT_CANCELED',
          'GIFT_RECEIVED',
          'GIFT_RECEIVED',
          'GIFT_RECEIVED',
          'GIFT_RECEIVED',
        ]);
        // Nothing was delivered.
        expect(await p.giftCredits(recipient.id)).toEqual([]);
      });
    });

    describe('referral notifications', () => {
      it('notifies a referral reward only when credits are granted', async () => {
        await p.setDiscountSettings(admin, {
          firstPurchaseDiscountPercent: 0,
          referralDiscountPercent: 0,
          referrerRewardCredits: 30,
        });
        const referrer = await p.signUp({ prefix: 'rref' });
        const code = await p.codeOf(referrer);
        // Held (shared card): no notification.
        const held: SignedUp = await p.signUp({
          prefix: 'rheld',
          referralCode: code,
        });
        await p.buyPro(referrer, undefined, {
          cardFingerprint: 'card_shared_n',
        });
        await p.buyPackage(held, 'SMALL', { cardFingerprint: 'card_shared_n' });
        await expect(p.referralOf(held.id)).resolves.toMatchObject({
          status: 'HELD',
        });
        expect(await typesOf(referrer)).toEqual([]);
        // No reward due: qualified, no notification.
        await p.setDiscountSettings(admin, {
          firstPurchaseDiscountPercent: 0,
          referralDiscountPercent: 0,
          referrerRewardCredits: 0,
        });
        const unrewarded = await p.signUp({
          prefix: 'rnone',
          referralCode: code,
        });
        await p.buyPackage(unrewarded, 'SMALL', { cardFingerprint: 'card_n2' });
        await expect(p.referralOf(unrewarded.id)).resolves.toMatchObject({
          status: 'QUALIFIED',
        });
        expect(await typesOf(referrer)).toEqual([]);
        // Rewarded: one notification with the credits, emailed once.
        await p.setDiscountSettings(admin, {
          firstPurchaseDiscountPercent: 0,
          referralDiscountPercent: 0,
          referrerRewardCredits: 30,
        });
        const rewarded = await p.signUp({ prefix: 'rok', referralCode: code });
        const { sessionId } = await p.buyPackage(rewarded, 'SMALL', {
          cardFingerprint: 'card_n3',
        });
        await p
          .sessionEvent('checkout.session.completed', sessionId!)
          .expect(200);
        expect(await typesOf(referrer)).toEqual(['REFERRAL_REWARD_EARNED']);
        // Approving the held referral grants its credits and notifies.
        const review = await p
          .post(
            admin,
            `/v1/admin/referrals/${(await p.referralOf(held.id))!.id}/approve`,
          )
          .expect(200);
        expect(dataOf<{ status: string }>(review).status).toBe('REWARDED');
        expect(
          (await typesOf(referrer)).filter(
            (t) => t === 'REFERRAL_REWARD_EARNED',
          ),
        ).toHaveLength(2);
        await deliverEmails();
        const referralEmails = (await historyOf(referrer.id)).filter(
          (e) => e.emailType === 'referral',
        );
        expect(referralEmails).toHaveLength(2);
        expect(referralEmails.every((e) => e.emailStatus === 'sent')).toBe(
          true,
        );
      });
    });

    describe('durability', () => {
      it('delivers emails recorded before a restart once, with duplicate outboxes and repeated jobs', async () => {
        const user = await p.signUp({ prefix: 'dur' });
        await eventually(
          async () =>
            (await historyOf(user.id)).some(
              (e) => e.emailType === 'welcome' && e.emailStatus === 'sent',
            ),
          30_000,
          'the welcome email',
        );
        smtp.failFor(user.email);
        await p.buyPackage(user, 'SMALL');
        await p.post(user, '/auth/logout-all').expect(201);
        await outbox().dispatchPending();
        await eventually(
          async () =>
            (await historyOf(user.id)).filter(
              (e) =>
                e.emailStatus === 'failed' &&
                e.retry_count === 3 &&
                !e.claimedAt,
            ).length === 2,
          60_000,
          'the failed emails',
        );
        await app.ctx.close();

        // Two instances restart together; SMTP is back.
        smtp.reset();
        const [first, second] = await Promise.all([boot(), boot()]);
        try {
          app = first;
          p = creditPackageFlows(app);
          const later = new Date(Date.now() + HOUR);
          await Promise.all([
            outbox(first).dispatchPending(later),
            outbox(second).dispatchPending(later),
            outbox(first).dispatchPending(later),
          ]);
          // Repeated jobs for the same emails change nothing either.
          const queue = first.ctx.get<EmailQueueService>(EmailQueueService);
          for (const email of await historyOf(user.id)) {
            await queue.sendEmail(email.id, user.id, 'manual-repeat');
          }
          await eventually(
            async () =>
              (await historyOf(user.id)).every((e) => e.emailStatus === 'sent'),
            60_000,
            'every email after the restart',
          );
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          expect(notificationSubjectsTo(user.email).sort()).toEqual([
            'You were signed out on all devices',
            'Your 250 credits are ready',
          ]);
          expect(await typesOf(user)).toEqual([
            'CREDIT_PURCHASE_COMPLETED',
            'SECURITY_SIGNED_OUT_EVERYWHERE',
          ]);
        } finally {
          await second.ctx.close();
        }
      });

      it('has PostgreSQL refuse rewriting the delivery history', async () => {
        const user = await p.signUp({ prefix: 'hist' });
        const [sent] = await historyOf(user.id);
        await expect(
          app.ctx.client.emailHistory.update({
            where: { id: sent.id },
            data: { emailStatus: 'failed', sentAt: null },
          }),
        ).rejects.toThrow();
        await expect(
          app.ctx.client.emailHistory.update({
            where: { id: sent.id },
            data: { sentAt: new Date(0) },
          }),
        ).rejects.toThrow('cannot be rewritten');
        await expect(
          app.ctx.client.emailHistory.create({
            data: {
              authId: user.id,
              emailTo: user.email,
              emailType: 'welcome',
              subject: 'x',
              messageId: `welcome:${user.id}`,
              emailStatus: 'pending',
            },
          }),
        ).rejects.toThrow();
      });
    });

    describe('inbox and preferences', () => {
      it('shows each user only their own paginated inbox, with read state and email preferences; security emails cannot be turned off', async () => {
        const owner = await p.signUp({ prefix: 'inb' });
        const other = await createAccount(app.ctx);
        for (let i = 0; i < 3; i += 1) await p.buyPackage(owner, 'SMALL');
        const first = dataOf<PageView>(
          await p.get(owner, `${INBOX}?limit=2`).expect(200),
        );
        expect(first.items).toHaveLength(2);
        expect(first.unreadCount).toBe(3);
        const rest = dataOf<PageView>(
          await p
            .get(owner, `${INBOX}?limit=2&cursor=${first.nextCursor}`)
            .expect(200),
        );
        expect(rest.items).toHaveLength(1);
        expect(rest.nextCursor).toBeNull();

        const target = first.items[0];
        await p
          .patch(owner, `${INBOX}/${target.id}`, { read: true })
          .expect(200);
        expect(
          dataOf<{ unreadCount: number }>(
            await p.get(owner, `${INBOX}/unread-count`).expect(200),
          ).unreadCount,
        ).toBe(2);
        await p
          .patch(owner, `${INBOX}/${target.id}`, { read: false })
          .expect(200);
        await p.post(owner, `${INBOX}/read-all`).expect(200);
        expect(
          dataOf<PageView>(
            await p.get(owner, `${INBOX}?status=unread`).expect(200),
          ).items,
        ).toEqual([]);

        // Another user sees and changes nothing of it.
        expect(
          dataOf<PageView>(await p.get(other, INBOX).expect(200)).items,
        ).toEqual([]);
        await p
          .patch(other, `${INBOX}/${target.id}`, { read: false })
          .expect(404);
        await p.http().get(INBOX).expect(401);

        // Preferences: purchases and gifts can be turned off, security not.
        const prefs = await p
          .patch(owner, `${INBOX}/preferences`, {
            purchases: false,
            gifts: false,
            referralRewards: false,
            referralMilestones: false,
          })
          .expect(200);
        expect(dataOf<{ email: Record<string, boolean> }>(prefs).email).toEqual(
          {
            referralRewards: false,
            referralMilestones: false,
            gifts: false,
            purchases: false,
            security: true,
          },
        );
        expect(
          JSON.stringify(
            (
              await p
                .patch(owner, `${INBOX}/preferences`, { security: false })
                .expect(400)
            ).body,
          ),
        ).toContain('Security emails cannot be turned off');
        expect(
          messageOf(
            await p
              .patch(owner, `${INBOX}/preferences`, { purchases: 'no' })
              .expect(400),
          ),
        ).toBeDefined();
        // Security emails are sent whatever the preferences.
        await p.post(owner, '/auth/logout-all').expect(201);
        await deliverEmails();
        expect(subjectsTo(owner.email)).toContain(
          'You were signed out on all devices',
        );
      });
    });
  },
);
