// Must be first: PostgreSQL-only infrastructure (no Redis), mock AI and local
// storage, set before any application module reads the environment.
import './support/env-postgres-mode';
import { randomUUID } from 'node:crypto';
import { CreditPackageSettingsService } from '../src/credit-packages/credit-package-settings.service';
import { CreditWalletService } from '../src/credits/credit-wallet.service';
import { LoyaltyMissionProgressService } from '../src/daily-rewards/missions/loyalty-mission-progress.service';
import {
  expectConsistentLedger,
  givenCreditsInPostgres,
} from './support/credit-fixtures';
import { creditPackageFlows } from './support/credit-package-flows';
import type { TestAccount } from './support/discount-fixtures';
import { FakeStripeApi } from './support/fake-stripe-api';
import { describeWithDatabase } from './support/migrated-schema';
import {
  bootReferralApp,
  dataOf,
  messageOf,
  type ReferralApp,
} from './support/referral-flows';
import { givenPaidProHistory } from './support/subscription-fixtures';

jest.setTimeout(300_000);

const DAY = 24 * 60 * 60 * 1000;

interface HistoryItem {
  type: string;
  amount: string;
  source: string | null;
  sources: Array<{ source: string; amount: string; allocationId: string }>;
  description: string | null;
}
interface Balance {
  available: string;
  usable: string;
  sources: Array<{
    source: string;
    granted: string;
    available: string;
    used: string;
    expires: boolean;
  }>;
  allocations: Array<{
    id: string;
    source: string;
    granted: string;
    available: string;
    used: string;
    expiresAt: string | null;
  }>;
}

/**
 * Purchased package credits in the credit ledger, through the complete
 * application: non-expiring PURCHASE allocations spent last (free credits
 * first: trial, subscription, daily reward and loyalty mission credits by
 * closest expiration or oldest grant; then referral credits; then purchased
 * credits, oldest first, even when older than referral credits), the
 * caller's own balance and history only, and access to POST /v1/sessions
 * after Pro has ended.
 */
