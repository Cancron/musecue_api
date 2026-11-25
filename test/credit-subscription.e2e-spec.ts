import { BillingInterval } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import request from 'supertest';
import { UserRole } from '../src/auth/interfaces/auth.interface';
import { AuthUtilsService } from '../src/auth/services/auth-utils.service';
import { CreditExpirySweepService } from '../src/credit/credit-expiry-sweep.service';
import { addMonthsClamped } from '../src/credit/credit-subscription.policy';
import { CreditWalletService } from '../src/credit/credit-wallet.service';
import { RateLimitStore } from '../src/infrastructure/rate-limit/rate-limit.store';
import { addBillingInterval } from '../src/subscription/billing.validation';
import { SubscriptionCreditSchedulerService } from '../src/subscription/subscription-credit-scheduler.service';
import { FakeStripeApi } from './support/fake-stripe-api';
import { freezeTime } from './support/freeze-time';
import { describeWithDatabase } from './support/migrated-schema';
import {
  createUser,
  DAY_MS,
  recordPayment,
} from './support/subscription-fixtures';
import {
  createStripeTestApp,
  dataOf,
  type StripeTestApp,
} from './support/stripe-test-app';

jest.setTimeout(120_000);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Billing boundaries of a monthly subscription bought at T0. */
const T0 = new Date('2026-06-01T10:00:00.000Z');
const T1 = addBillingInterval(T0, BillingInterval.MONTHLY); // 2026-07-01
const T2 = addBillingInterval(T1, BillingInterval.MONTHLY); // 2026-08-01
const T3 = addBillingInterval(T2, BillingInterval.MONTHLY); // 2026-09-01
const after = (at: Date, ms: number) => new Date(at.getTime() + ms);

/** A SUBSCRIPTION allocation with its payment, read with SQL. */
interface ProAllocationRow {
  sourceReference: string;
  granted: string;
  remaining: string;
  periodIndex: number;
  periodStartsAt: Date;
  expiresAt: Date;
  expiredAt: Date | null;
  grantedAt: Date;
  subscriptionId: string;
  paymentId: string;
  allocationOwner: string;
  paymentStatus: string;
  providerPaymentId: string;
  paymentPeriodStart: Date;
  paymentPeriodEnd: Date;
  paymentSubscriptionId: string;
}
interface LedgerRow {
  sequence: number;
  type: string;
  source: string | null;
  amount: string;
  balanceAfter: string;
  effectiveAt: Date;
}

/**
 * Pro credits end to end, monthly and annual subscriptions: checkout,
 * renewals, failed payments, refunds, the monthly grant scheduler and
 * signed Stripe webhooks over the real HTTP stack on a migrated PostgreSQL
 * schema, with Stripe replaced by FakeStripeApi (behind the real SDK) and
 * `Date` frozen at controlled points around the billing boundaries.
 */
