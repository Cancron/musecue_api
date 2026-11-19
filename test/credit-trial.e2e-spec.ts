import { CreditSource, type PrismaClient } from '@prisma/client';
import request from 'supertest';
import { CreditExpirationSweepService } from '../src/credits/credit-expiration-sweep.service';
import { CreditSettingsService } from '../src/credits/credit-settings.service';
import { CreditWalletService } from '../src/credits/credit-wallet.service';
import { CreditEligibilityService } from '../src/subscription/credit-eligibility.service';
import {
  expectConsistentLedger,
  givenCreditsInPostgres,
} from './support/credit-fixtures';
import { FakeStripeApi } from './support/fake-stripe-api';
import { freezeTime } from './support/freeze-time';
import { describeWithDatabase } from './support/migrated-schema';
import {
  createStripeTestApp,
  dataOf,
  type StripeTestApp,
} from './support/stripe-test-app';
import { createUser, daysFrom } from './support/subscription-fixtures';

jest.setTimeout(120_000);

const DAY = 24 * 60 * 60 * 1000;

/**
 * Trial credits end to end: the real HTTP stack (POST /v1/subscription/trial,
 * checkout and the signed Stripe webhook), services and a migrated
 * PostgreSQL schema, with Stripe replaced by FakeStripeApi behind the real
 * Stripe SDK and time controlled by freezeTime. No external service is
 * contacted.
 */