describeWithDatabase(
  'Credit package credits in the ledger (PostgreSQL, full stack)',
  () => {
    let app: ReferralApp;
    let p: ReturnType<typeof creditPackageFlows>;
    let admin: TestAccount;

    const wallet = () => app.ctx.get<CreditWalletService>(CreditWalletService);
    const spend = (authId: string, amount: string) =>
      wallet().debit({
        authId,
        amount,
        idempotencyKey: `spend-${randomUUID()}`,
      });
    const balanceOf = async (account: TestAccount) =>
      dataOf<Balance>(await p.get(account, '/v1/credits/balance').expect(200));
    const historyOf = async (account: TestAccount, query = '') =>
      dataOf<{ items: HistoryItem[] }>(
        await p.get(account, `/v1/credits/transactions${query}`).expect(200),
      ).items;
    /** The sources of each deduction, oldest deduction first. */
    const deductions = async (account: TestAccount) =>
      (await historyOf(account, '?type=DEDUCTION'))
        .reverse()
        .map((item) => item.sources.map((s) => [s.source, s.amount]));

    /**
     * Loyalty mission credits: a makeup session completed with every step
     * (stored directly), rewarded by a one-time mission.
     */
    const givenMissionCredits = async (authId: string, credits: number) => {
      const client = app.ctx.client;
      const completedAt = new Date();
      const mission = await client.loyaltyMission.create({
        data: {
          title: 'First look',
          recurrence: 'ONCE',
          requiredCompletions: 1,
          rewardCredits: credits,
          startsAt: new Date(completedAt.getTime() - 60_000),
        },
      });
      const session = await client.makeupSession.create({
        data: {
          authId,
          status: 'COMPLETED',
          completedAt,
          recommendations: {
            create: {
              rank: 1,
              name: 'Look',
              tagline: 't',
              matchScore: 90,
              imageUrl: 'https://example.com/look.jpg',
              palette: [],
              rationale: 'r',
            },
          },
        },
        include: { recommendations: true },
      });
      await client.guide.create({
        data: {
          sessionId: session.id,
          recommendationId: session.recommendations[0].id,
          status: 'COMPLETED',
          completedAt,
          steps: {
            create: {
              position: 0,
              status: 'COMPLETED',
              completedAt,
              title: 'Step',
              instruction: 'i',
              area: 'face',
              technique: 'pat',
              estimatedSeconds: 10,
              personalizedTip: 'p',
              commonMistake: 'c',
              successCriteria: 's',
            },
          },
        },
      });
      await client.makeupCompletion.create({
        data: { sessionId: session.id, authId, completedAt },
      });
      await app.ctx
        .get<LoyaltyMissionProgressService>(LoyaltyMissionProgressService)
        .processCompletion(session.id);
      await client.loyaltyMission.update({
        where: { id: mission.id },
        data: { active: false },
      });
    };

    beforeAll(async () => {
      app = await bootReferralApp();
      p = creditPackageFlows(app);
      admin = await p.admin();
    });

    beforeEach(async () => {
      app.stripe.api = new FakeStripeApi(5);
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
    });

    it('adds purchased credits to the ledger as a non-expiring PURCHASE allocation, visible only to the buyer', async () => {
      const buyer = await p.signUp({ prefix: 'led' });
      const other = await p.signUp({ prefix: 'oth' });
      const { order } = await p.buyPackage(buyer, 'SMALL');

      const balance = await balanceOf(buyer);
      expect(balance).toMatchObject({ available: '250', usable: '250' });
      expect(balance.allocations).toMatchObject([
        {
          source: 'PURCHASE',
          granted: '250',
          available: '250',
          used: '0',
          expiresAt: null,
        },
      ]);
      const history = await historyOf(buyer);
      expect(history).toMatchObject([
        {
          type: 'ALLOCATION',
          amount: '250',
          source: 'PURCHASE',
          description: 'Credit package SMALL: 250 credits',
        },
      ]);
      const { allocations, transactions } = await expectConsistentLedger(
        app.ctx.client,
        buyer.id,
      );
      expect(allocations[0].sourceReference).toBe(`credit-package:${order.id}`);
      expect(transactions).toHaveLength(1);

      // Another user sees none of it; no route takes a user id.
      expect((await balanceOf(other)).available).toBe('0');
      expect(await historyOf(other)).toEqual([]);
      await p
        .get(buyer, `/v1/credits/transactions?userId=${other.id}`)
        .expect(400);
      await p.get(other, `/v1/credits/balance?userId=${buyer.id}`).expect(400);
      await p.http().get('/v1/credits/balance').expect(401);

      // Purchased credits never expire: an expiration run keeps them.
      await wallet().expireCredits(buyer.id);
      expect((await balanceOf(buyer)).available).toBe('250');
    });

    it('spends trial, loyalty and daily reward credits first, then referral credits, and purchased credits last even when they are older', async () => {
      const user = await p.signUp({ prefix: 'order' });
      // Oldest first: purchased (250), referral (40), mission (30), daily
      // reward (10), trial (the plan's trial credits, expiring).
      await p.buyPackage(user, 'SMALL');
      await givenCreditsInPostgres(app.ctx.client, user.id, 'REFERRAL', '40');
      await givenMissionCredits(user.id, 30);
      await p.post(user, '/v1/daily-rewards/claim').expect(201);
      await p.post(user, '/v1/subscription/trial').expect(201);
      const trial = (await balanceOf(user)).sources.find(
        (s) => s.source === 'TRIAL',
      )!;
      const trialCredits = Number(trial.granted);
      expect(trialCredits).toBeGreaterThan(0);
      expect(trial.expires).toBe(true);

      // Each deduction takes from the earliest source in spending order.
      await spend(user.id, String(trialCredits + 20));
      await spend(user.id, '55');
      await spend(user.id, '10');

      expect(await deductions(user)).toEqual([
        [
          ['TRIAL', `-${trialCredits}`],
          ['MISSION_REWARD', '-20'],
        ],
        [
          ['MISSION_REWARD', '-10'],
          ['DAILY_REWARD', '-10'],
          ['REFERRAL', '-35'],
        ],
        [
          ['REFERRAL', '-5'],
          ['PURCHASE', '-5'],
        ],
      ]);
      const sources = Object.fromEntries(
        (await balanceOf(user)).sources.map((s) => [s.source, s.available]),
      );
      expect(sources).toMatchObject({
        TRIAL: '0',
        MISSION_REWARD: '0',
        DAILY_REWARD: '0',
        REFERRAL: '0',
        PURCHASE: '245',
      });
      await expectConsistentLedger(app.ctx.client, user.id);
    });

    it('spends Pro subscription credits (closest expiration) before daily rewards, and the oldest purchase first', async () => {
      const user = await p.signUp({ prefix: 'pro' });
      await p.buyPackage(user, 'SMALL'); // 250, oldest
      await p.buyPro(user);
      await p.buyPackage(user, 'MEDIUM'); // 500, newest
      await p.post(user, '/v1/daily-rewards/claim').expect(201);
      const subscription = (await balanceOf(user)).sources.find(
        (s) => s.source === 'SUBSCRIPTION',
      )!;
      const proCredits = Number(subscription.granted);
      expect(proCredits).toBeGreaterThan(0);

      await spend(user.id, String(proCredits + 10 + 300));
      expect(await deductions(user)).toEqual([
        [
          ['SUBSCRIPTION', `-${proCredits}`],
          ['DAILY_REWARD', '-10'],
          ['PURCHASE', '-250'],
          ['PURCHASE', '-50'],
        ],
      ]);
      const balance = await balanceOf(user);
      const purchases = balance.allocations
        .filter((a) => a.source === 'PURCHASE')
        .map((a) => [a.granted, a.available]);
      expect(purchases.sort()).toEqual([
        ['250', '0'],
        ['500', '450'],
      ]);
      await expectConsistentLedger(app.ctx.client, user.id);
    });

    it('lets purchased credits open makeup sessions after the Pro subscription has expired', async () => {
      const user = await p.signUp({ prefix: 'exp' });
      await givenPaidProHistory(
        app.ctx.client,
        user.id,
        {
          billingInterval: 'MONTHLY',
          startedAt: new Date(Date.now() - 90 * DAY),
        },
        new Date(),
      );
      await expect(
        p.get(user, '/v1/subscription').expect(200).then(dataOf),
      ).resolves.toMatchObject({ status: 'EXPIRED', hasProAccess: false });
      expect(messageOf(await p.post(user, '/v1/sessions').expect(403))).toBe(
        'Insufficient credits',
      );

      await p.buyPackage(user, 'SMALL');
      await p.post(user, '/v1/sessions').expect(201);
      await expect(
        app.ctx.client.makeupSession.count({ where: { authId: user.id } }),
      ).resolves.toBe(1);
    });

    it('keeps the ledger consistent when purchases are granted while credits are being spent', async () => {
      const user = await p.signUp({ prefix: 'conc' });
      await p.buyPackage(user, 'MEDIUM'); // 500
      const order = await p.orderPackage(user, 'SMALL');
      const sessionId = await p.payOrder(order.id);

      const results = await Promise.allSettled([
        ...Array.from({ length: 8 }, () => spend(user.id, '40')),
        p.sessionEvent('checkout.session.completed', sessionId),
        p.sessionEvent('checkout.session.completed', sessionId),
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect((await p.packageCredits(user.id)).map((c) => c.amount)).toEqual([
        '500',
        '250',
      ]);
      expect((await balanceOf(user)).available).toBe(String(750 - 8 * 40));
      await expectConsistentLedger(app.ctx.client, user.id);
    });
  },
);