describeWithDatabase(
  'Monthly Pro credits (PostgreSQL, HTTP, Stripe faked, controlled time)',
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
      await harness.client.$executeRaw`
        UPDATE "CreditSettings" SET "proMonthlyAllowanceCredits" = DEFAULT`;
    });

    afterEach(() => jest.useRealTimers());

    // ------------------------------------------------------------------
    // Stripe flows at controlled times
    // ------------------------------------------------------------------

    /** Buys Pro at `at` (checkout + signed webhook); monthly by default. */
    const subscribe = async (
      userId: string,
      at: Date,
      interval: 'MONTHLY' | 'YEARLY' = 'MONTHLY',
    ) => {
      freezeTime(at);
      const started = await harness.startCheckout(userId, interval).expect(201);
      const checkout = await harness.client.checkoutSession.findUniqueOrThrow({
        where: { id: dataOf(started).checkoutSessionId },
      });
      const sessionId = checkout.providerSessionId as string;
      const session = api.completeSession(sessionId, { periodStart: at });
      const event = api.signedEvent('checkout.session.completed', sessionId);
      await harness.sendWebhook(event.payload, event.signature).expect(200);
      jest.useRealTimers();
      return {
        sessionId,
        checkoutEvent: event,
        stripeSubscriptionId: session.subscription as string,
        firstInvoiceId: session.invoice as string,
      };
    };

    /** Signs and delivers an invoice event at `at`; returns it for replays. */
    const deliverInvoice = async (
      type: string,
      invoiceId: string,
      at: Date,
    ) => {
      freezeTime(at);
      const event = api.signedInvoiceEvent(type, invoiceId);
      await harness.sendWebhook(event.payload, event.signature).expect(200);
      jest.useRealTimers();
      return event;
    };

    /** Replays an already signed event at `at` (within Stripe's tolerance). */
    const redeliver = async (
      event: { payload: string; signature: string },
      at: Date,
    ) => {
      freezeTime(at);
      await harness.sendWebhook(event.payload, event.signature).expect(200);
      jest.useRealTimers();
    };

    const setProAllowance = async (credits: number) => {
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
      await request(harness.app.getHttpServer())
        .patch('/v1/admin/credit-settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ proMonthlyAllowanceCredits: credits })
        .expect(200);
    };

    // ------------------------------------------------------------------
    // PostgreSQL records
    // ------------------------------------------------------------------

    const proAllocationsOf = (userId: string) =>
      harness.client.$queryRaw<ProAllocationRow[]>`
        SELECT a."sourceReference", a."grantedCredits"::text AS granted,
               a."remainingCredits"::text AS remaining, a."periodIndex", a."periodStartsAt",
               a."expiresAt", a."expiredAt", a."grantedAt", a."subscriptionId",
               a."paymentId", w."authId" AS "allocationOwner",
               p."status"::text AS "paymentStatus", p."providerPaymentId",
               p."periodStart" AS "paymentPeriodStart", p."periodEnd" AS "paymentPeriodEnd",
               p."subscriptionId" AS "paymentSubscriptionId"
        FROM "CreditAllocation" a
        JOIN "CreditWallet" w ON w."id" = a."walletId"
        JOIN "PaymentTransaction" p ON p."id" = a."paymentId"
        WHERE w."authId" = ${userId} AND a."source" = 'SUBSCRIPTION'
        ORDER BY a."periodStartsAt"`;
    const ledgerOf = (userId: string) =>
      harness.client.$queryRaw<LedgerRow[]>`
        SELECT t."sequence", t."type"::text AS type, a."source"::text AS source,
               t."amountCredits"::text AS amount,
               t."balanceAfterCredits"::text AS "balanceAfter", t."effectiveAt"
        FROM "CreditTransaction" t
        JOIN "CreditWallet" w ON w."id" = t."walletId"
        LEFT JOIN "CreditAllocation" a ON a."id" = t."allocationId"
        WHERE w."authId" = ${userId}
        ORDER BY t."sequence"`;
    const subscriptionOf = (userId: string) =>
      harness.client.userSubscription.findUniqueOrThrow({
        where: { authId: userId },
        include: { payments: { orderBy: { periodStart: 'asc' } } },
      });
    const grantInPostgres = (
      userId: string,
      source: 'PURCHASE' | 'REFERRAL',
      credits: number,
    ) =>
      harness.client.$queryRaw`
        SELECT "Credit_grant_manual"(${userId}, ${source}::"CreditSource", ${`${source}:${userId}`}, ${credits})`;

    // ------------------------------------------------------------------

    describe('initial purchase', () => {
      it('allocates the default 1000 credits for the first paid month, linked to user, subscription, payment and period', async () => {
        const userId = await createUser(harness.client);

        const { firstInvoiceId } = await subscribe(userId, T0);

        const subscription = await subscriptionOf(userId);
        const [payment] = subscription.payments;
        expect(payment).toMatchObject({
          status: 'SUCCEEDED',
          providerPaymentId: firstInvoiceId,
          periodStart: T0,
          periodEnd: T1,
        });
        await expect(proAllocationsOf(userId)).resolves.toEqual([
          {
            sourceReference: `pro:${payment.id}`,
            granted: '1000.000000',
            remaining: '1000.000000',
            periodIndex: 0,
            periodStartsAt: T0,
            expiresAt: T1,
            expiredAt: null,
            grantedAt: T0,
            subscriptionId: subscription.id,
            paymentId: payment.id,
            allocationOwner: userId,
            paymentStatus: 'SUCCEEDED',
            providerPaymentId: firstInvoiceId,
            paymentPeriodStart: T0,
            paymentPeriodEnd: T1,
            paymentSubscriptionId: subscription.id,
          },
        ]);
        await expect(ledgerOf(userId)).resolves.toEqual([
          {
            sequence: 1,
            type: 'ALLOCATION',
            source: 'SUBSCRIPTION',
            amount: '1000.000000',
            balanceAfter: '1000.000000',
            effectiveAt: T0,
          },
        ]);
        await expect(
          wallets.getBalance(userId, after(T0, DAY_MS)),
        ).resolves.toMatchObject({
          availableCredits: '1000',
          availableBySource: { SUBSCRIPTION: '1000' },
          nextExpiration: { expiresAt: T1.toISOString(), credits: '1000' },
        });
      });

      it('allocates the amount configured by the administrator', async () => {
        await setProAllowance(2500);
        const userId = await createUser(harness.client);

        await subscribe(userId, T0);

        await expect(proAllocationsOf(userId)).resolves.toMatchObject([
          { granted: '2500.000000', periodStartsAt: T0, expiresAt: T1 },
        ]);
      });
    });

    describe('successful renewals', () => {
      it('allocates a fresh month for each payment and expires the previous month at the billing boundary, keeping purchased and referral credits', async () => {
        const userId = await createUser(harness.client);
        const { stripeSubscriptionId } = await subscribe(userId, T0);
        await grantInPostgres(userId, 'PURCHASE', 20);
        await grantInPostgres(userId, 'REFERRAL', 5);
        await wallets.deduct({
          authId: userId,
          credits: '250.5',
          idempotencyKey: 'ai-run-month-1',
          now: after(T0, 5 * DAY_MS),
        });

        // The allowance changes during month 1: it applies from the renewal.
        await setProAllowance(1500);
        const renewal1 = api.renewSubscription(stripeSubscriptionId)
          .id as string;
        await deliverInvoice('invoice.paid', renewal1, after(T1, MINUTE));

        await setProAllowance(1000);
        const renewal2 = api.renewSubscription(stripeSubscriptionId)
          .id as string;
        await deliverInvoice('invoice.paid', renewal2, after(T2, MINUTE));

        const subscription = await subscriptionOf(userId);
        expect(
          subscription.payments.map((p) => [
            p.providerPaymentId,
            p.periodStart,
            p.periodEnd,
          ]),
        ).toEqual([
          [expect.any(String), T0, T1],
          [renewal1, T1, T2],
          [renewal2, T2, T3],
        ]);
        const allocations = await proAllocationsOf(userId);
        expect(
          allocations.map((a) => ({
            granted: a.granted,
            remaining: a.remaining,
            period: [a.periodStartsAt, a.expiresAt],
            expiredAt: a.expiredAt,
            paymentId: a.paymentId,
            subscriptionId: a.subscriptionId,
          })),
        ).toEqual([
          {
            granted: '1000.000000',
            remaining: '0.000000',
            period: [T0, T1],
            expiredAt: after(T1, MINUTE),
            paymentId: subscription.payments[0].id,
            subscriptionId: subscription.id,
          },
          {
            granted: '1500.000000',
            remaining: '0.000000',
            period: [T1, T2],
            expiredAt: after(T2, MINUTE),
            paymentId: subscription.payments[1].id,
            subscriptionId: subscription.id,
          },
          {
            granted: '1000.000000',
            remaining: '1000.000000',
            period: [T2, T3],
            expiredAt: null,
            paymentId: subscription.payments[2].id,
            subscriptionId: subscription.id,
          },
        ]);
        // Every allocation matches its own payment's period.
        for (const a of allocations) {
          expect([a.periodStartsAt, a.expiresAt]).toEqual([
            a.paymentPeriodStart,
            a.paymentPeriodEnd,
          ]);
        }

        const ledger = await ledgerOf(userId);
        expect(
          ledger.map((t) => [t.type, t.source, t.amount, t.effectiveAt]),
        ).toEqual([
          ['ALLOCATION', 'SUBSCRIPTION', '1000.000000', T0],
          ['ALLOCATION', 'PURCHASE', '20.000000', expect.any(Date)],
          ['ALLOCATION', 'REFERRAL', '5.000000', expect.any(Date)],
          ['DEDUCTION', null, '-250.500000', after(T0, 5 * DAY_MS)],
          // Month 1's unused credits expire at the boundary T1...
          ['EXPIRATION', 'SUBSCRIPTION', '-749.500000', T1],
          // ...and month 2 starts with a fresh allocation.
          ['ALLOCATION', 'SUBSCRIPTION', '1500.000000', after(T1, MINUTE)],
          ['EXPIRATION', 'SUBSCRIPTION', '-1500.000000', T2],
          ['ALLOCATION', 'SUBSCRIPTION', '1000.000000', after(T2, MINUTE)],
        ]);
        expect(ledger[ledger.length - 1].balanceAfter).toBe('1025.000000');

        await expect(
          wallets.getBalance(userId, after(T2, DAY_MS)),
        ).resolves.toMatchObject({
          availableCredits: '1025',
          availableBySource: {
            TRIAL: '0',
            SUBSCRIPTION: '1000',
            PURCHASE: '20',
            REFERRAL: '5',
          },
        });
      });

      it('keeps the credits of the ending month valid until the boundary when the renewal is paid early', async () => {
        const userId = await createUser(harness.client);
        const { stripeSubscriptionId } = await subscribe(userId, T0);
        const renewal = api.renewSubscription(stripeSubscriptionId)
          .id as string;

        // Stripe collects the renewal a minute before the boundary.
        await deliverInvoice('invoice.paid', renewal, after(T1, -MINUTE));

        await expect(
          wallets.getBalance(userId, after(T1, -1)),
        ).resolves.toMatchObject({ availableCredits: '2000' });
        await expect(wallets.getBalance(userId, T1)).resolves.toMatchObject({
          availableCredits: '1000',
        });
        await sweeper.sweep(after(T1, 2 * MINUTE));
        await expect(ledgerOf(userId)).resolves.toMatchObject([
          { type: 'ALLOCATION', effectiveAt: T0 },
          { type: 'ALLOCATION', effectiveAt: after(T1, -MINUTE) },
          { type: 'EXPIRATION', amount: '-1000.000000', effectiveAt: T1 },
        ]);
      });
    });

    describe('failed payments', () => {
      it('allocates nothing for failed attempts; the month still ends at the boundary; the recovered payment allocates once', async () => {
        const userId = await createUser(harness.client);
        const { stripeSubscriptionId } = await subscribe(userId, T0);

        const invoice = api.renewSubscription(stripeSubscriptionId, {
          paid: false,
        }).id as string;
        await deliverInvoice(
          'invoice.payment_failed',
          invoice,
          after(T1, MINUTE),
        );
        // Stripe's automatic retry fails too.
        freezeTime(after(T1, 3 * DAY_MS));
        api.failInvoiceAttempt(invoice);
        jest.useRealTimers();
        await deliverInvoice(
          'invoice.payment_failed',
          invoice,
          after(T1, 3 * DAY_MS),
        );

        // The failures were processed (past due), but nothing was paid.
        await expect(subscriptionOf(userId)).resolves.toMatchObject({
          pastDueSince: expect.any(Date) as unknown,
        });
        await expect(proAllocationsOf(userId)).resolves.toHaveLength(1);
        await expect(
          harness.client.paymentTransaction.count({
            where: { providerPaymentId: invoice, status: 'SUCCEEDED' },
          }),
        ).resolves.toBe(0);
        // No new credits; the unpaid month's predecessor expired at T1.
        await sweeper.sweep(after(T1, 3 * DAY_MS));
        await expect(
          wallets.getBalance(userId, after(T1, 3 * DAY_MS)),
        ).resolves.toMatchObject({ availableCredits: '0' });
        await expect(ledgerOf(userId)).resolves.toMatchObject([
          { type: 'ALLOCATION', amount: '1000.000000' },
          { type: 'EXPIRATION', amount: '-1000.000000', effectiveAt: T1 },
        ]);

        // The card is updated and Stripe collects the invoice on day 5.
        api.payInvoice(invoice);
        const paid = await deliverInvoice(
          'invoice.paid',
          invoice,
          after(T1, 5 * DAY_MS),
        );
        // Stripe delivers the same event again: nothing changes.
        await redeliver(paid, after(T1, 5 * DAY_MS + MINUTE));

        const allocations = await proAllocationsOf(userId);
        expect(allocations).toHaveLength(2);
        expect(allocations[1]).toMatchObject({
          granted: '1000.000000',
          remaining: '1000.000000',
          providerPaymentId: invoice,
          paymentStatus: 'SUCCEEDED',
          periodStartsAt: T1,
          expiresAt: T2,
          grantedAt: after(T1, 5 * DAY_MS),
        });
        await expect(ledgerOf(userId)).resolves.toHaveLength(3);
      });

      it('allocates nothing when the first payment fails', async () => {
        const userId = await createUser(harness.client);
        freezeTime(T0);
        const started = await harness
          .startCheckout(userId, 'MONTHLY')
          .expect(201);
        const checkout = await harness.client.checkoutSession.findUniqueOrThrow(
          {
            where: { id: dataOf(started).checkoutSessionId },
          },
        );
        const sessionId = checkout.providerSessionId as string;
        api.completeSession(sessionId, {
          periodStart: T0,
          paymentStatus: 'unpaid',
        });
        const completed = api.signedEvent(
          'checkout.session.completed',
          sessionId,
        );
        await harness
          .sendWebhook(completed.payload, completed.signature)
          .expect(200);
        const failed = api.signedEvent(
          'checkout.session.async_payment_failed',
          sessionId,
        );
        await harness.sendWebhook(failed.payload, failed.signature).expect(200);
        jest.useRealTimers();

        // The failure was processed: no Pro, no successful payment.
        await expect(
          harness.client.checkoutSession.findUniqueOrThrow({
            where: { id: checkout.id },
          }),
        ).resolves.toMatchObject({ status: 'FAILED' });
        const subscription = await subscriptionOf(userId);
        expect(subscription.proStartedAt).toBeNull();
        expect(
          subscription.payments.filter((p) => p.status === 'SUCCEEDED'),
        ).toEqual([]);
        await expect(proAllocationsOf(userId)).resolves.toEqual([]);
        await expect(ledgerOf(userId)).resolves.toEqual([]);
      });
    });

    describe('duplicated events and idempotency', () => {
      it('allocates once per payment, whatever events arrive, how often or concurrently', async () => {
        const userId = await createUser(harness.client);
        const { firstInvoiceId, checkoutEvent, stripeSubscriptionId } =
          await subscribe(userId, T0);

        // The first payment is also confirmed by its invoice, twice.
        await deliverInvoice('invoice.paid', firstInvoiceId, after(T0, MINUTE));
        await deliverInvoice('invoice.paid', firstInvoiceId, after(T0, MINUTE));
        await redeliver(checkoutEvent, after(T0, 2 * MINUTE));

        // A renewal event delivered five times at once, plus a new event for
        // the same invoice.
        const renewal = api.renewSubscription(stripeSubscriptionId)
          .id as string;
        freezeTime(after(T1, MINUTE));
        const event = api.signedInvoiceEvent('invoice.paid', renewal);
        const responses = await Promise.all(
          Array.from({ length: 5 }, () =>
            harness.sendWebhook(event.payload, event.signature),
          ),
        );
        jest.useRealTimers();
        expect(responses.map((r) => r.status)).toEqual(Array(5).fill(200));
        await deliverInvoice('invoice.paid', renewal, after(T1, 2 * MINUTE));

        const allocations = await proAllocationsOf(userId);
        expect(
          allocations.map((a) => [a.providerPaymentId, a.granted]),
        ).toEqual([
          [firstInvoiceId, '1000.000000'],
          [renewal, '1000.000000'],
        ]);
        await expect(ledgerOf(userId)).resolves.toMatchObject([
          { type: 'ALLOCATION' },
          { type: 'EXPIRATION', effectiveAt: T1 },
          { type: 'ALLOCATION' },
        ]);

        // Allocating a recorded payment again returns the same allocation.
        const subscription = await subscriptionOf(userId);
        const [first] = subscription.payments;
        const again = await wallets.allocateSubscriptionCredits({
          authId: userId,
          subscriptionId: subscription.id,
          paymentId: first.id,
          periodStart: first.periodStart,
          periodEnd: first.periodEnd,
          credits: 1000,
          now: T0,
        });
        expect(again).toMatchObject({
          created: false,
          allocation: { paymentId: first.id },
        });
        await expect(ledgerOf(userId)).resolves.toHaveLength(3);
      });
    });

    describe('credit expiration', () => {
      it('expires the last month at its boundary when the subscription is not renewed (logged for an idle wallet)', async () => {
        const userId = await createUser(harness.client);
        await subscribe(userId, T0);
        await grantInPostgres(userId, 'REFERRAL', 7);

        const result = await sweeper.sweep(after(T1, DAY_MS));

        expect(result?.expiredAllocations).toBeGreaterThanOrEqual(1);
        await expect(ledgerOf(userId)).resolves.toEqual([
          expect.objectContaining({
            type: 'ALLOCATION',
            source: 'SUBSCRIPTION',
          }),
          expect.objectContaining({ type: 'ALLOCATION', source: 'REFERRAL' }),
          expect.objectContaining({
            type: 'EXPIRATION',
            source: 'SUBSCRIPTION',
            amount: '-1000.000000',
            balanceAfter: '7.000000',
            effectiveAt: T1,
          }),
        ]);
        await expect(
          wallets.getBalance(userId, after(T1, 365 * DAY_MS)),
        ).resolves.toMatchObject({
          availableCredits: '7',
          availableBySource: { SUBSCRIPTION: '0', REFERRAL: '7' },
        });
      });
    });

    describe('annual subscriptions', () => {
      const YEAR_END = addBillingInterval(T0, BillingInterval.YEARLY);
      /** Start of month k of the paid year bought at T0 (k = 12: year end). */
      const month = (k: number) =>
        k === 12 ? YEAR_END : addMonthsClamped(T0, k);
      let scheduler: SubscriptionCreditSchedulerService;
      beforeAll(() => {
        scheduler = harness.app.get(SubscriptionCreditSchedulerService, {
          strict: false,
        });
      });

      it('an annual purchase allocates the first month only (1000 credits, not 12000)', async () => {
        const userId = await createUser(harness.client);

        const { firstInvoiceId } = await subscribe(userId, T0, 'YEARLY');

        const subscription = await subscriptionOf(userId);
        const [payment] = subscription.payments;
        expect(payment).toMatchObject({
          billingInterval: 'YEARLY',
          status: 'SUCCEEDED',
          providerPaymentId: firstInvoiceId,
          periodStart: T0,
          periodEnd: YEAR_END,
        });
        await expect(proAllocationsOf(userId)).resolves.toEqual([
          expect.objectContaining({
            sourceReference: `pro:${payment.id}`,
            granted: '1000.000000',
            periodIndex: 0,
            periodStartsAt: T0,
            expiresAt: month(1),
            grantedAt: T0,
            subscriptionId: subscription.id,
            paymentId: payment.id,
            allocationOwner: userId,
            paymentPeriodStart: T0,
            paymentPeriodEnd: YEAR_END,
          }),
        ]);
        await expect(ledgerOf(userId)).resolves.toEqual([
          expect.objectContaining({
            type: 'ALLOCATION',
            amount: '1000.000000',
            balanceAfter: '1000.000000',
          }),
        ]);
        await expect(
          wallets.getBalance(userId, after(T0, DAY_MS)),
        ).resolves.toMatchObject({
          availableCredits: '1000',
          nextExpiration: { expiresAt: month(1).toISOString() },
        });
        // The scheduler finds the first month already granted.
        await expect(scheduler.run(after(T0, DAY_MS))).resolves.toMatchObject({
          granted: 0,
        });
      });

      it('grants each month when it begins and expires the previous month at its end, for the whole paid year', async () => {
        const userId = await createUser(harness.client);
        await subscribe(userId, T0, 'YEARLY');
        await grantInPostgres(userId, 'REFERRAL', 5);
        await wallets.deduct({
          authId: userId,
          credits: 100,
          idempotencyKey: 'month-0-run',
          now: after(T0, 3 * DAY_MS),
        });
        // The administrator changes the allowance during month 0: it applies
        // from month 1, then changes back from month 2.
        await setProAllowance(1200);
        await scheduler.run(after(month(1), MINUTE));
        await setProAllowance(1000);
        for (let k = 2; k < 12; k += 1) {
          await scheduler.run(after(month(k), MINUTE));
        }
        // After the paid year: nothing more is granted, the last month expires.
        await expect(
          scheduler.run(after(YEAR_END, DAY_MS)),
        ).resolves.toMatchObject({ checked: 0, granted: 0 });
        await sweeper.sweep(after(YEAR_END, DAY_MS));

        const allocations = await proAllocationsOf(userId);
        expect(allocations).toHaveLength(12);
        allocations.forEach((a, k) => {
          expect({
            index: a.periodIndex,
            period: [a.periodStartsAt, a.expiresAt],
            granted: a.granted,
            grantedAt: a.grantedAt,
            remaining: a.remaining,
          }).toEqual({
            index: k,
            period: [month(k), month(k + 1)],
            granted: k === 1 ? '1200.000000' : '1000.000000',
            grantedAt: k === 0 ? T0 : after(month(k), MINUTE),
            remaining: '0.000000',
          });
        });
        expect(allocations[11].expiresAt).toEqual(YEAR_END);

        const ledger = await ledgerOf(userId);
        const expirations = ledger.filter(
          (t) => t.type === 'EXPIRATION' && t.source === 'SUBSCRIPTION',
        );
        expect(expirations.map((t) => [t.amount, t.effectiveAt])).toEqual([
          ['-900.000000', month(1)],
          ['-1200.000000', month(2)],
          ...Array.from({ length: 10 }, (_, i) => [
            '-1000.000000',
            month(i + 3),
          ]),
        ]);
        expect(ledger.filter((t) => t.type === 'ALLOCATION')).toHaveLength(13);
        // Only the referral credits remain after the year.
        expect(ledger[ledger.length - 1].balanceAfter).toBe('5.000000');
        await expect(
          wallets.getBalance(userId, after(YEAR_END, DAY_MS)),
        ).resolves.toMatchObject({
          availableCredits: '5',
          availableBySource: { SUBSCRIPTION: '0', REFERRAL: '5' },
        });
      });

      it('grants nothing between paid years; a yearly renewal starts a new year of monthly grants', async () => {
        const userId = await createUser(harness.client);
        const { stripeSubscriptionId } = await subscribe(userId, T0, 'YEARLY');
        // The scheduler first runs in month 11: months 1-10 were missed and
        // are recorded as granted and expired; month 11 is usable.
        await scheduler.run(after(month(11), MINUTE));
        const firstYear = await proAllocationsOf(userId);
        expect(firstYear.map((a) => a.periodIndex)).toEqual([
          ...Array(12).keys(),
        ]);
        expect(
          firstYear
            .slice(1, 11)
            .every(
              (a, i) =>
                a.grantedAt.getTime() === month(i + 1).getTime() &&
                a.remaining === '0.000000' &&
                a.expiredAt?.getTime() === after(month(11), MINUTE).getTime(),
            ),
        ).toBe(true);
        expect(firstYear[11]).toMatchObject({
          remaining: '1000.000000',
          expiredAt: null,
        });

        // The year has ended and the renewal is not paid yet: nothing more.
        await scheduler.run(after(YEAR_END, MINUTE));
        await expect(proAllocationsOf(userId)).resolves.toHaveLength(12);

        const renewal = api.renewSubscription(stripeSubscriptionId)
          .id as string;
        await deliverInvoice('invoice.paid', renewal, after(YEAR_END, HOUR));
        const nextMonth = addMonthsClamped(YEAR_END, 1);
        await scheduler.run(after(nextMonth, MINUTE));

        const subscription = await subscriptionOf(userId);
        expect(subscription.payments.map((p) => p.periodStart)).toEqual([
          T0,
          YEAR_END,
        ]);
        const allocations = await proAllocationsOf(userId);
        expect(
          allocations.map((a) => [
            a.providerPaymentId,
            a.periodIndex,
            a.periodStartsAt,
            a.expiresAt,
          ]),
        ).toEqual([
          ...Array.from({ length: 12 }, (_, k): unknown[] => [
            expect.any(String) as unknown,
            k,
            month(k),
            month(k + 1),
          ]),
          [renewal, 0, YEAR_END, nextMonth],
          [renewal, 1, nextMonth, addMonthsClamped(YEAR_END, 2)],
        ]);
        // The old year's last month expired at the year end.
        await expect(ledgerOf(userId)).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'EXPIRATION',
              amount: '-1000.000000',
              effectiveAt: YEAR_END,
            }),
          ]),
        );
      });

      it('stops the monthly grants when the yearly payment is refunded', async () => {
        const userId = await createUser(harness.client);
        const { firstInvoiceId } = await subscribe(userId, T0, 'YEARLY');
        await scheduler.run(after(month(1), MINUTE));

        freezeTime(after(month(1), 2 * DAY_MS));
        api.refundInvoice(firstInvoiceId);
        const refunded = api.signedChargeEvent(
          'charge.refunded',
          api.chargeOf(firstInvoiceId),
        );
        await harness
          .sendWebhook(refunded.payload, refunded.signature)
          .expect(200);
        jest.useRealTimers();

        for (let k = 2; k < 12; k += 1) {
          // The refunded year is no longer eligible: not tried (no failed
          // grant), and skipped when asked directly. (Other tests'
          // subscribers in this schema may legitimately be granted.)
          const result = await scheduler.run(after(month(k), MINUTE));
          expect(result?.failed).toBe(0);
          await expect(
            scheduler.grantDueMonths(
              (await subscriptionOf(userId)).payments[0].id,
              after(month(k), MINUTE),
            ),
          ).resolves.toEqual({ granted: 0, historical: 0 });
        }
        await expect(proAllocationsOf(userId)).resolves.toHaveLength(2);
        await expect(
          subscriptionOf(userId).then((s) => s.payments[0].status),
        ).resolves.toBe('REFUNDED');
      });

      it('never grants a month twice: redelivered events, repeated and concurrent runs, duplicate payments', async () => {
        const userId = await createUser(harness.client);
        const { firstInvoiceId, checkoutEvent } = await subscribe(
          userId,
          T0,
          'YEARLY',
        );
        await deliverInvoice('invoice.paid', firstInvoiceId, after(T0, MINUTE));
        await redeliver(checkoutEvent, after(T0, 2 * MINUTE));

        // Month 1: repeated runs, and grants attempted concurrently (as by
        // several instances), including for the whole payment list.
        const monthOne = after(month(1), MINUTE);
        const [payment] = (await subscriptionOf(userId)).payments;
        const [runResult, ...outcomes] = await Promise.all([
          scheduler.run(monthOne),
          ...Array.from({ length: 6 }, () =>
            scheduler.grantDueMonths(payment.id, monthOne),
          ),
        ]);
        await scheduler.run(monthOne);
        await scheduler.run(after(monthOne, HOUR));
        // Exactly one grant in total, whichever caller made it.
        expect(
          outcomes.reduce((sum, outcome) => sum + outcome.granted, 0) +
            (runResult?.granted ?? 0),
        ).toBe(1);

        // A second, duplicate yearly charge for an overlapping period is kept
        // for its refund but granted no access, so it never funds credits.
        const duplicate = await recordPayment(
          harness.client,
          (await subscriptionOf(userId)).id,
          {
            provider: 'stripe',
            billingInterval: 'YEARLY',
            periodStart: after(T0, DAY_MS),
            periodEnd: addBillingInterval(
              after(T0, DAY_MS),
              BillingInterval.YEARLY,
            ),
          },
        );
        await scheduler.run(after(month(2), MINUTE));
        await expect(
          scheduler.grantDueMonths(duplicate.id, after(month(2), MINUTE)),
        ).resolves.toEqual({ granted: 0, historical: 0 });

        const allocations = await proAllocationsOf(userId);
        expect(allocations.map((a) => [a.paymentId, a.periodIndex])).toEqual([
          [payment.id, 0],
          [payment.id, 1],
          [payment.id, 2],
        ]);
        await expect(ledgerOf(userId)).resolves.toMatchObject([
          { type: 'ALLOCATION' },
          { type: 'EXPIRATION', effectiveAt: month(1) },
          { type: 'ALLOCATION' },
          { type: 'EXPIRATION', effectiveAt: month(2) },
          { type: 'ALLOCATION' },
        ]);
      });
    });
  },
);
