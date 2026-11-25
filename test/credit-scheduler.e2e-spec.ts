import { BillingInterval } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import type { CustomLoggerService } from '../src/common/services/custom-logger.service';
import type { PrismaService } from '../src/common/services/prisma.service';
import { addMonthsClamped } from '../src/credit/credit-subscription.policy';
import { CreditWalletService } from '../src/credit/credit-wallet.service';
import { addBillingInterval } from '../src/subscription/billing.validation';
import { SubscriptionCreditSchedulerService } from '../src/subscription/subscription-credit-scheduler.service';
import { FakeStripeApi } from './support/fake-stripe-api';
import { freezeTime } from './support/freeze-time';
import { describeWithDatabase } from './support/migrated-schema';
import { createUser } from './support/subscription-fixtures';
import {
  createStripeTestApp,
  dataOf,
  type StripeTestApp,
} from './support/stripe-test-app';

jest.setTimeout(120_000);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Yearly subscriptions bought at T0; month k of the paid year starts at month(k). */
const T0 = new Date('2026-06-01T10:00:00.000Z');
const month = (k: number) => addMonthsClamped(T0, k);
const after = (at: Date, ms: number) => new Date(at.getTime() + ms);

interface GrantRow {
  periodIndex: number;
  periodStartsAt: Date;
  expiresAt: Date;
  grantedAt: Date;
  granted: string;
}

/**
 * The monthly grant scheduler for yearly subscriptions under failure:
 * months missed while the worker was stopped, a run halted part-way, a
 * grant whose database session is killed mid-transaction, and repeated or
 * concurrent runs. "Restart" boots a new application (new Nest app and
 * Prisma connection pool on the same PostgreSQL schema) with scheduling
 * enabled, so the scheduler's own startup catch-up does the work. Time is
 * controlled with a frozen clock; Stripe is FakeStripeApi.
 */
