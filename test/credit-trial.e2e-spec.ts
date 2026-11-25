import { mock } from 'jest-mock-extended';
import request from 'supertest';
import { UserRole } from '../src/auth/interfaces/auth.interface';
import { AuthUtilsService } from '../src/auth/services/auth-utils.service';
import { CreditExpirySweepService } from '../src/credit/credit-expiry-sweep.service';
import { CreditWalletService } from '../src/credit/credit-wallet.service';
import { RateLimitStore } from '../src/infrastructure/rate-limit/rate-limit.store';
import { FakeStripeApi } from './support/fake-stripe-api';
import { freezeTime } from './support/freeze-time';
import { describeWithDatabase } from './support/migrated-schema';
import { createUser, DAY_MS } from './support/subscription-fixtures';
import {
  createStripeTestApp,
  dataOf,
  type StripeTestApp,
} from './support/stripe-test-app';

jest.setTimeout(120_000);

/** A fixed point in time; every step below runs at T0 + n days. */
const T0 = new Date('2026-06-01T10:00:00.000Z');
const day = (n: number) => new Date(T0.getTime() + n * DAY_MS);
const TRIAL_END = day(7); // default 7-day trial

interface CreditRow {
  source: string;
  sourceReference: string;
  granted: string;
  remaining: string;
  expiresAt: Date | null;
  expiredAt: Date | null;
}
interface LedgerRow {
  sequence: number;
  type: string;
  amount: string;
  balanceAfter: string;
  reference: string | null;
  effectiveAt: Date;
}

/**
 * Trial credits end to end: POST /v1/subscription/trial, checkout and signed
 * Stripe webhooks over the real HTTP stack on a migrated PostgreSQL schema,
 * with Stripe replaced by an in-memory fake behind the real SDK and `Date`
 * frozen at controlled points in time.
 */
