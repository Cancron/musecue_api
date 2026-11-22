// Must be first: PostgreSQL-only infrastructure (no Redis), mock AI and local
// storage, set before any application module reads the environment.
import './support/env-postgres-mode';
import { userRole } from '@prisma/client';
import { expectConsistentLedger } from './support/credit-fixtures';
import { createAccount, type TestAccount } from './support/discount-fixtures';
import { FakeStripeApi } from './support/fake-stripe-api';
import { describeWithDatabase } from './support/migrated-schema';
import {
  bootReferralApp,
  dataOf,
  messageOf,
  type MilestoneView,
  referralFlows,
  type ReferralApp,
  type SignedUp,
} from './support/referral-flows';

jest.setTimeout(300_000);

interface ReviewView {
  id: string;
  status: string;
  holdReason: string | null;
  rewardCredits: number | null;
  referrer: { id: string } | null;
  referred: { id: string };
  reviewedBy: string | null;
}

interface OverviewView {
  referrals: { rewarded: number; underReview: number; rejected: number };
  milestones: {
    paidReferrals: number;
    reached: Array<{ referralCount: number; rewardCredits: number }>;
    next: { referralCount: number; remaining: number } | null;
  };
  totalEarnedCredits: string;
}

/**
 * Referral milestones and the review of suspicious referrals, through the
 * complete application and the Stripe flow:
 * - administrators configure milestones (paid referrals -> bonus credits);
 *   a referrer receives each one once, however payments arrive;
 * - a referral whose payment method is shared with the referrer or with
 *   another user the referrer invited is HELD: no credits, no notification,
 *   not counted, until an administrator approves (or rejects) it, once.
 */