describeWithDatabase(
  'Monthly credit scheduler (PostgreSQL, restarts, controlled time)',
  () => {
    let harness: StripeTestApp;
    let api: FakeStripeApi;

    beforeAll(async () => {
      harness = await createStripeTestApp();
    });

    afterAll(async () => {
      jest.useRealTimers();
      process.env.NODE_ENV = 'test';
      await harness?.close();
    });

    beforeEach(() => {
      jest.useRealTimers();
      api = new FakeStripeApi(5);
      harness.stripe.api = api;
    });

    afterEach(async () => {
      jest.useRealTimers();
      await harness.client.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS "test_worker_failure" ON "CreditAllocation"',
      );
      // Stop the schedulers' timers again: back to a test-mode application.
      if (process.env.NODE_ENV !== 'test') {
        process.env.NODE_ENV = 'test';
        await harness.restart();
      }
    });

    const scheduler = () =>
      harness.app.get(SubscriptionCreditSchedulerService, { strict: false });

    /**
     * Polls `check` until it holds (or fails after `timeoutMs`). Measured with
     * performance.now(): Date is frozen by the controlled clock. The timeout
     * is far below the schedulers' 60 s interval, so only their startup runs
     * can satisfy a check.
     */
    const eventually = async (
      check: () => Promise<boolean>,
      what: string,
      timeoutMs = 15_000,
    ) => {
      const deadline = performance.now() + timeoutMs;
      while (!(await check())) {
        if (performance.now() > deadline) throw new Error(`Timed out: ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };

    /**
     * Stops the application and starts it again at `at` with the schedulers
     * enabled (as in production): the startup runs catch up on their own.
     */
    const restartWorkerAt = async (at: Date) => {
      freezeTime(at);
      process.env.NODE_ENV = 'production';
      await harness.restart();
    };

    /** Buys yearly Pro at T0 through checkout and the signed webhook. */
    const subscribeYearly = async () => {
      const userId = await createUser(harness.client);
      freezeTime(T0);
      const started = await harness.startCheckout(userId, 'YEARLY').expect(201);
      const checkout = await harness.client.checkoutSession.findUniqueOrThrow({
        where: { id: dataOf(started).checkoutSessionId },
      });
      const sessionId = checkout.providerSessionId as string;
      api.completeSession(sessionId, { periodStart: T0 });
      const event = api.signedEvent('checkout.session.completed', sessionId);
      await harness.sendWebhook(event.payload, event.signature).expect(200);
      jest.useRealTimers();
      const payment = await harness.client.paymentTransaction.findFirstOrThrow({
        where: { subscription: { authId: userId } },
      });
      expect(payment).toMatchObject({
        billingInterval: 'YEARLY',
        periodStart: T0,
        periodEnd: addBillingInterval(T0, BillingInterval.YEARLY),
      });
      return { userId, paymentId: payment.id };
    };

    const grantsOf = (userId: string) =>
      harness.client.$queryRaw<GrantRow[]>`
        SELECT a."periodIndex", a."periodStartsAt", a."expiresAt", a."grantedAt",
               a."grantedCredits"::text AS granted
        FROM "CreditAllocation" a JOIN "CreditWallet" w ON w."id" = a."walletId"
        WHERE w."authId" = ${userId} AND a."source" = 'SUBSCRIPTION'
        ORDER BY a."periodIndex"`;
    const monthsOf = async (userId: string) =>
      (await grantsOf(userId)).map((g) => g.periodIndex);
    const ledgerOf = (userId: string) =>
      harness.client.$queryRaw<
        { type: string; amount: string; effectiveAt: Date }[]
      >`
        SELECT t."type"::text AS type, t."amountCredits"::text AS amount, t."effectiveAt"
        FROM "CreditTransaction" t JOIN "CreditWallet" w ON w."id" = t."walletId"
        WHERE w."authId" = ${userId} ORDER BY t."sequence"`;

    /** Makes the worker fail while granting these payments (a crash). */
    const failGrantsFor = (paymentIds: string[]) =>
      harness.client.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION "test_worker_failure"() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW."paymentId" IN (${paymentIds.map((id) => `'${id}'`).join(', ')}) THEN
            RAISE EXCEPTION 'worker halted';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER "test_worker_failure" BEFORE INSERT ON "CreditAllocation"
          FOR EACH ROW EXECUTE FUNCTION "test_worker_failure"();`);

    it('grants the month that is due after a restart when the worker was stopped across month starts', async () => {
      const a = await subscribeYearly();
      const b = await subscribeYearly();
      expect(await monthsOf(a.userId)).toEqual([0]);

      // The worker is down from month 1 to the middle of month 3.
      const restartAt = after(month(3), 10 * DAY);
      await restartWorkerAt(restartAt);
      await eventually(
        async () =>
          (await monthsOf(a.userId)).includes(3) &&
          (await monthsOf(b.userId)).includes(3),
        'the startup catch-up grant',
      );

      for (const user of [a, b]) {
        const grants = await grantsOf(user.userId);
        // Months 1 and 2 ended during the outage; their credits would have
        // expired already, so only the month that is due is granted.
        expect(grants.map((g) => g.periodIndex)).toEqual([0, 3]);
        expect(grants[1]).toMatchObject({
          periodStartsAt: month(3),
          expiresAt: month(4),
          grantedAt: restartAt,
          granted: '1000.000000',
        });
      }
      // The startup expiry sweep logged month 0's expiry at its end.
      await eventually(
        async () =>
          (await ledgerOf(a.userId)).some((t) => t.type === 'EXPIRATION'),
        'the startup expiry sweep',
      );
      await expect(ledgerOf(a.userId)).resolves.toEqual([
        expect.objectContaining({ type: 'ALLOCATION', effectiveAt: T0 }),
        expect.objectContaining({
          type: 'EXPIRATION',
          amount: '-1000.000000',
          effectiveAt: month(1),
        }),
        expect.objectContaining({ type: 'ALLOCATION', effectiveAt: restartAt }),
      ]);

      // Another restart in the same month grants nothing more.
      await restartWorkerAt(after(restartAt, HOUR));
      await eventually(
        async () => (await scheduler().run(after(restartAt, HOUR))) !== null,
        'the startup run to finish',
      );
      expect(await monthsOf(a.userId)).toEqual([0, 3]);
      expect(await monthsOf(b.userId)).toEqual([0, 3]);
    });

    it('finishes a run that was halted part-way after the restart, without duplicating what was granted', async () => {
      const users = [
        await subscribeYearly(),
        await subscribeYearly(),
        await subscribeYearly(),
      ];
      const [first, ...rest] = [...users].sort((x, y) =>
        x.paymentId < y.paymentId ? -1 : 1,
      );

      // The worker grants the first user's month 1, then halts.
      await failGrantsFor(rest.map((u) => u.paymentId));
      const halted = await scheduler().run(after(month(1), MINUTE));
      // (Other tests' subscribers in this schema may be granted too.)
      expect(halted?.failed).toBe(2);
      expect(await monthsOf(first.userId)).toEqual([0, 1]);
      for (const user of rest) {
        // Nothing partial: no allocation and no ledger rows were left behind.
        expect(await monthsOf(user.userId)).toEqual([0]);
        await expect(ledgerOf(user.userId)).resolves.toHaveLength(1);
      }

      // Restart later in month 1: the missed grants are made, once.
      await harness.client.$executeRawUnsafe(
        'DROP TRIGGER "test_worker_failure" ON "CreditAllocation"',
      );
      const restartAt = after(month(1), 6 * HOUR);
      await restartWorkerAt(restartAt);
      await eventually(
        async () =>
          (await Promise.all(rest.map((u) => monthsOf(u.userId)))).every(
            (months) => months.includes(1),
          ),
        'the missed grants after the restart',
      );
      for (const user of users) {
        expect(await monthsOf(user.userId)).toEqual([0, 1]);
      }
      expect((await grantsOf(first.userId))[1].grantedAt).toEqual(
        after(month(1), MINUTE),
      );
      for (const user of rest) {
        expect((await grantsOf(user.userId))[1].grantedAt).toEqual(restartAt);
      }
    });

    it("leaves nothing behind when a grant's database session is killed mid-transaction, and grants it after the restart", async () => {
      const user = await subscribeYearly();
      const before = await ledgerOf(user.userId);
      // The grant stalls inside its transaction (after expiring month 0 and
      // while inserting month 1), and its database session is then killed,
      // as when the worker process dies.
      await harness.client.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION "test_worker_failure"() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW."paymentId" = '${user.paymentId}' THEN PERFORM pg_sleep(30); END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER "test_worker_failure" BEFORE INSERT ON "CreditAllocation"
          FOR EACH ROW EXECUTE FUNCTION "test_worker_failure"();`);

      const grant = scheduler().grantDueMonth(
        user.paymentId,
        after(month(1), MINUTE),
      );
      grant.catch(() => undefined);
      let pid: number | undefined;
      await eventually(async () => {
        const rows = await harness.client.$queryRaw<{ pid: number }[]>`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event = 'PgSleep'`;
        pid = rows[0]?.pid;
        return pid !== undefined;
      }, 'the stalled grant');
      await harness.client.$queryRaw`SELECT pg_terminate_backend(${pid}::int)`;
      await expect(grant).rejects.toThrow();

      await expect(monthsOf(user.userId)).resolves.toEqual([0]);
      await expect(ledgerOf(user.userId)).resolves.toEqual(before);

      await harness.client.$executeRawUnsafe(
        'DROP TRIGGER "test_worker_failure" ON "CreditAllocation"',
      );
      await restartWorkerAt(after(month(1), HOUR));
      await eventually(
        async () => (await monthsOf(user.userId)).includes(1),
        'the grant after the restart',
      );
      await expect(ledgerOf(user.userId)).resolves.toMatchObject([
        { type: 'ALLOCATION' },
        { type: 'EXPIRATION', effectiveAt: month(1) },
        { type: 'ALLOCATION', effectiveAt: after(month(1), HOUR) },
      ]);
    });

    it('never duplicates a month across repeated runs, concurrent instances and restarts', async () => {
      const users = [await subscribeYearly(), await subscribeYearly()];
      const now = after(month(1), MINUTE);

      // Two worker instances (separate services on the same database), each
      // running several times at once. The second instance is always built
      // on the current application's connection pool.
      const otherWorker = () =>
        new SubscriptionCreditSchedulerService(
          harness.client as unknown as PrismaService,
          harness.app.get(CreditWalletService, { strict: false }),
          mock<CustomLoggerService>(),
        );
      const other = otherWorker();
      const results = await Promise.all([
        scheduler().run(now),
        other.run(now),
        ...users.flatMap((u) => [
          scheduler().grantDueMonth(u.paymentId, now),
          other.grantDueMonth(u.paymentId, now),
        ]),
      ]);
      expect(results.length).toBe(6);
      await scheduler().run(now);
      await other.run(after(now, HOUR));

      // Two restarts later in the same month.
      await restartWorkerAt(after(now, 2 * HOUR));
      await restartWorkerAt(after(now, 3 * HOUR));
      await eventually(
        async () => (await scheduler().run(after(now, 3 * HOUR))) !== null,
        'the startup run to finish',
      );
      for (const user of users) {
        const grants = await grantsOf(user.userId);
        expect(grants.map((g) => g.periodIndex)).toEqual([0, 1]);
        expect(grants[1].grantedAt.getTime()).toBeLessThan(
          after(now, HOUR).getTime(),
        );
      }

      // The next month is granted exactly once as well.
      await restartWorkerAt(after(month(2), MINUTE));
      await eventually(
        async () =>
          (await Promise.all(users.map((u) => monthsOf(u.userId)))).every(
            (months) => months.includes(2),
          ),
        'month 2 after the restart',
      );
      await Promise.all([
        scheduler().run(after(month(2), MINUTE)),
        otherWorker().run(after(month(2), MINUTE)),
      ]);
      for (const user of users) {
        expect(await monthsOf(user.userId)).toEqual([0, 1, 2]);
      }
    });
  },
);