describeWithDatabase(
  'Trial credits (PostgreSQL, HTTP, controlled time)',
  () => {
    let harness: StripeTestApp;
    let api: FakeStripeApi;
    let wallets: CreditWalletService;
    let sweeper: CreditExpirySweepService;

    beforeAll(async () => {
      harness = await createStripeTestApp();
      wallets = harness.app.get(CreditWalletService, { strict: false });
      sweeper = harness.app.get(CreditExpirySweepService, { strict: false });
    });

    afterAll(async () => {
      jest.useRealTimers();
      await harness?.close();
    });

    beforeEach(async () => {
      jest.useRealTimers();
      api = new FakeStripeApi(5);
      harness.stripe.api = api;
      // Default credit settings (the column defaults).
      await harness.client.$executeRaw`
      UPDATE "CreditSettings" SET "trialAllowanceCredits" = DEFAULT`;
    });

    afterEach(() => jest.useRealTimers());

    const http = () => request(harness.app.getHttpServer());
    const activate = (userId: string, at: Date) => {
      freezeTime(at);
      return http()
        .post('/v1/subscription/trial')
        .set('Authorization', harness.bearer(userId));
    };
    const subscriptionOf = (userId: string) =>
      harness.client.userSubscription.findUniqueOrThrow({
        where: { authId: userId },
      });

    /** The user's allocations and ledger, read with SQL. */
    const creditsOf = (userId: string) =>
      harness.client.$queryRaw<CreditRow[]>`
      SELECT a."source"::text AS source, a."sourceReference",
             a."grantedCredits"::text AS granted, a."remainingCredits"::text AS remaining,
             a."expiresAt", a."expiredAt"
      FROM "CreditAllocation" a JOIN "CreditWallet" w ON w."id" = a."walletId"
      WHERE w."authId" = ${userId}
      ORDER BY a."grantedAt", a."source"`;
    const ledgerOf = (userId: string) =>
      harness.client.$queryRaw<LedgerRow[]>`
      SELECT t."sequence", t."type"::text AS type, t."amountCredits"::text AS amount,
             t."balanceAfterCredits"::text AS "balanceAfter", t."reference", t."effectiveAt"
      FROM "CreditTransaction" t JOIN "CreditWallet" w ON w."id" = t."walletId"
      WHERE w."authId" = ${userId}
      ORDER BY t."sequence"`;
    const walletBalance = async (userId: string) =>
      (
        await harness.client.creditWallet.findUniqueOrThrow({
          where: { authId: userId },
        })
      ).balanceCredits.toFixed();

    /** Purchased or referral credits, set up directly in PostgreSQL. */
    const grantInPostgres = (
      userId: string,
      source: 'PURCHASE' | 'REFERRAL',
      credits: number,
    ) =>
      harness.client.$queryRaw`
      SELECT "Credit_grant_manual"(${userId}, ${source}::"CreditSource", ${`${source}:${userId}`}, ${credits})`;

    /** Buys monthly Pro through checkout and the signed Stripe webhook at `at`. */
    const buyPro = async (userId: string, at: Date) => {
      freezeTime(at);
      const started = await harness
        .startCheckout(userId, 'MONTHLY')
        .expect(201);
      const checkout = await harness.client.checkoutSession.findUniqueOrThrow({
        where: { id: dataOf(started).checkoutSessionId },
      });
      const sessionId = checkout.providerSessionId as string;
      api.completeSession(sessionId, { periodStart: at });
      const event = api.signedEvent('checkout.session.completed', sessionId);
      await harness.sendWebhook(event.payload, event.signature).expect(200);
      return event;
    };

    const setTrialAllowance = async (credits: number) => {
      const adminId = await createUser(harness.client);
      await harness.client.authUser.update({
        where: { id: adminId },
        data: { role: 'ADMIN' },
      });
      const token = new AuthUtilsService(
        mock<RateLimitStore>(),
      ).createAccessToken({
        userId: adminId,
        role: UserRole.ADMIN,
        tokenVersion: 1,
      });
      await http()
        .patch('/v1/admin/credit-settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ trialAllowanceCredits: credits })
        .expect(200);
    };

    describe('activation', () => {
      it('allocates the default 50 trial credits, stored with their allocation and expiry', async () => {
        const userId = await createUser(harness.client);

        const response = await activate(userId, T0).expect(201);

        const subscription = await subscriptionOf(userId);
        expect(subscription.trialExpiresAt).toEqual(TRIAL_END);
        expect(dataOf(response)).toMatchObject({
          status: 'TRIAL',
          trialStartedAt: T0.toISOString(),
          trialExpiresAt: TRIAL_END.toISOString(),
          trialCredits: {
            credits: '50',
            expiresAt: TRIAL_END.toISOString(),
          },
        });
        await expect(creditsOf(userId)).resolves.toEqual([
          {
            source: 'TRIAL',
            sourceReference: `trial:${subscription.id}`,
            granted: '50.000000',
            remaining: '50.000000',
            expiresAt: TRIAL_END,
            expiredAt: null,
          },
        ]);
        await expect(ledgerOf(userId)).resolves.toEqual([
          {
            sequence: 1,
            type: 'ALLOCATION',
            amount: '50.000000',
            balanceAfter: '50.000000',
            reference: null,
            effectiveAt: T0,
          },
        ]);
        await expect(wallets.getBalance(userId, day(1))).resolves.toMatchObject(
          {
            availableCredits: '50',
            availableBySource: { TRIAL: '50' },
            nextExpiration: {
              expiresAt: TRIAL_END.toISOString(),
              credits: '50',
            },
          },
        );
      });

      it('allocates the allowance set by the administrator; earlier trials keep theirs', async () => {
        const earlier = await createUser(harness.client);
        await activate(earlier, T0).expect(201);

        jest.useRealTimers();
        await setTrialAllowance(80);
        const later = await createUser(harness.client);
        const response = await activate(later, T0).expect(201);

        expect(dataOf(response)).toMatchObject({
          trialCredits: { credits: '80' },
        });
        await expect(creditsOf(later)).resolves.toMatchObject([
          { granted: '80.000000' },
        ]);
        await expect(creditsOf(earlier)).resolves.toMatchObject([
          { granted: '50.000000', remaining: '50.000000' },
        ]);
      });

      it('starts the trial without credits when the administrator set the allowance to 0', async () => {
        await setTrialAllowance(0);
        const userId = await createUser(harness.client);

        const response = await activate(userId, T0).expect(201);

        expect(dataOf(response)).toMatchObject({
          status: 'TRIAL',
          trialCredits: null,
        });
        await expect(creditsOf(userId)).resolves.toEqual([]);
      });
    });

    describe('one-time allocation and duplicate protection', () => {
      it('never allocates more credits or changes the trial when activation is repeated', async () => {
        const userId = await createUser(harness.client);
        await activate(userId, T0).expect(201);
        const before = {
          subscription: await subscriptionOf(userId),
          credits: await creditsOf(userId),
          ledger: await ledgerOf(userId),
        };

        for (const at of [T0, day(1), day(6)]) {
          const response = await activate(userId, at).expect(409);
          expect(response.body).toMatchObject({
            message: 'The free trial has already been used',
          });
        }
        // Also after the trial (and its credits) expired.
        await activate(userId, day(30)).expect(409);

        jest.useRealTimers();
        await expect(subscriptionOf(userId)).resolves.toEqual(
          before.subscription,
        );
        await expect(creditsOf(userId)).resolves.toEqual(before.credits);
        await expect(ledgerOf(userId)).resolves.toEqual(before.ledger);
      });

      it('allocates once when the trial is activated concurrently', async () => {
        const userId = await createUser(harness.client);
        freezeTime(T0);

        const responses = await Promise.all(
          Array.from({ length: 8 }, () =>
            http()
              .post('/v1/subscription/trial')
              .set('Authorization', harness.bearer(userId)),
          ),
        );

        expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
        expect(
          responses.filter((r) => r.status !== 201).map((r) => r.status),
        ).toEqual(Array(7).fill(409));
        jest.useRealTimers();
        await expect(creditsOf(userId)).resolves.toHaveLength(1);
        await expect(ledgerOf(userId)).resolves.toHaveLength(1);
        await expect(walletBalance(userId)).resolves.toBe('50');
      });
    });

    describe('expiration', () => {
      it('expires the remaining trial credits at the end of the trial and logs it in the ledger', async () => {
        const userId = await createUser(harness.client);
        await activate(userId, T0).expect(201);
        jest.useRealTimers();
        await wallets.deduct({
          authId: userId,
          credits: '12.5',
          idempotencyKey: 'ai-run-1',
          now: day(1),
        });

        // Spendable until the trial ends, then never again.
        await expect(
          wallets.getBalance(userId, new Date(TRIAL_END.getTime() - 1)),
        ).resolves.toMatchObject({ availableCredits: '37.5' });
        await expect(
          wallets.getBalance(userId, TRIAL_END),
        ).resolves.toMatchObject({ availableCredits: '0' });

        // The scheduled sweep records the expiry for this idle wallet.
        const sweep = await sweeper.sweep(day(8));
        expect(sweep?.expiredAllocations).toBeGreaterThanOrEqual(1);
        await expect(sweeper.sweep(day(9))).resolves.toMatchObject({
          expiredAllocations: 0,
        });

        await expect(ledgerOf(userId)).resolves.toEqual([
          expect.objectContaining({ type: 'ALLOCATION', amount: '50.000000' }),
          expect.objectContaining({ type: 'DEDUCTION', amount: '-12.500000' }),
          {
            sequence: 3,
            type: 'EXPIRATION',
            amount: '-37.500000',
            balanceAfter: '0.000000',
            reference: null,
            effectiveAt: TRIAL_END,
          },
        ]);
        await expect(creditsOf(userId)).resolves.toEqual([
          expect.objectContaining({
            remaining: '0.000000',
            expiresAt: TRIAL_END,
            expiredAt: day(8),
          }),
        ]);
        // The trial itself is unchanged.
        await expect(subscriptionOf(userId)).resolves.toMatchObject({
          trialStartedAt: T0,
          trialExpiresAt: TRIAL_END,
        });
      });
    });

    describe('paid Pro subscription', () => {
      it('buying Pro during the trial expires all trial credits but keeps purchased and referral credits', async () => {
        const userId = await createUser(harness.client);
        await activate(userId, T0).expect(201);
        jest.useRealTimers();
        await grantInPostgres(userId, 'PURCHASE', 20);
        await grantInPostgres(userId, 'REFERRAL', 5);
        await wallets.deduct({
          authId: userId,
          credits: 10,
          idempotencyKey: 'ai-run-1',
          now: day(1),
        });

        const event = await buyPro(userId, day(2));

        // Access is evaluated in the controlled timeline (Pro bought on day 2).
        freezeTime(day(3));
        await expect(harness.status(userId)).resolves.toMatchObject({
          status: 'PRO',
          hasProAccess: true,
        });
        jest.useRealTimers();
        const ledger = await ledgerOf(userId);
        expect(ledger[ledger.length - 1]).toEqual({
          sequence: 5,
          type: 'EXPIRATION',
          amount: '-40.000000',
          balanceAfter: '25.000000',
          reference: 'trial-ended:pro-activated',
          effectiveAt: day(2),
        });
        await expect(creditsOf(userId)).resolves.toEqual([
          expect.objectContaining({
            source: 'TRIAL',
            remaining: '0.000000',
            expiresAt: TRIAL_END, // the original terms stay traceable
            expiredAt: day(2),
          }),
          expect.objectContaining({
            source: 'PURCHASE',
            remaining: '20.000000',
            expiredAt: null,
          }),
          expect.objectContaining({
            source: 'REFERRAL',
            remaining: '5.000000',
            expiredAt: null,
          }),
        ]);
        await expect(wallets.getBalance(userId, day(3))).resolves.toMatchObject(
          {
            availableCredits: '25',
            availableBySource: { TRIAL: '0', PURCHASE: '20', REFERRAL: '5' },
          },
        );

        // Stripe redelivers the event a minute later: nothing changes.
        freezeTime(new Date(day(2).getTime() + 60_000));
        await harness.sendWebhook(event.payload, event.signature).expect(200);
        jest.useRealTimers();
        await expect(ledgerOf(userId)).resolves.toEqual(ledger);
        // Purchased and referral credits outlive the trial's end date.
        await expect(
          wallets.getBalance(userId, day(365)),
        ).resolves.toMatchObject({ availableCredits: '25' });
        await expect(subscriptionOf(userId)).resolves.toMatchObject({
          trialStartedAt: T0,
          trialExpiresAt: TRIAL_END,
        });
      });

      it('buying Pro after the trial ended records the expiry at the trial end, not at the purchase', async () => {
        const userId = await createUser(harness.client);
        await activate(userId, T0).expect(201);

        await buyPro(userId, day(10));

        jest.useRealTimers();
        await expect(ledgerOf(userId)).resolves.toEqual([
          expect.objectContaining({ type: 'ALLOCATION' }),
          expect.objectContaining({
            type: 'EXPIRATION',
            amount: '-50.000000',
            reference: null,
            effectiveAt: TRIAL_END,
          }),
        ]);
      });

      it('buying Pro without a trial writes no credit records', async () => {
        const userId = await createUser(harness.client);

        await buyPro(userId, T0);

        jest.useRealTimers();
        await expect(creditsOf(userId)).resolves.toEqual([]);
        await expect(ledgerOf(userId)).resolves.toEqual([]);
      });
    });
  },
);
