import { PrismaPg } from '@prisma/adapter-pg';
import { CreditSource, PrismaClient } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import { ActivityLogService } from '../src/common/services/activity-log.service';
import type { CustomLoggerService } from '../src/common/services/custom-logger.service';
import type { PrismaService } from '../src/common/services/prisma.service';
import { CreditSettingsService } from '../src/credits/credit-settings.service';
import { CreditWalletService } from '../src/credits/credit-wallet.service';
import type { WalletOperationOptions } from '../src/credits/credit-wallet.service';
import type {
  GrantCreditsInput,
  GrantCreditsResult,
} from '../src/credits/interfaces/credit-wallet.interface';
import { CreditAllocationScheduler } from '../src/subscription/credit-allocation.scheduler';
import { CreditAllowanceService } from '../src/subscription/credit-allowance.service';
import { CreditEligibilityService } from '../src/subscription/credit-eligibility.service';
import { expectConsistentLedger } from './support/credit-fixtures';
import { FakeStripeApi } from './support/fake-stripe-api';
import { freezeTime } from './support/freeze-time';
import {
  TEST_DATABASE_URL,
  describeWithDatabase,
} from './support/migrated-schema';
import {
  createStripeTestApp,
  dataOf,
  type StripeTestApp,
} from './support/stripe-test-app';
import { createUser } from './support/subscription-fixtures';

jest.setTimeout(180_000);

const DAY = 24 * 60 * 60 * 1000;

/** The month starts of a yearly term from `start` (same day, clamped). */
const monthStarts = (start: Date) =>
  Array.from({ length: 13 }, (_, k) => {
    const d = new Date(start.getTime());
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + k);
    const last = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
    ).getUTCDate();
    d.setUTCDate(Math.min(start.getUTCDate(), last));
    return d;
  });

/**
 * The monthly credit allocation scheduler of yearly subscriptions against
 * PostgreSQL, with controlled time: months missed while it was not running,
 * recovery when a worker stops in the middle of an allocation (and after
 * the application restarts), and idempotency under repeated and concurrent
 * runs. Yearly subscriptions are bought through checkout and signed Stripe
 * webhooks, with Stripe replaced by FakeStripeApi behind the real SDK. A
 * restart closes the application and its database connections and boots a
 * new one on the same schema; nothing in memory survives.
 */