describeWithDatabase('Trial credits (PostgreSQL, HTTP)', () => {
  let harness: StripeTestApp;
  let client: PrismaClient;
  let api: FakeStripeApi;

  const wallet = () => harness.app.get(CreditWalletService);
  const eligibility = (authId: string) =>
    harness.app.get(CreditEligibilityService).getEligibility(authId);
  const sweep = () => harness.app.get(CreditExpirationSweepService).sweep();

  const activateTrial = (userId: string) =>
    request(harness.app.getHttpServer())
      .post('/v1/subscription/trial')
      .set('Authorization', harness.bearer(userId));

  /** Buys monthly Pro through checkout and the verified webhook. */
  const buyPro = async (userId: string) => {
    const started = await harness.startCheckout(userId, 'MONTHLY').expect(201);
    const { providerSessionId } =
      await client.checkoutSession.findUniqueOrThrow({
        where: { id: dataOf(started).checkoutSessionId },
      });
    const periodStart = new Date();
    periodStart.setUTCMilliseconds(0);
    api.completeSession(providerSessionId as string, { periodStart });
    const deliver = () => {
      const { payload, signature } = api.signedEvent(
        'checkout.session.completed',
        providerSessionId as string,
      );
      return harness.sendWebhook(payload, signature).expect(200);
    };
    await deliver();
    return { periodStart, redeliver: deliver };
  };

  const trialAllocations = (authId: string) =>
    client.creditAllocation.findMany({
      where: { authId, source: CreditSource.TRIAL },
    });
  const transactionsOf = (authId: string) =>
    client.creditTransaction.findMany({
      where: { authId },
      orderBy: { sequence: 'asc' },
    });
  const subscriptionOf = (authId: string) =>
    client.userSubscription.findUnique({ where: { authId } });

  beforeAll(async () => {
    harness = await createStripeTestApp();
    client = harness.client;
  });

  afterAll(async () => {
    jest.useRealTimers();
    await harness?.close();
  });

  beforeEach(() => {
    api = new FakeStripeApi(5);
    harness.stripe.api = api;
  });

  afterEach(() => jest.useRealTimers());

  describe('activation', () => {
    it('allocates the trial allowance, stored with its allocation and expiration', async () => {
      const T0 = new Date('2030-03-01T09:30:00.000Z');
      freezeTime(T0);
      const userId = await createUser(client);

      const response = await activateTrial(userId).expect(201);
      const trial = dataOf(response);
      expect(trial).toMatchObject({
        status: 'TRIAL',
        trialStartedAt: T0.toISOString(),
        trialExpiresAt: daysFrom(T0, 7).toISOString(),
      });

      const wallet = await client.creditWallet.findUniqueOrThrow({
        where: { authId: userId },
      });
      const [allocation, ...others] = await client.creditAllocation.findMany({
        where: { authId: userId },
      });
      expect(others).toEqual([]);
      expect(allocation).toMatchObject({
        walletId: wallet.id,
        authId: userId,
        source: 'TRIAL',
        sourceReference: `trial:${T0.toISOString()}`,
        grantedAt: T0,
        expiresAt: daysFrom(T0, 7),
      });
      expect(allocation.amount.toFixed()).toBe('50');
      expect(allocation.remaining.toFixed()).toBe('50');

      const [grant] = await transactionsOf(userId);
      expect(grant).toMatchObject({
        type: 'GRANT',
        occurredAt: T0,
        idempotencyKey: `grant:TRIAL:trial:${T0.toISOString()}`,
        description: 'Free trial credits',
      });
      expect(grant.amount.toFixed()).toBe('50');
      expect(grant.balanceAfter.toFixed()).toBe('50');

      await expect(eligibility(userId)).resolves.toMatchObject({
        eligible: true,
        usableCredits: '50',
        usableBySource: { TRIAL: '50' },
      });
      await expectConsistentLedger(client, userId);
    });

    it('allocates the amount configured by an administrator at activation time', async () => {
      const admin = await createUser(client);
      const settings = harness.app.get(CreditSettingsService);
      const earlier = await createUser(client);
      await activateTrial(earlier).expect(201);

      await settings.updateSettings(
        { trialCredits: 120 },
        { actionedBy: admin },
      );
      try {
        const later = await createUser(client);
        await activateTrial(later).expect(201);

        const [granted] = await trialAllocations(later);
        expect(granted.amount.toFixed()).toBe('120');
        // Credits granted before the change keep their amount.
        const [kept] = await trialAllocations(earlier);
        expect(kept.amount.toFixed()).toBe('50');
      } finally {
        await settings.updateSettings(
          { trialCredits: 50 },
          { actionedBy: admin },
        );
      }
    });

    it('is all-or-nothing: when the credits cannot be allocated, no trial starts', async () => {
      const userId = await createUser(client);
      // Trial credits already on record (e.g. from a data fix): a second
      // trial allocation is refused, so the activation rolls back.
      await wallet().grant({
        authId: userId,
        source: CreditSource.TRIAL,
        sourceReference: 'data-fix',
        amount: 1,
        expiresAt: new Date(Date.now() + DAY),
      });

      await activateTrial(userId).expect(409);

      await expect(subscriptionOf(userId)).resolves.toBeNull();
      await expect(trialAllocations(userId)).resolves.toHaveLength(1);
    });
  });

  describe('one-time allocation', () => {
    it('never allocates again, nor changes the trial period, when the trial is activated again', async () => {
      const T0 = new Date('2030-04-01T08:00:00.000Z');
      freezeTime(T0);
      const userId = await createUser(client);
      await activateTrial(userId).expect(201);
      const record = await subscriptionOf(userId);

      freezeTime(daysFrom(T0, 2));
      const again = await activateTrial(userId).expect(409);
      expect(again.body).toMatchObject({
        message: 'The free trial has already been used',
      });
      // After the trial has ended, too.
      freezeTime(daysFrom(T0, 30));
      await activateTrial(userId).expect(409);

      await expect(subscriptionOf(userId)).resolves.toMatchObject({
        trialStartedAt: record?.trialStartedAt,
        trialExpiresAt: record?.trialExpiresAt,
      });
      await expect(trialAllocations(userId)).resolves.toHaveLength(1);
      await expect(
        client.creditTransaction.count({
          where: { authId: userId, type: 'GRANT' },
        }),
      ).resolves.toBe(1);
    });

    it('allocates once when activations race', async () => {
      const userId = await createUser(client);

      const responses = await Promise.all(
        Array.from({ length: 8 }, () => activateTrial(userId)),
      );

      expect(responses.map((r) => r.status).sort()).toEqual([
        201, 409, 409, 409, 409, 409, 409, 409,
      ]);
      const allocations = await trialAllocations(userId);
      expect(allocations).toHaveLength(1);
      expect(allocations[0].amount.toFixed()).toBe('50');
      await expectConsistentLedger(client, userId);
    });
  });

  describe('expiration', () => {
    it('stops counting the remaining credits at the trial expiry and logs their expiration', async () => {
      const T0 = new Date('2030-05-10T12:00:00.000Z');
      const expiry = daysFrom(T0, 7);
      freezeTime(T0);
      const userId = await createUser(client);
      await activateTrial(userId).expect(201);
      await wallet().debit({
        authId: userId,
        amount: '12.25',
        idempotencyKey: 'ai-run-1',
      });

      freezeTime(new Date(expiry.getTime() - 1));
      await expect(eligibility(userId)).resolves.toMatchObject({
        usableCredits: '37.75',
      });

      // From the exact expiry instant the credits no longer count, even
      // before the expiration is recorded.
      freezeTime(expiry);
      await expect(eligibility(userId)).resolves.toMatchObject({
        eligible: false,
        usableCredits: '0',
      });
      await expect(wallet().getBalance(userId)).resolves.toMatchObject({
        available: '0',
      });

      // The scheduled sweep logs the expiration, once.
      freezeTime(daysFrom(T0, 9));
      await sweep();
      await sweep();
      const history = await transactionsOf(userId);
      expect(
        history.map((t) => [
          t.type,
          t.amount.toFixed(),
          t.balanceAfter.toFixed(),
          t.occurredAt.toISOString(),
        ]),
      ).toEqual([
        ['GRANT', '50', '50', T0.toISOString()],
        ['DEBIT', '-12.25', '37.75', T0.toISOString()],
        ['EXPIRATION', '-37.75', '0', expiry.toISOString()],
      ]);
      expect(history[2].description).toBe('TRIAL credits expired');
      const [allocation] = await trialAllocations(userId);
      expect(allocation.remaining.toFixed()).toBe('0');
      await expectConsistentLedger(client, userId);
    });
  });

  describe('upgrade to paid Pro', () => {
    it('expires all trial credits at the purchase, keeping purchased and referral credits', async () => {
      const T0 = new Date('2030-06-01T10:00:00.000Z');
      freezeTime(T0);
      const userId = await createUser(client);
      const activated = await activateTrial(userId).expect(201);
      const trialRecord = await subscriptionOf(userId);
      await givenCreditsInPostgres(client, userId, 'PURCHASE', '20');
      await givenCreditsInPostgres(client, userId, 'REFERRAL', '5');
      // Trial credits are spent first (they expire soonest).
      await wallet().debit({
        authId: userId,
        amount: '10',
        idempotencyKey: 'ai-run-1',
      });

      const upgradedAt = daysFrom(T0, 2);
      freezeTime(upgradedAt);
      const { redeliver } = await buyPro(userId);

      await expect(harness.status(userId)).resolves.toMatchObject({
        status: 'PRO',
        accessSource: 'PRO',
      });
      const expirations = await client.creditTransaction.findMany({
        where: { authId: userId, type: 'EXPIRATION' },
      });
      expect(
        expirations.map((t) => [
          t.amount.toFixed(),
          t.balanceAfter.toFixed(),
          t.occurredAt.toISOString(),
          t.description,
        ]),
      ).toEqual([
        [
          '-40',
          '25',
          upgradedAt.toISOString(),
          'TRIAL credits expired: upgraded to Pro',
        ],
      ]);
      const bySource = Object.fromEntries(
        (
          await client.creditAllocation.findMany({ where: { authId: userId } })
        ).map((a) => [a.source, a.remaining.toFixed()]),
      );
      // The purchase itself granted the first month of Pro credits.
      expect(bySource).toEqual({
        TRIAL: '0',
        SUBSCRIPTION: '1000',
        PURCHASE: '20',
        REFERRAL: '5',
      });
      // The trial credits ended before the Pro credits were granted.
      expect(
        (await transactionsOf(userId))
          .slice(-2)
          .map((t) => [t.type, t.amount.toFixed(), t.balanceAfter.toFixed()]),
      ).toEqual([
        ['EXPIRATION', '-40', '25'],
        ['GRANT', '1000', '1025'],
      ]);
      // The trial itself is history, unchanged.
      await expect(subscriptionOf(userId)).resolves.toMatchObject({
        trialUsed: true,
        trialStartedAt: trialRecord?.trialStartedAt,
        trialExpiresAt: trialRecord?.trialExpiresAt,
      });
      expect(dataOf(activated).trialExpiresAt).toBe(
        trialRecord?.trialExpiresAt?.toISOString(),
      );

      // Usable now: purchased, referral and the first month of Pro; never
      // trial credits again (no trial allowance is granted after buying Pro).
      await expect(eligibility(userId)).resolves.toMatchObject({
        eligible: true,
        usableBySource: {
          TRIAL: '0',
          SUBSCRIPTION: '1000',
          PURCHASE: '20',
          REFERRAL: '5',
        },
      });
      await expect(trialAllocations(userId)).resolves.toHaveLength(1);

      // A redelivered webhook and the trial's own expiry change nothing more.
      await redeliver();
      freezeTime(daysFrom(T0, 8));
      await sweep();
      await expect(
        client.creditTransaction.count({
          where: {
            authId: userId,
            type: 'EXPIRATION',
            entries: { some: { allocation: { source: 'TRIAL' } } },
          },
        }),
      ).resolves.toBe(1);
      await expectConsistentLedger(client, userId);
    });

    it('records the natural expiry when Pro is bought after the trial has already ended', async () => {
      const T0 = new Date('2030-07-01T10:00:00.000Z');
      freezeTime(T0);
      const userId = await createUser(client);
      await activateTrial(userId).expect(201);

      freezeTime(daysFrom(T0, 10));
      await buyPro(userId);

      const expirations = await client.creditTransaction.findMany({
        where: { authId: userId, type: 'EXPIRATION' },
      });
      expect(
        expirations.map((t) => [
          t.amount.toFixed(),
          t.occurredAt.toISOString(),
          t.description,
        ]),
      ).toEqual([
        ['-50', daysFrom(T0, 7).toISOString(), 'TRIAL credits expired'],
      ]);
      await expectConsistentLedger(client, userId);
    });

    it('grants only the monthly Pro credits for a Pro purchase without a trial', async () => {
      const userId = await createUser(client);
      await buyPro(userId);

      await expect(harness.status(userId)).resolves.toMatchObject({
        status: 'PRO',
      });
      const allocations = await client.creditAllocation.findMany({
        where: { authId: userId },
      });
      expect(allocations.map((a) => [a.source, a.amount.toFixed()])).toEqual([
        ['SUBSCRIPTION', '1000'],
      ]);
      await expect(
        client.creditTransaction.count({
          where: { authId: userId, type: 'EXPIRATION' },
        }),
      ).resolves.toBe(0);
    });
  });
});