describeWithDatabase(
  'Referral milestones and suspicious referral review (PostgreSQL, full stack, Stripe)',
  () => {
    let app: ReferralApp;
    let r: ReturnType<typeof referralFlows>;
    let admin: TestAccount;

    const MILESTONES = '/v1/admin/referral-milestones';
    const REVIEWS = '/v1/admin/referrals';

    let milestone: (
      referralCount: number,
      rewardCredits: number,
    ) => Promise<MilestoneView>;
    let resetMilestones: () => Promise<void>;

    const overviewOf = async (account: TestAccount) =>
      dataOf<OverviewView>(await r.get(account, '/v1/referrals').expect(200));
    /**
     * Referral credits in the order granted (a referral reward before the
     * milestone it completes: both are granted at the same time).
     */
    const creditsOf = async (authId: string) =>
      (await r.rewardAllocations(authId))
        .map((a) => ({
          at: a.grantedAt.getTime(),
          ref: a.sourceReference.split(':')[0],
          amount: a.amount.toFixed(),
        }))
        .sort((a, b) => a.at - b.at || b.ref.localeCompare(a.ref))
        .map(({ ref, amount }) => ({ ref, amount }));
    const milestoneCreditsOf = async (authId: string) =>
      (await creditsOf(authId))
        .filter((c) => c.ref === 'referral-milestone')
        .map((c) => c.amount);

    let cardSeq = 0;
    const newCard = () => `card_fp_${Date.now().toString(36)}_${cardSeq++}`;

    /** A referrer and `count` users who signed up with the referrer's code. */
    const referrerWith = async (count: number) => {
      const referrer = await r.signUp({ prefix: 'ref' });
      const code = await r.codeOf(referrer);
      const friends: SignedUp[] = [];
      for (let i = 0; i < count; i += 1) {
        friends.push(await r.signUp({ prefix: 'fr', referralCode: code }));
      }
      return { referrer, friends };
    };
    /** Buys Pro with a card of its own (nothing shared). */
    const buy = (account: TestAccount, card = newCard()) =>
      r.buyPro(account, undefined, { cardFingerprint: card });

    beforeAll(async () => {
      app = await bootReferralApp();
      r = referralFlows(app);
      admin = await r.admin();
      ({ ensure: milestone, reset: resetMilestones } = r.milestones(admin));
    });

    beforeEach(async () => {
      app.stripe.api = new FakeStripeApi(5);
      await r.setDiscountSettings(admin, {
        firstPurchaseDiscountPercent: 0,
        referralDiscountPercent: 0,
        referrerRewardCredits: 100,
      });
      await resetMilestones();
    });

    afterAll(async () => {
      await app?.ctx.close();
    });

    describe('milestone administration', () => {
      it('lets admins and super admins create, read and change milestones; the threshold never changes', async () => {
        const superAdmin = await createAccount(app.ctx, userRole.SUPERADMIN);
        const created = dataOf<MilestoneView>(
          await r
            .post(superAdmin, MILESTONES, {
              referralCount: 25,
              rewardCredits: 700,
            })
            .expect(201),
        );
        expect(created).toMatchObject({
          referralCount: 25,
          rewardCredits: 700,
          active: true,
          awards: 0,
        });
        await expect(
          r.get(admin, `${MILESTONES}/${created.id}`).expect(200),
        ).resolves.toMatchObject({ body: { data: { id: created.id } } });

        const updated = dataOf<MilestoneView>(
          await r
            .patch(admin, `${MILESTONES}/${created.id}`, {
              rewardCredits: 750,
              active: false,
            })
            .expect(200),
        );
        expect(updated).toMatchObject({
          referralCount: 25,
          rewardCredits: 750,
          active: false,
        });
        // The threshold is not a changeable field.
        await r
          .patch(admin, `${MILESTONES}/${created.id}`, { referralCount: 2 })
          .expect(400);
        await r.patch(admin, `${MILESTONES}/${created.id}`, {}).expect(400);
        await r
          .patch(admin, `${MILESTONES}/00000000-0000-4000-8000-000000000000`, {
            active: true,
          })
          .expect(404);
        // One milestone per threshold.
        const duplicate = await r
          .post(admin, MILESTONES, { referralCount: 25, rewardCredits: 1 })
          .expect(409);
        expect(messageOf(duplicate)).toMatch(/already exists/);

        await expect(
          app.ctx.client.referralMilestone.findUniqueOrThrow({
            where: { id: created.id },
          }),
        ).resolves.toMatchObject({
          referralCount: 25,
          rewardCredits: 750,
          active: false,
        });
        await expect(
          app.ctx.client.referralMilestone.update({
            where: { id: created.id },
            data: { referralCount: 26 },
          }),
        ).rejects.toThrow('The referral count of a milestone cannot change');
      });

      it('rejects invalid milestones without storing anything', async () => {
        const before = await app.ctx.client.referralMilestone.count();
        const invalid: Array<Record<string, unknown>> = [
          {},
          { referralCount: 5 },
          { rewardCredits: 5 },
          { referralCount: 0, rewardCredits: 10 },
          { referralCount: -3, rewardCredits: 10 },
          { referralCount: 2.5, rewardCredits: 10 },
          { referralCount: '7', rewardCredits: 10 },
          { referralCount: 100_001, rewardCredits: 10 },
          { referralCount: 7, rewardCredits: 0 },
          { referralCount: 7, rewardCredits: -10 },
          { referralCount: 7, rewardCredits: 10.5 },
          { referralCount: 7, rewardCredits: 1_000_001 },
          { referralCount: 7, rewardCredits: null },
          { referralCount: 7, rewardCredits: 10, active: 'yes' },
          { referralCount: 7, rewardCredits: 10, extra: true },
        ];
        for (const body of invalid) {
          await r.post(admin, MILESTONES, body).expect(400);
        }
        const existing = await milestone(8, 80);
        for (const body of [
          { rewardCredits: 0 },
          { rewardCredits: 2.5 },
          { rewardCredits: '10' },
          { active: 'false' },
          { active: null },
        ]) {
          await r
            .patch(admin, `${MILESTONES}/${existing.id}`, body)
            .expect(400);
        }
        expect(await app.ctx.client.referralMilestone.count()).toBe(before + 1);
        await expect(
          app.ctx.client.referralMilestone.findUniqueOrThrow({
            where: { id: existing.id },
          }),
        ).resolves.toMatchObject({ rewardCredits: 80, active: true });
      });

      it('keeps milestones and the review queue away from regular users', async () => {
        const user = await r.signUp({ prefix: 'usr' });
        const existing = await milestone(9, 90);
        await r
          .post(user, MILESTONES, { referralCount: 11, rewardCredits: 1 })
          .expect(403);
        await r.get(user, MILESTONES).expect(403);
        await r.get(user, `${MILESTONES}/${existing.id}`).expect(403);
        await r
          .patch(user, `${MILESTONES}/${existing.id}`, { rewardCredits: 1 })
          .expect(403);
        await r.get(user, REVIEWS).expect(403);
        await r
          .post(user, `${REVIEWS}/00000000-0000-4000-8000-000000000000/approve`)
          .expect(403);
        await r
          .post(user, `${REVIEWS}/00000000-0000-4000-8000-000000000000/reject`)
          .expect(403);
        await r.http().get(MILESTONES).expect(401);
        await r.http().get(REVIEWS).expect(401);
        await expect(
          app.ctx.client.referralMilestone.count({
            where: { referralCount: 11 },
          }),
        ).resolves.toBe(0);
        await expect(
          app.ctx.client.referralMilestone.findUniqueOrThrow({
            where: { id: existing.id },
          }),
        ).resolves.toMatchObject({ rewardCredits: 90 });
      });
    });

    describe('milestone awards', () => {
      it('awards each reached milestone once, as non-expiring REFERRAL credits with a notification', async () => {
        await milestone(1, 50);
        await milestone(3, 300);
        const { referrer, friends } = await referrerWith(4);

        await buy(friends[0]);
        expect(await milestoneCreditsOf(referrer.id)).toEqual(['50']);
        await buy(friends[1]);
        expect(await milestoneCreditsOf(referrer.id)).toEqual(['50']);
        const third = await buy(friends[2]);
        expect(await milestoneCreditsOf(referrer.id)).toEqual(['50', '300']);
        await buy(friends[3]);
        // Redelivered webhooks change nothing.
        await r
          .sessionEvent('checkout.session.completed', third.sessionId)
          .expect(200);
        await r.invoiceEvent('invoice.paid', third.invoiceId).expect(200);

        expect(await creditsOf(referrer.id)).toEqual([
          { ref: 'referral-reward', amount: '100' },
          { ref: 'referral-milestone', amount: '50' },
          { ref: 'referral-reward', amount: '100' },
          { ref: 'referral-reward', amount: '100' },
          { ref: 'referral-milestone', amount: '300' },
          { ref: 'referral-reward', amount: '100' },
        ]);
        const allocations = await r.rewardAllocations(referrer.id);
        expect(allocations.every((a) => a.expiresAt === null)).toBe(true);
        await expect(
          app.ctx.client.referralMilestoneAward.findMany({
            where: { authId: referrer.id },
            orderBy: { referralCount: 'asc' },
          }),
        ).resolves.toMatchObject([
          { referralCount: 1, rewardCredits: 50 },
          { referralCount: 3, rewardCredits: 300 },
        ]);
        const notifications = await r.notificationsOf(referrer.id);
        expect(
          notifications.filter((n) => n.type === 'REFERRAL_MILESTONE_REACHED'),
        ).toHaveLength(2);
        expect(
          notifications.filter((n) => n.type === 'REFERRAL_REWARD_EARNED'),
        ).toHaveLength(4);

        const overview = await overviewOf(referrer);
        expect(overview.milestones).toMatchObject({
          paidReferrals: 4,
          reached: [
            { referralCount: 1, rewardCredits: 50 },
            { referralCount: 3, rewardCredits: 300 },
          ],
          next: null,
        });
        expect(overview.totalEarnedCredits).toBe('750');
        const rewards = dataOf<Array<{ kind: string }>>(
          await r.get(referrer, '/v1/referrals/rewards').expect(200),
        );
        expect(rewards.filter((x) => x.kind === 'MILESTONE')).toHaveLength(2);
        // Invited users receive no milestone credits.
        await expect(r.rewardAllocations(friends[0].id)).resolves.toEqual([]);
        await expectConsistentLedger(app.ctx.client, referrer.id);
      });

      it('counts every qualifying referral once when purchases are verified concurrently', async () => {
        await milestone(2, 200);
        await milestone(3, 300);
        const { referrer, friends } = await referrerWith(3);
        const sessions: Array<{ sessionId: string; invoiceId: string }> = [];
        for (const friend of friends) {
          const checkout = await r.checkout(friend);
          const sessionId = await r.payCheckout(checkout.checkoutSessionId, {
            cardFingerprint: newCard(),
          });
          sessions.push({
            sessionId,
            invoiceId: app.stripe.api.sessions.get(sessionId)
              ?.invoice as string,
          });
        }
        // Every webhook of the three purchases, twice, at the same time.
        const responses = await Promise.all(
          sessions.flatMap(({ sessionId, invoiceId }) => [
            r.sessionEvent('checkout.session.completed', sessionId),
            r.invoiceEvent('invoice.paid', invoiceId),
            r.sessionEvent('checkout.session.completed', sessionId),
            r.invoiceEvent('invoice.paid', invoiceId),
          ]),
        );
        expect(new Set(responses.map((res) => res.status))).toEqual(
          new Set([200]),
        );

        expect((await milestoneCreditsOf(referrer.id)).sort()).toEqual([
          '200',
          '300',
        ]);
        expect(
          (await creditsOf(referrer.id)).filter(
            (c) => c.ref === 'referral-reward',
          ),
        ).toHaveLength(3);
        await expect(
          app.ctx.client.referralProgress.findUniqueOrThrow({
            where: { authId: referrer.id },
          }),
        ).resolves.toMatchObject({ paidReferrals: 3 });
        expect(
          (await r.notificationsOf(referrer.id)).filter(
            (n) => n.type === 'REFERRAL_MILESTONE_REACHED',
          ),
        ).toHaveLength(2);
        await expectConsistentLedger(app.ctx.client, referrer.id);
      });

      it('never awards inactive milestones; a milestone switched on later is awarded with the next paid referral', async () => {
        const later = await milestone(2, 220);
        await r
          .patch(admin, `${MILESTONES}/${later.id}`, { active: false })
          .expect(200);
        const { referrer, friends } = await referrerWith(3);
        await buy(friends[0]);
        await buy(friends[1]);
        expect(await milestoneCreditsOf(referrer.id)).toEqual([]);
        expect((await overviewOf(referrer)).milestones).toMatchObject({
          paidReferrals: 2,
          reached: [],
          next: null,
        });

        // Switched on (with a new reward): awarded with the next paid
        // referral, since the referrer had already reached it.
        await r
          .patch(admin, `${MILESTONES}/${later.id}`, {
            active: true,
            rewardCredits: 240,
          })
          .expect(200);
        expect(await milestoneCreditsOf(referrer.id)).toEqual([]);
        await buy(friends[2]);
        expect(await milestoneCreditsOf(referrer.id)).toEqual(['240']);
        expect(
          dataOf<MilestoneView>(
            await r.get(admin, `${MILESTONES}/${later.id}`).expect(200),
          ).awards,
        ).toBeGreaterThanOrEqual(1);
      });

      it('has PostgreSQL refuse milestone awards and credits that were not earned', async () => {
        const target = await milestone(4, 400);
        const { referrer, friends } = await referrerWith(1);
        await buy(friends[0]);
        // One paid referral: the 4-referral milestone is not reached.
        await expect(
          app.ctx.client.referralMilestoneAward.create({
            data: {
              milestoneId: target.id,
              authId: referrer.id,
              referralCount: 4,
              rewardCredits: 400,
              awardedAt: new Date(),
            },
          }),
        ).rejects.toThrow('A milestone is awarded only once it is reached');
        const wallet = await app.ctx.client.creditWallet.findUniqueOrThrow({
          where: { authId: referrer.id },
        });
        await expect(
          app.ctx.client.creditAllocation.create({
            data: {
              walletId: wallet.id,
              authId: referrer.id,
              source: 'REFERRAL',
              sourceReference: `referral-milestone:${target.id}`,
              amount: 400,
              remaining: 400,
              grantedAt: new Date(),
            },
          }),
        ).rejects.toThrow(
          'Milestone credits require a milestone award of the same referrer and amount',
        );
        expect(await milestoneCreditsOf(referrer.id)).toEqual([]);
      });
    });

    describe('suspicious referrals', () => {
      const review = (id: string, decision: 'approve' | 'reject') =>
        r.post(admin, `${REVIEWS}/${id}/${decision}`);
      const queue = async (status?: string) =>
        dataOf<ReviewView[]>(
          await r
            .get(admin, status ? `${REVIEWS}?status=${status}` : REVIEWS)
            .expect(200),
        );

      it('holds a referral paid with the referrer’s own card: no credits, notification or milestone until approved', async () => {
        await milestone(1, 50);
        const { referrer, friends } = await referrerWith(1);
        const [friend] = friends;
        const card = newCard();
        await buy(referrer, card);
        await buy(friend, card);

        const referral = (await r.referralOf(friend.id))!;
        expect(referral).toMatchObject({
          status: 'HELD',
          holdReason: 'SHARED_PAYMENT_METHOD_WITH_REFERRER',
          rewardCredits: 100,
          rewardedAt: null,
        });
        expect(await r.rewardAllocations(referrer.id)).toEqual([]);
        expect(await r.notificationsOf(referrer.id)).toEqual([]);
        const overview = await overviewOf(referrer);
        expect(overview.referrals).toMatchObject({
          rewarded: 0,
          underReview: 1,
        });
        expect(overview.milestones.paidReferrals).toBe(0);
        expect(
          (await queue()).find((item) => item.id === referral.id),
        ).toMatchObject({
          status: 'HELD',
          holdReason: 'SHARED_PAYMENT_METHOD_WITH_REFERRER',
          rewardCredits: 100,
          referrer: { id: referrer.id },
          referred: { id: friend.id },
        });

        // Only a keyed hash of the card is stored, never the card data.
        const fingerprints = await app.ctx.client.paymentFingerprint.findMany({
          where: { authId: { in: [referrer.id, friend.id] } },
        });
        expect(fingerprints).toHaveLength(2);
        for (const row of fingerprints) {
          expect(row.fingerprintHash).toMatch(/^[0-9a-f]{64}$/);
          expect(row.fingerprintHash).not.toContain(card);
        }
        expect(fingerprints[0].fingerprintHash).toBe(
          fingerprints[1].fingerprintHash,
        );
        expect(JSON.stringify(referral)).not.toContain(card);

        const approved = dataOf<ReviewView>(
          await review(referral.id, 'approve').expect(200),
        );
        expect(approved).toMatchObject({
          status: 'REWARDED',
          reviewedBy: admin.id,
        });
        expect(await creditsOf(referrer.id)).toEqual([
          { ref: 'referral-reward', amount: '100' },
          { ref: 'referral-milestone', amount: '50' },
        ]);
        expect(
          (await r.notificationsOf(referrer.id)).map((n) => n.type).sort(),
        ).toEqual(['REFERRAL_MILESTONE_REACHED', 'REFERRAL_REWARD_EARNED']);
        // Decided once.
        await review(referral.id, 'approve').expect(409);
        await review(referral.id, 'reject').expect(409);
        expect(await r.rewardAllocations(referrer.id)).toHaveLength(2);
        expect(
          (await queue()).find((item) => item.id === referral.id),
        ).toBeUndefined();
        await expectConsistentLedger(app.ctx.client, referrer.id);
      });

      it('holds a second invited user paying with another invited user’s card; rejecting grants nothing and does not count', async () => {
        await milestone(2, 200);
        const { referrer, friends } = await referrerWith(3);
        const shared = newCard();
        await buy(friends[0], shared);
        await buy(friends[1], shared);
        await expect(r.referralOf(friends[0].id)).resolves.toMatchObject({
          status: 'REWARDED',
        });
        const held = (await r.referralOf(friends[1].id))!;
        expect(held).toMatchObject({
          status: 'HELD',
          holdReason: 'SHARED_PAYMENT_METHOD_WITH_OTHER_REFERRAL',
        });

        const rejected = dataOf<ReviewView>(
          await review(held.id, 'reject').expect(200),
        );
        expect(rejected).toMatchObject({ status: 'REJECTED' });
        await review(held.id, 'approve').expect(409);
        expect(await creditsOf(referrer.id)).toEqual([
          { ref: 'referral-reward', amount: '100' },
        ]);
        expect(
          (await queue('REJECTED')).some((item) => item.id === held.id),
        ).toBe(true);
        // The rejected referral does not count: the third paid referral is
        // only the second that counts.
        await buy(friends[2]);
        expect(await milestoneCreditsOf(referrer.id)).toEqual(['200']);
        const overview = await overviewOf(referrer);
        expect(overview.referrals).toMatchObject({
          rewarded: 2,
          rejected: 1,
          underReview: 0,
        });
        expect(overview.milestones.paidReferrals).toBe(2);
        // A rejected referral cannot be revived in the database either.
        await expect(
          app.ctx.client.referral.update({
            where: { id: held.id },
            data: { status: 'REWARDED', rewardedAt: new Date() },
          }),
        ).rejects.toThrow();
      });

      it('holds the reward when the payment method cannot be checked', async () => {
        const { referrer, friends } = await referrerWith(1);
        const checkout = await r.checkout(friends[0]);
        const sessionId = await r.payCheckout(checkout.checkoutSessionId, {
          cardFingerprint: newCard(),
        });
        app.stripe.api.failNext('GET /v1/payment_intents/:id', 'server');
        await r
          .sessionEvent('checkout.session.completed', sessionId)
          .expect(200);
        // The purchase itself is recorded and grants Pro.
        await expect(
          app.ctx.client.paymentTransaction.count({
            where: {
              subscription: { authId: friends[0].id },
              status: 'SUCCEEDED',
            },
          }),
        ).resolves.toBe(1);
        await expect(r.referralOf(friends[0].id)).resolves.toMatchObject({
          status: 'HELD',
          holdReason: 'PAYMENT_METHOD_UNAVAILABLE',
        });
        expect(await r.rewardAllocations(referrer.id)).toEqual([]);
      });

      it('decides concurrent approvals and rejections once', async () => {
        const { referrer, friends } = await referrerWith(1);
        const card = newCard();
        await buy(referrer, card);
        await buy(friends[0], card);
        const held = (await r.referralOf(friends[0].id))!;
        expect(held.status).toBe('HELD');

        const otherAdmin = await createAccount(app.ctx, userRole.ADMIN);
        const responses = await Promise.all([
          review(held.id, 'approve'),
          review(held.id, 'reject'),
          r.post(otherAdmin, `${REVIEWS}/${held.id}/approve`),
          r.post(otherAdmin, `${REVIEWS}/${held.id}/reject`),
          review(held.id, 'approve'),
        ]);
        const statuses = responses.map((res) => res.status).sort();
        expect(statuses).toEqual([200, 409, 409, 409, 409]);
        const decided = (await r.referralOf(friends[0].id))!;
        const credits = await r.rewardAllocations(referrer.id);
        if (decided.status === 'REWARDED') {
          expect(credits.map((a) => a.amount.toFixed())).toEqual(['100']);
        } else {
          expect(decided.status).toBe('REJECTED');
          expect(credits).toEqual([]);
        }
        await expect(
          app.ctx.client.notification.count({
            where: { authId: referrer.id },
          }),
        ).resolves.toBe(decided.status === 'REWARDED' ? 1 : 0);
        await review('00000000-0000-4000-8000-000000000000', 'approve').expect(
          404,
        );
        await r.get(admin, `${REVIEWS}?status=NOPE`).expect(400);
      });

      it('holds only one of two invited users paying concurrently with the same card', async () => {
        const { referrer, friends } = await referrerWith(2);
        const card = newCard();
        const sessions: string[] = [];
        for (const friend of friends) {
          const checkout = await r.checkout(friend);
          sessions.push(
            await r.payCheckout(checkout.checkoutSessionId, {
              cardFingerprint: card,
            }),
          );
        }
        await Promise.all(
          sessions.map((sessionId) =>
            r.sessionEvent('checkout.session.completed', sessionId).expect(200),
          ),
        );
        const statuses = await Promise.all(
          friends.map(
            async (friend) => (await r.referralOf(friend.id))!.status,
          ),
        );
        expect(statuses.sort()).toEqual(['HELD', 'REWARDED']);
        expect(
          (await r.rewardAllocations(referrer.id)).map((a) =>
            a.amount.toFixed(),
          ),
        ).toEqual(['100']);
      });
    });
  },
);