describeWithDatabase('Monthly credit allocation scheduler (PostgreSQL)', () => {
  let harness: StripeTestApp;
  let api: FakeStripeApi;

  const client = () => harness.client;
  /** The real grant of a wallet, to wrap in a simulated crash. */
  const realGrantOf =
    (grants: CreditWalletService) =>
    (
      input: GrantCreditsInput,
      options?: WalletOperationOptions,
    ): Promise<GrantCreditsResult> =>
      // The prototype method, not the (spied) instance property. `call` is
      // untyped here (strictBindCallApply is off), hence the assertion.
      CreditWalletService.prototype.grant.call(
        grants,
        input,
        options,
      ) as Promise<GrantCreditsResult>;
  const scheduler = () => harness.app.get(CreditAllocationScheduler);
  const wallet = () => harness.app.get(CreditWalletService);

  /** Buys yearly Pro; the first paid period starts at `periodStart` (now). */
  const subscribeYearly = async (authId: string, periodStart: Date) => {
    const view = dataOf(
      await harness.startCheckout(authId, 'YEARLY').expect(201),
    );
    const checkout = await client().checkoutSession.findUniqueOrThrow({
      where: { id: view.checkoutSessionId },
    });
    const sessionId = checkout.providerSessionId as string;
    api.completeSession(sessionId, { periodStart });
    const { payload, signature } = api.signedEvent(
      'checkout.session.completed',
      sessionId,
    );
    await harness.sendWebhook(payload, signature).expect(200);
  };
  const yearlySubscriber = async (T0: Date) => {
    freezeTime(T0);
    const authId = await createUser(client());
    await subscribeYearly(authId, T0);
    return authId;
  };

  const scheduleOf = (authId: string) =>
    client().creditAllocationSchedule.findMany({
      where: { authId },
      orderBy: { periodStart: 'asc' },
    });
  const allocationsOf = (authId: string) =>
    client().creditAllocation.findMany({
      where: { authId, source: CreditSource.SUBSCRIPTION },
      orderBy: { periodStart: 'asc' },
    });
  /** [type, amount, occurredAt, month] of every Pro credit transaction. */
  const proLedger = async (authId: string) =>
    (
      await client().creditTransaction.findMany({
        where: {
          authId,
          entries: {
            some: { allocation: { source: CreditSource.SUBSCRIPTION } },
          },
        },
        orderBy: { sequence: 'asc' },
        include: { entries: { include: { allocation: true } } },
      })
    ).map((t) => [
      t.type,
      t.amount.toFixed(),
      t.occurredAt.toISOString(),
      t.entries[0].allocation.periodStart?.toISOString(),
    ]);

  beforeAll(async () => {
    harness = await createStripeTestApp();
  });

  afterAll(async () => {
    jest.useRealTimers();
    await harness?.close();
  });

  beforeEach(() => {
    api = new FakeStripeApi(5);
    harness.stripe.api = api;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('missed allocations', () => {
    it('allocates every month missed while the worker was stopped once it restarts, each as of its own start, and records the expiry of the ended ones', async () => {
      const T0 = new Date('2037-01-15T08:00:00.000Z');
      const m = monthStarts(T0);
      const authId = await yearlySubscriber(T0);
      await wallet().debit({ authId, amount: '400', idempotencyKey: 'used' });

      // The worker is down for three billing boundaries.
      const restartedAt = new Date(m[3].getTime() + 10 * DAY);
      freezeTime(restartedAt);
      await harness.restart();
      await scheduler().run();

      const schedule = await scheduleOf(authId);
      expect(schedule.map((s) => s.status)).toEqual([
        ...Array<string>(4).fill('ALLOCATED'),
        ...Array<string>(8).fill('PENDING'),
      ]);
      expect(schedule.slice(1, 4).map((s) => s.processedAt)).toEqual([
        restartedAt,
        restartedAt,
        restartedAt,
      ]);
      // The history reads as if the worker had run on time: each missed
      // month granted at its start and expired at its end.
      expect(await proLedger(authId)).toEqual([
        ['GRANT', '1000', T0.toISOString(), T0.toISOString()],
        ['DEBIT', '-400', T0.toISOString(), T0.toISOString()],
        ['EXPIRATION', '-600', m[1].toISOString(), T0.toISOString()],
        ['GRANT', '1000', m[1].toISOString(), m[1].toISOString()],
        ['EXPIRATION', '-1000', m[2].toISOString(), m[1].toISOString()],
        ['GRANT', '1000', m[2].toISOString(), m[2].toISOString()],
        ['EXPIRATION', '-1000', m[3].toISOString(), m[2].toISOString()],
        ['GRANT', '1000', restartedAt.toISOString(), m[3].toISOString()],
      ]);
      const allocations = await allocationsOf(authId);
      expect(allocations.map((a) => [a.periodStart, a.expiresAt])).toEqual(
        [0, 1, 2, 3].map((k) => [m[k], m[k + 1]]),
      );
      // Only the current month counts.
      await expect(wallet().getBalance(authId)).resolves.toMatchObject({
        available: '1000',
        upcoming: '0',
      });
      await expectConsistentLedger(client(), authId);
    });
  });

  describe('recovery after the worker stops', () => {
    it('rolls back an allocation interrupted half-way and completes it once after the restart', async () => {
      const T0 = new Date('2037-05-20T12:00:00.000Z');
      const m = monthStarts(T0);
      const authId = await yearlySubscriber(T0);

      // The worker writes this user's month, then stops before marking the
      // month as allocated: the whole transaction is rolled back. (The
      // scheduler serves every user; other users' months are unaffected.)
      freezeTime(m[1]);
      const grants = wallet();
      const realGrant = realGrantOf(grants);
      let halted = false;
      jest
        .spyOn(grants, 'grant')
        .mockImplementation(
          async (
            input: GrantCreditsInput,
            options?: WalletOperationOptions,
          ) => {
            const result = await realGrant(input, options);
            if (input.authId === authId && !halted) {
              halted = true;
              throw new Error('worker halted');
            }
            return result;
          },
        );
      await scheduler().run();
      expect(halted).toBe(true);

      const [, interrupted] = await scheduleOf(authId);
      expect(interrupted).toMatchObject({
        status: 'PENDING',
        allocationId: null,
        attempts: 1,
        lastError: 'worker halted',
      });
      await expect(allocationsOf(authId)).resolves.toHaveLength(1);

      freezeTime(new Date(m[1].getTime() + 5 * 60_000));
      await harness.restart();
      await scheduler().run();

      const [, recovered] = await scheduleOf(authId);
      expect(recovered).toMatchObject({ status: 'ALLOCATED', attempts: 1 });
      const allocations = await allocationsOf(authId);
      expect(allocations).toHaveLength(2);
      expect(allocations[1].id).toBe(recovered.allocationId);
      await expect(
        client().creditTransaction.count({ where: { authId, type: 'GRANT' } }),
      ).resolves.toBe(2);
      await expectConsistentLedger(client(), authId);
    });

    it('leaves a month claimed by a halted worker alone, and allocates it once that worker is gone', async () => {
      const T0 = new Date('2037-07-31T06:00:00.000Z');
      const m = monthStarts(T0);
      const authId = await yearlySubscriber(T0);
      const [, month] = await scheduleOf(authId);
      freezeTime(m[1]);

      // Another worker claimed the month and then hung.
      let claimed!: () => void;
      const claimedOnce = new Promise<void>((resolve) => (claimed = resolve));
      let die!: () => void;
      const hung = client()
        .$transaction(
          async (tx) => {
            await tx.$queryRaw`
              SELECT "id" FROM "CreditAllocationSchedule" WHERE "id" = ${month.id} FOR UPDATE
            `;
            claimed();
            await new Promise<void>((resolve) => (die = resolve));
            throw new Error('worker killed');
          },
          { timeout: 60_000 },
        )
        .catch(() => undefined);
      await claimedOnce;

      // Workers do not wait for a month another worker holds.
      const started = performance.now();
      await scheduler().run();
      expect(performance.now() - started).toBeLessThan(5_000);
      await expect(allocationsOf(authId)).resolves.toHaveLength(1);
      expect((await scheduleOf(authId))[1].status).toBe('PENDING');

      die();
      await hung;
      await scheduler().run();

      expect((await scheduleOf(authId))[1].status).toBe('ALLOCATED');
      await expect(allocationsOf(authId)).resolves.toHaveLength(2);
    });

    it('after a restart in the middle of a run, allocates only the months that were not finished', async () => {
      const T0 = new Date('2038-02-10T10:00:00.000Z');
      const m = monthStarts(T0);
      const users = [
        await yearlySubscriber(T0),
        await yearlySubscriber(T0),
        await yearlySubscriber(T0),
      ];
      freezeTime(m[1]);
      const grants = wallet();
      const realGrant = realGrantOf(grants);
      jest
        .spyOn(grants, 'grant')
        .mockImplementation(
          (input: GrantCreditsInput, options?: WalletOperationOptions) =>
            input.authId === users[1]
              ? Promise.reject(new Error('worker halted'))
              : realGrant(input, options),
        );
      await scheduler().run();
      expect(
        await Promise.all(
          users.map(async (u) => (await allocationsOf(u)).length),
        ),
      ).toEqual([2, 1, 2]);

      jest.restoreAllMocks();
      await harness.restart();
      await scheduler().run();

      expect(
        await Promise.all(
          users.map(async (u) => (await allocationsOf(u)).length),
        ),
      ).toEqual([2, 2, 2]);
      for (const u of users) {
        await expect(
          client().creditTransaction.count({
            where: { authId: u, type: 'GRANT' },
          }),
        ).resolves.toBe(2);
      }
    });
  });

  describe('idempotency', () => {
    it('allocates a month once under repeated runs, concurrent workers on separate connections and user requests', async () => {
      const T0 = new Date('2038-06-30T23:00:00.000Z');
      const m = monthStarts(T0);
      const authId = await yearlySubscriber(T0);
      freezeTime(m[1]);

      // A second worker process: its own connection pool and services.
      const [{ schema }] = await client().$queryRaw<{ schema: string }[]>`
        SELECT current_schema() AS "schema"
      `;
      const otherClient = new PrismaClient({
        adapter: new PrismaPg(
          {
            connectionString: TEST_DATABASE_URL as string,
            options: `-c search_path=${schema}`,
          },
          { schema },
        ),
      });
      try {
        const prisma = otherClient as unknown as PrismaService;
        const logger = mock<CustomLoggerService>();
        const settings = new CreditSettingsService(
          prisma,
          new ActivityLogService(prisma, logger),
          logger,
        );
        const otherAllowances = new CreditAllowanceService(
          prisma,
          new CreditWalletService(prisma, settings),
          settings,
        );
        const appAllowances = harness.app.get(CreditAllowanceService);
        const eligibility = harness.app.get(CreditEligibilityService);

        await Promise.all([
          ...Array.from({ length: 3 }, () =>
            new CreditAllocationScheduler(appAllowances, logger).run(),
          ),
          ...Array.from({ length: 3 }, () =>
            new CreditAllocationScheduler(otherAllowances, logger).run(),
          ),
          eligibility.getEligibility(authId),
          eligibility.getEligibility(authId),
        ]);
        for (let i = 0; i < 3; i += 1) await scheduler().run();
      } finally {
        await otherClient.$disconnect();
      }

      const schedule = await scheduleOf(authId);
      expect(schedule.filter((s) => s.status === 'ALLOCATED')).toHaveLength(2);
      const allocations = await allocationsOf(authId);
      expect(allocations).toHaveLength(2);
      expect(allocations[1]).toMatchObject({
        id: schedule[1].allocationId,
        periodStart: m[1],
        expiresAt: m[2],
      });
      expect(allocations[1].amount.toFixed()).toBe('1000');
      await expect(
        client().creditTransaction.count({ where: { authId, type: 'GRANT' } }),
      ).resolves.toBe(2);
      await expect(wallet().getBalance(authId)).resolves.toMatchObject({
        available: '1000',
      });
      await expectConsistentLedger(client(), authId);
    });

    it('links credits that already exist for a month (granted under another reference) instead of failing or granting them again', async () => {
      const T0 = new Date('2038-06-15T00:00:00.000Z');
      const months = monthStarts(T0);
      const authId = await yearlySubscriber(T0);
      const second = (await scheduleOf(authId))[1];

      // Month 2's credits were granted by other means (e.g. an earlier
      // release) before the scheduler reached the month.
      freezeTime(months[1]);
      const earlier = await wallet().grant({
        authId,
        source: CreditSource.SUBSCRIPTION,
        sourceReference: 'granted-earlier',
        amount: 1000,
        expiresAt: second.periodEnd,
        payment: {
          subscriptionId: second.subscriptionId,
          paymentId: second.paymentId,
          periodStart: second.periodStart,
        },
      });
      await scheduler().run();
      await scheduler().run();

      const schedule = await scheduleOf(authId);
      expect(schedule[1]).toMatchObject({
        status: 'ALLOCATED',
        allocationId: earlier.allocation.id,
        attempts: 0,
        lastError: null,
      });
      await expect(allocationsOf(authId)).resolves.toHaveLength(2);
      await expect(wallet().getBalance(authId)).resolves.toMatchObject({
        available: '1000',
      });
      await expectConsistentLedger(client(), authId);
    });

    it('has PostgreSQL refuse to schedule or allocate a month twice, or to reopen an allocated month', async () => {
      const T0 = new Date('2038-09-01T00:00:00.000Z');
      const authId = await yearlySubscriber(T0);
      const [first] = await scheduleOf(authId);

      await expect(
        client().creditAllocationSchedule.update({
          where: { id: first.id },
          data: { status: 'PENDING', allocationId: null, processedAt: null },
        }),
      ).rejects.toThrow('already ALLOCATED');
      await expect(
        client().creditAllocationSchedule.create({
          data: {
            authId,
            subscriptionId: first.subscriptionId,
            paymentId: first.paymentId,
            periodStart: first.periodStart,
            periodEnd: first.periodEnd,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      await expect(
        wallet().grant({
          authId,
          source: CreditSource.SUBSCRIPTION,
          sourceReference: 'again',
          amount: 1000,
          expiresAt: first.periodEnd,
          payment: {
            subscriptionId: first.subscriptionId,
            paymentId: first.paymentId,
            periodStart: first.periodStart,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      await expect(allocationsOf(authId)).resolves.toHaveLength(1);
    });
  });
});
