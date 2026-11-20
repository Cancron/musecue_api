import { PrismaPg } from '@prisma/adapter-pg';
import {
  BillingInterval,
  CreditSource,
  PaymentStatus,
  PrismaClient,
} from '@prisma/client';
import { CreditExpirationSweepService } from '../src/credits/credit-expiration-sweep.service';
import { CreditSettingsService } from '../src/credits/credit-settings.service';
import { CreditWalletService } from '../src/credits/credit-wallet.service';
import { CreditAllocationScheduler } from '../src/subscription/credit-allocation.scheduler';
import { CreditAllowanceService } from '../src/subscription/credit-allowance.service';
import { CreditEligibilityService } from '../src/subscription/credit-eligibility.service';
import { mock } from 'jest-mock-extended';
import type { CustomLoggerService } from '../src/common/services/custom-logger.service';
import {
  expectConsistentLedger,
  givenCreditsInPostgres,
} from './support/credit-fixtures';
import { FakeStripeApi } from './support/fake-stripe-api';
import { freezeTime } from './support/freeze-time';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  connectToSchema,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';
import {
  createStripeTestApp,
  dataOf,
  type StripeTestApp,
} from './support/stripe-test-app';
import {
  createUser,
  givenPaidProHistory,
  recordPayment,
} from './support/subscription-fixtures';

jest.setTimeout(180_000);

const HOUR = 60 * 60 * 1000;

/**
 * Monthly Pro credits from Stripe payments, end to end: checkout, signed
 * webhooks (checkout.session.completed, invoice.paid, invoice.payment_failed)
 * through POST /v1/webhooks/stripe, the real services and a migrated
 * PostgreSQL schema, with Stripe replaced by FakeStripeApi behind the real
 * Stripe SDK and the clock frozen at exact billing boundaries.
 */
describeWithDatabase(
  'Monthly Pro credits from Stripe payments (PostgreSQL, HTTP)',
  () => {
    let harness: StripeTestApp;
    let client: PrismaClient;
    let api: FakeStripeApi;

    const wallet = () => harness.app.get(CreditWalletService);
    const sweep = () => harness.app.get(CreditExpirationSweepService).sweep();
    const eligibility = (authId: string) =>
      harness.app.get(CreditEligibilityService).getEligibility(authId);

    const send = (event: { payload: string; signature: string }) =>
      harness.sendWebhook(event.payload, event.signature);
    const deliverSession = (sessionId: string) =>
      send(api.signedEvent('checkout.session.completed', sessionId));
    const deliverInvoice = (invoiceId: string, type = 'invoice.paid') =>
      send(api.signedInvoiceEvent(type, invoiceId));

    /** Opens a checkout; returns the Stripe checkout session id. */
    const startCheckout = async (authId: string, interval: string) => {
      const view = dataOf(
        await harness.startCheckout(authId, interval).expect(201),
      );
      const checkout = await client.checkoutSession.findUniqueOrThrow({
        where: { id: view.checkoutSessionId },
      });
      return checkout.providerSessionId as string;
    };

    /** Buys Pro: the first paid period starts at `periodStart` (now). */
    const subscribe = async (
      authId: string,
      periodStart: Date,
      interval: 'MONTHLY' | 'YEARLY' = 'MONTHLY',
    ) => {
      const sessionId = await startCheckout(authId, interval);
      const session = api.completeSession(sessionId, { periodStart });
      await deliverSession(sessionId).expect(200);
      return {
        sessionId,
        stripeSubscriptionId: session.subscription as string,
        firstInvoiceId: session.invoice as string,
      };
    };

    const subscriptionAllocations = (authId: string) =>
      client.creditAllocation.findMany({
        where: { authId, source: CreditSource.SUBSCRIPTION },
        orderBy: { periodStart: 'asc' },
      });
    const paymentsOf = (authId: string) =>
      client.paymentTransaction.findMany({
        where: { subscription: { authId } },
        orderBy: [{ periodStart: 'asc' }, { createdAt: 'asc' }],
        include: { creditAllocations: true, event: true },
      });
    /** Transactions touching SUBSCRIPTION allocations, in ledger order. */
    const proLedger = async (authId: string) =>
      (
        await client.creditTransaction.findMany({
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

    describe('initial purchase', () => {
      it('allocates the monthly Pro credits for the paid billing period, linked to the user, subscription, payment and transaction', async () => {
        const T0 = new Date('2031-01-31T10:00:00.000Z');
        freezeTime(T0);
        const authId = await createUser(client);

        await subscribe(authId, T0);

        const [payment] = await paymentsOf(authId);
        const subscription = await client.userSubscription.findUniqueOrThrow({
          where: { authId },
        });
        expect(payment).toMatchObject({
          status: 'SUCCEEDED',
          periodStart: T0,
          // Stripe bills Jan 31 -> Feb 28 (anchored on the 31st).
          periodEnd: new Date('2031-02-28T10:00:00.000Z'),
          event: expect.objectContaining({ type: 'CREATED' }) as unknown,
        });

        const [allocation, ...others] = await subscriptionAllocations(authId);
        expect(others).toEqual([]);
        expect(allocation).toMatchObject({
          authId,
          source: 'SUBSCRIPTION',
          subscriptionId: subscription.id,
          paymentId: payment.id,
          periodStart: payment.periodStart,
          expiresAt: payment.periodEnd,
          grantedAt: T0,
          sourceReference: `payment:${payment.id}:${T0.toISOString()}`,
        });
        expect(allocation.amount.toFixed()).toBe('1000');
        expect(allocation.remaining.toFixed()).toBe('1000');

        const transactions = await client.creditTransaction.findMany({
          where: { authId },
          include: { entries: true },
        });
        expect(transactions).toHaveLength(1);
        expect(transactions[0]).toMatchObject({
          type: 'GRANT',
          occurredAt: T0,
          description: 'Monthly Pro credits',
          entries: [
            expect.objectContaining({ allocationId: allocation.id }),
          ] as unknown,
        });
        expect(transactions[0].amount.toFixed()).toBe('1000');
        expect(transactions[0].balanceAfter.toFixed()).toBe('1000');

        await expect(eligibility(authId)).resolves.toMatchObject({
          eligible: true,
          usableBySource: { SUBSCRIPTION: '1000' },
        });
        await expectConsistentLedger(client, authId);
      });
    });

    describe('annual subscription', () => {
      const scheduler = () => harness.app.get(CreditAllocationScheduler);
      const scheduleOf = (authId: string) =>
        client.creditAllocationSchedule.findMany({
          where: { authId },
          orderBy: { periodStart: 'asc' },
        });
      /** Every month start of a yearly term, counted from `start` (clamped). */
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

      it('allocates only the first month at purchase and stores the other eleven months as scheduled in PostgreSQL', async () => {
        const T0 = new Date('2033-01-31T10:00:00.000Z');
        freezeTime(T0);
        const authId = await createUser(client);

        await subscribe(authId, T0, 'YEARLY');

        const [payment] = await paymentsOf(authId);
        const subscription = await client.userSubscription.findUniqueOrThrow({
          where: { authId },
        });
        const months = monthStarts(T0);
        const schedule = await scheduleOf(authId);
        expect(
          schedule.map((m) => [
            m.periodStart.toISOString(),
            m.periodEnd.toISOString(),
            m.status,
          ]),
        ).toEqual(
          months
            .slice(0, 12)
            .map((start, k) => [
              start.toISOString(),
              months[k + 1].toISOString(),
              k === 0 ? 'ALLOCATED' : 'PENDING',
            ]),
        );
        // Clamped like Stripe's anchor: Jan 31 -> Feb 28 -> Mar 31.
        expect(schedule[1].periodStart.toISOString()).toBe(
          '2033-02-28T10:00:00.000Z',
        );
        expect(schedule[2].periodStart.toISOString()).toBe(
          '2033-03-31T10:00:00.000Z',
        );
        expect(schedule[11].periodEnd).toEqual(payment.periodEnd);
        expect(
          schedule.every(
            (m) =>
              m.paymentId === payment.id &&
              m.subscriptionId === subscription.id,
          ),
        ).toBe(true);

        const allocations = await subscriptionAllocations(authId);
        expect(allocations).toHaveLength(1);
        expect(allocations[0]).toMatchObject({
          id: schedule[0].allocationId,
          paymentId: payment.id,
          subscriptionId: subscription.id,
          periodStart: T0,
          expiresAt: schedule[0].periodEnd,
        });
        expect(allocations[0].amount.toFixed()).toBe('1000');
        expect(await proLedger(authId)).toEqual([
          ['GRANT', '1000', T0.toISOString(), T0.toISOString()],
        ]);
        // Not 12,000 at once: nothing else is held, not even for later.
        await expect(wallet().getBalance(authId)).resolves.toMatchObject({
          available: '1000',
          upcoming: '0',
        });

        // Running the scheduler during the first month allocates nothing.
        freezeTime(new Date('2033-02-20T00:00:00.000Z'));
        await scheduler().run();
        await expect(subscriptionAllocations(authId)).resolves.toHaveLength(1);
      });

      it('grants each new month when it begins and expires the unused rest at the end of the month', async () => {
        const T0 = new Date('2033-03-15T09:00:00.000Z');
        const [, M1, M2, M3] = monthStarts(T0);
        freezeTime(T0);
        const authId = await createUser(client);
        await subscribe(authId, T0, 'YEARLY');
        await givenCreditsInPostgres(client, authId, 'PURCHASE', '20');
        await givenCreditsInPostgres(client, authId, 'REFERRAL', '5');
        await wallet().debit({
          authId,
          amount: '100',
          idempotencyKey: 'run-1',
        });

        // Exactly at the start of month 2.
        freezeTime(M1);
        await scheduler().run();
        // Thirty seconds into month 3.
        freezeTime(new Date(M2.getTime() + 30_000));
        await scheduler().run();
        // The administrator raises the allowance before month 4.
        const admin = await createUser(client);
        const settings = harness.app.get(CreditSettingsService);
        await settings.updateSettings(
          { proMonthlyCredits: 1500 },
          { actionedBy: admin },
        );
        try {
          freezeTime(M3);
          await scheduler().run();
        } finally {
          await settings.updateSettings(
            { proMonthlyCredits: 1000 },
            { actionedBy: admin },
          );
        }

        expect(await proLedger(authId)).toEqual([
          ['GRANT', '1000', T0.toISOString(), T0.toISOString()],
          ['DEBIT', '-100', T0.toISOString(), T0.toISOString()],
          ['EXPIRATION', '-900', M1.toISOString(), T0.toISOString()],
          ['GRANT', '1000', M1.toISOString(), M1.toISOString()],
          ['EXPIRATION', '-1000', M2.toISOString(), M1.toISOString()],
          [
            'GRANT',
            '1000',
            new Date(M2.getTime() + 30_000).toISOString(),
            M2.toISOString(),
          ],
          ['EXPIRATION', '-1000', M3.toISOString(), M2.toISOString()],
          ['GRANT', '1500', M3.toISOString(), M3.toISOString()],
        ]);
        const schedule = await scheduleOf(authId);
        expect(schedule.map((m) => m.status)).toEqual([
          ...Array<string>(4).fill('ALLOCATED'),
          ...Array<string>(8).fill('PENDING'),
        ]);
        // Each allocation is the one its month links to.
        const allocations = await subscriptionAllocations(authId);
        expect(allocations.map((a) => a.id)).toEqual(
          schedule.slice(0, 4).map((m) => m.allocationId),
        );
        await expect(wallet().getBalance(authId)).resolves.toMatchObject({
          available: '1525',
          bySource: { SUBSCRIPTION: '1500', PURCHASE: '20', REFERRAL: '5' },
        });
        await expectConsistentLedger(client, authId);
      });

      it('allocates exactly twelve months over the year, one at a time, and nothing after the subscription ends', async () => {
        const T0 = new Date('2034-01-31T10:00:00.000Z');
        const months = monthStarts(T0);
        freezeTime(T0);
        const authId = await createUser(client);
        await subscribe(authId, T0, 'YEARLY');

        for (let k = 1; k < 12; k += 1) {
          freezeTime(new Date(months[k].getTime() + 60_000));
          await scheduler().run();
          // Only the current month's credits, never more.
          await expect(wallet().getBalance(authId)).resolves.toMatchObject({
            available: '1000',
            upcoming: '0',
          });
        }
        // After the year: no thirteenth month, and the last one expires.
        for (const after of [
          months[12],
          new Date(months[12].getTime() + 40 * 24 * HOUR),
        ]) {
          freezeTime(after);
          await scheduler().run();
        }
        await sweep();

        const allocations = await subscriptionAllocations(authId);
        expect(allocations).toHaveLength(12);
        expect(allocations.map((a) => a.periodStart?.toISOString())).toEqual(
          months.slice(0, 12).map((m) => m.toISOString()),
        );
        const ledger = await proLedger(authId);
        expect(ledger.filter(([type]) => type === 'GRANT')).toHaveLength(12);
        expect(ledger.filter(([type]) => type === 'EXPIRATION')).toHaveLength(
          12,
        );
        expect(ledger.at(-1)).toEqual([
          'EXPIRATION',
          '-1000',
          months[12].toISOString(),
          months[11].toISOString(),
        ]);
        await expect(wallet().getBalance(authId)).resolves.toMatchObject({
          available: '0',
        });
        await expectConsistentLedger(client, authId);
      });

      it('stops allocating when a refund ends the annual subscription early', async () => {
        const T0 = new Date('2035-05-05T05:00:00.000Z');
        const months = monthStarts(T0);
        freezeTime(T0);
        const authId = await createUser(client);
        const { firstInvoiceId } = await subscribe(authId, T0, 'YEARLY');
        freezeTime(months[1]);
        await scheduler().run();

        // Refunded in Stripe in month 2: access ends now.
        freezeTime(new Date(months[1].getTime() + 2 * 24 * HOUR));
        api.refundInvoice(firstInvoiceId);
        await send(
          api.signedChargeEvent(
            'charge.refunded',
            api.chargeOf(firstInvoiceId),
          ),
        ).expect(200);
        await expect(harness.status(authId)).resolves.toMatchObject({
          hasProAccess: false,
        });

        freezeTime(months[2]);
        await scheduler().run();
        freezeTime(months[12]);
        await scheduler().run();

        const schedule = await scheduleOf(authId);
        expect(schedule.map((m) => [m.status, m.skipReason])).toEqual([
          ['ALLOCATED', null],
          ['ALLOCATED', null],
          ...Array<[string, string]>(10).fill([
            'SKIPPED',
            'PAYMENT_NOT_SUCCEEDED',
          ]),
        ]);
        await expect(subscriptionAllocations(authId)).resolves.toHaveLength(2);
      });

      it('gives monthly subscriptions nothing from the scheduler beyond their paid month', async () => {
        const T0 = new Date('2035-08-01T00:00:00.000Z');
        freezeTime(T0);
        const authId = await createUser(client);
        await subscribe(authId, T0, 'MONTHLY');

        for (const at of [
          '2035-09-01T00:00:00.000Z',
          '2035-10-15T00:00:00.000Z',
        ]) {
          freezeTime(new Date(at));
          await scheduler().run();
        }

        await expect(subscriptionAllocations(authId)).resolves.toHaveLength(1);
        expect((await scheduleOf(authId)).map((m) => m.status)).toEqual([
          'ALLOCATED',
        ]);
      });

      it('adds no credits for duplicated payment events or repeated and concurrent allocation runs', async () => {
        const T0 = new Date('2036-02-10T12:00:00.000Z');
        const months = monthStarts(T0);
        freezeTime(T0);
        const authId = await createUser(client);
        const { sessionId, firstInvoiceId } = await subscribe(
          authId,
          T0,
          'YEARLY',
        );

        await deliverSession(sessionId).expect(200);
        await Promise.all([
          deliverSession(sessionId),
          deliverSession(sessionId),
          deliverInvoice(firstInvoiceId),
        ]);
        await expect(scheduleOf(authId)).resolves.toHaveLength(12);
        await expect(subscriptionAllocations(authId)).resolves.toHaveLength(1);

        freezeTime(months[1]);
        const allowances = harness.app.get(CreditAllowanceService);
        const workers = Array.from(
          { length: 5 },
          () =>
            new CreditAllocationScheduler(
              allowances,
              mock<CustomLoggerService>(),
            ),
        );
        const results = await Promise.all([
          ...workers.map((worker) => worker.run()),
          eligibility(authId),
          eligibility(authId),
        ]);
        await scheduler().run();
        await scheduler().run();

        expect(
          results
            .slice(0, 5)
            .reduce(
              (sum, r) => sum + ((r as { allocated: number }).allocated ?? 0),
              0,
            ),
        ).toBeLessThanOrEqual(1);
        await expect(subscriptionAllocations(authId)).resolves.toHaveLength(2);
        await expect(
          client.creditTransaction.count({ where: { authId, type: 'GRANT' } }),
        ).resolves.toBe(2);
        await expect(wallet().getBalance(authId)).resolves.toMatchObject({
          available: '1000',
        });
        await expectConsistentLedger(client, authId);
      });
    });

    describe('successful renewals', () => {
      it('allocates fresh credits for every renewal and expires the unused rest at each billing boundary, leaving purchased and referral credits alone', async () => {
        const T0 = new Date('2031-05-31T10:00:00.000Z');
        const B1 = new Date('2031-06-30T10:00:00.000Z');
        const B2 = new Date('2031-07-31T10:00:00.000Z');
        const B3 = new Date('2031-08-31T10:00:00.000Z');
        freezeTime(T0);
        const authId = await createUser(client);
        const { stripeSubscriptionId } = await subscribe(authId, T0);
        await givenCreditsInPostgres(client, authId, 'PURCHASE', '20');
        await givenCreditsInPostgres(client, authId, 'REFERRAL', '5');
        // Pro credits are spent first (they expire soonest).
        await wallet().debit({
          authId,
          amount: '250',
          idempotencyKey: 'run-1',
        });

        // Renewal collected exactly at the boundary.
        freezeTime(B1);
        const first = api.renewSubscription(stripeSubscriptionId).id as string;
        await deliverInvoice(first).expect(200);

        // The administrator raises the allowance; the next renewal uses it.
        const admin = await createUser(client);
        const settings = harness.app.get(CreditSettingsService);
        await settings.updateSettings(
          { proMonthlyCredits: 1500 },
          { actionedBy: admin },
        );
        try {
          // Collected an hour after the boundary.
          freezeTime(new Date(B2.getTime() + HOUR));
          const second = api.renewSubscription(stripeSubscriptionId)
            .id as string;
          await deliverInvoice(second).expect(200);
        } finally {
          await settings.updateSettings(
            { proMonthlyCredits: 1000 },
            { actionedBy: admin },
          );
        }

        const payments = await paymentsOf(authId);
        expect(
          payments.map((p) => [
            p.status,
            p.event?.type,
            p.periodStart.toISOString(),
            p.periodEnd.toISOString(),
            p.creditAllocations.map((a) => [
              a.amount.toFixed(),
              a.periodStart?.toISOString(),
              a.expiresAt?.toISOString(),
            ]),
          ]),
        ).toEqual([
          [
            'SUCCEEDED',
            'CREATED',
            T0.toISOString(),
            B1.toISOString(),
            [['1000', T0.toISOString(), B1.toISOString()]],
          ],
          [
            'SUCCEEDED',
            'RENEWED',
            B1.toISOString(),
            B2.toISOString(),
            [['1000', B1.toISOString(), B2.toISOString()]],
          ],
          [
            'SUCCEEDED',
            'RENEWED',
            B2.toISOString(),
            B3.toISOString(),
            [['1500', B2.toISOString(), B3.toISOString()]],
          ],
        ]);

        // Expirations are effective at the billing boundaries.
        expect(await proLedger(authId)).toEqual([
          ['GRANT', '1000', T0.toISOString(), T0.toISOString()],
          ['DEBIT', '-250', T0.toISOString(), T0.toISOString()],
          ['EXPIRATION', '-750', B1.toISOString(), T0.toISOString()],
          ['GRANT', '1000', B1.toISOString(), B1.toISOString()],
          ['EXPIRATION', '-1000', B2.toISOString(), B1.toISOString()],
          [
            'GRANT',
            '1500',
            new Date(B2.getTime() + HOUR).toISOString(),
            B2.toISOString(),
          ],
        ]);
        const expirations = await client.creditTransaction.findMany({
          where: { authId, type: 'EXPIRATION' },
        });
        expect(expirations.map((t) => t.description)).toEqual([
          'SUBSCRIPTION credits expired',
          'SUBSCRIPTION credits expired',
        ]);

        await expect(wallet().getBalance(authId)).resolves.toMatchObject({
          available: '1525',
          bySource: { SUBSCRIPTION: '1500', PURCHASE: '20', REFERRAL: '5' },
        });
        await expectConsistentLedger(client, authId);
      });

      it('allocates a renewal paid before its period starts at payment time, counting from the boundary', async () => {
        const T0 = new Date('2031-09-01T12:00:00.000Z');
        const B1 = new Date('2031-10-01T12:00:00.000Z');
        freezeTime(T0);
        const authId = await createUser(client);
        const { stripeSubscriptionId } = await subscribe(authId, T0);

        freezeTime(new Date(B1.getTime() - HOUR));
        const early = api.renewSubscription(stripeSubscriptionId).id as string;
        await deliverInvoice(early).expect(200);

        await expect(subscriptionAllocations(authId)).resolves.toHaveLength(2);
        await expect(wallet().getBalance(authId)).resolves.toMatchObject({
          available: '1000',
          upcoming: '1000',
        });

        freezeTime(B1);
        await sweep();
        await expect(wallet().getBalance(authId)).resolves.toMatchObject({
          available: '1000',
          upcoming: '0',
        });
        expect((await proLedger(authId)).at(-1)).toEqual([
          'EXPIRATION',
          '-1000',
          B1.toISOString(),
          T0.toISOString(),
        ]);
        await expectConsistentLedger(client, authId);
      });
    });

    describe('failures', () => {
      it('allocates nothing for failed renewal attempts or their retries, and once when the renewal is finally paid', async () => {
        const T0 = new Date('2031-11-01T09:00:00.000Z');
        const B1 = new Date('2031-12-01T09:00:00.000Z');
        freezeTime(T0);
        const authId = await createUser(client);
        const { stripeSubscriptionId } = await subscribe(authId, T0);

        freezeTime(B1);
        const invoice = api.renewSubscription(stripeSubscriptionId, {
          paid: false,
        }).id as string;
        await deliverInvoice(invoice, 'invoice.payment_failed').expect(200);
        // Stripe retries, and fails again.
        freezeTime(new Date(B1.getTime() + 3 * 24 * HOUR));
        api.failInvoiceAttempt(invoice);
        await deliverInvoice(invoice, 'invoice.payment_failed').expect(200);

        const failedPayments = (await paymentsOf(authId)).filter(
          (p) => p.status === PaymentStatus.FAILED,
        );
        expect(failedPayments).toHaveLength(2);
        expect(
          failedPayments.every((p) => p.creditAllocations.length === 0),
        ).toBe(true);
        await expect(subscriptionAllocations(authId)).resolves.toHaveLength(1);
        // The paid month's credits still expired at the boundary.
        await sweep();
        await expect(eligibility(authId)).resolves.toMatchObject({
          usableBySource: { SUBSCRIPTION: '0' },
        });

        // The customer updates the card; the invoice is paid.
        freezeTime(new Date(B1.getTime() + 4 * 24 * HOUR));
        api.payInvoice(invoice);
        await deliverInvoice(invoice).expect(200);
        await deliverInvoice(invoice).expect(200);

        const allocations = await subscriptionAllocations(authId);
        expect(allocations).toHaveLength(2);
        const paid = (await paymentsOf(authId)).find(
          (p) =>
            p.status === PaymentStatus.SUCCEEDED &&
            p.providerPaymentId === invoice,
        );
        expect(allocations[1]).toMatchObject({
          paymentId: paid?.id,
          periodStart: B1,
          expiresAt: new Date('2032-01-01T09:00:00.000Z'),
        });
        expect(await proLedger(authId)).toEqual([
          ['GRANT', '1000', T0.toISOString(), T0.toISOString()],
          ['EXPIRATION', '-1000', B1.toISOString(), T0.toISOString()],
          [
            'GRANT',
            '1000',
            new Date(B1.getTime() + 4 * 24 * HOUR).toISOString(),
            B1.toISOString(),
          ],
        ]);
        await expectConsistentLedger(client, authId);
      });

      it('allocates nothing for a failed first payment, and once when it is paid', async () => {
        const T0 = new Date('2032-01-15T15:00:00.000Z');
        freezeTime(T0);
        const authId = await createUser(client);
        const sessionId = await startCheckout(authId, 'MONTHLY');
        const invoice = api.failFirstPayment(sessionId, {}, T0).id as string;

        await deliverInvoice(invoice, 'invoice.payment_failed').expect(200);

        await expect(
          client.creditWallet.count({ where: { authId } }),
        ).resolves.toBe(0);

        // Another card succeeds: invoice.paid and the checkout event race.
        api.completeSession(sessionId);
        await Promise.all([
          deliverInvoice(invoice),
          deliverSession(sessionId),
          deliverInvoice(invoice),
        ]);

        const allocations = await subscriptionAllocations(authId);
        expect(allocations).toHaveLength(1);
        expect(allocations[0].amount.toFixed()).toBe('1000');
        await expectConsistentLedger(client, authId);
      });
    });

    describe('duplicated events', () => {
      it('allocates once however often, and however concurrently, the payment events are delivered', async () => {
        const T0 = new Date('2032-02-03T11:00:00.000Z');
        const B1 = new Date('2032-03-03T11:00:00.000Z');
        freezeTime(T0);
        const authId = await createUser(client);
        const { sessionId, stripeSubscriptionId, firstInvoiceId } =
          await subscribe(authId, T0);

        // The first payment again: redeliveries, concurrent deliveries and its
        // invoice.paid.
        await deliverSession(sessionId).expect(200);
        await Promise.all([
          ...Array.from({ length: 4 }, () => deliverSession(sessionId)),
          deliverInvoice(firstInvoiceId),
        ]);

        freezeTime(B1);
        const renewal = api.renewSubscription(stripeSubscriptionId)
          .id as string;
        await Promise.all(
          Array.from({ length: 5 }, () => deliverInvoice(renewal)),
        );
        await deliverInvoice(renewal).expect(200);

        const payments = await paymentsOf(authId);
        expect(payments).toHaveLength(2);
        expect(payments.map((p) => p.creditAllocations.length)).toEqual([1, 1]);
        await expect(
          client.creditTransaction.count({ where: { authId, type: 'GRANT' } }),
        ).resolves.toBe(2);
        await expectConsistentLedger(client, authId);
      });
    });

    describe('credit expiration', () => {
      it('expires unused Pro credits at the end of the last paid period when no renewal comes, and logs it once', async () => {
        const T0 = new Date('2032-04-20T07:30:00.000Z');
        const end = new Date('2032-05-20T07:30:00.000Z');
        freezeTime(T0);
        const authId = await createUser(client);
        await subscribe(authId, T0);
        await givenCreditsInPostgres(client, authId, 'PURCHASE', '3');
        await wallet().debit({ authId, amount: '0.5', idempotencyKey: 'run' });

        freezeTime(new Date(end.getTime() - 1));
        await expect(eligibility(authId)).resolves.toMatchObject({
          usableBySource: { SUBSCRIPTION: '999.5', PURCHASE: '3' },
        });

        freezeTime(new Date(end.getTime() + 2 * 24 * HOUR));
        await sweep();
        await sweep();

        expect((await proLedger(authId)).slice(-1)).toEqual([
          ['EXPIRATION', '-999.5', end.toISOString(), T0.toISOString()],
        ]);
        await expect(wallet().getBalance(authId)).resolves.toMatchObject({
          available: '3',
          bySource: { SUBSCRIPTION: '0', PURCHASE: '3' },
        });
        await expectConsistentLedger(client, authId);
      });
    });

    describe('idempotency and ownership in PostgreSQL', () => {
      it('refuses a second allocation for the same payment and month, whatever its reference', async () => {
        const T0 = new Date('2032-06-01T00:00:00.000Z');
        freezeTime(T0);
        const authId = await createUser(client);
        await subscribe(authId, T0);
        const [allocation] = await subscriptionAllocations(authId);

        await expect(
          wallet().grant({
            authId,
            source: CreditSource.SUBSCRIPTION,
            sourceReference: 'another-reference',
            amount: 1000,
            expiresAt: allocation.expiresAt,
            payment: {
              subscriptionId: allocation.subscriptionId as string,
              paymentId: allocation.paymentId as string,
              periodStart: allocation.periodStart as Date,
            },
          }),
        ).rejects.toMatchObject({ code: 'P2002' });
        await expect(subscriptionAllocations(authId)).resolves.toHaveLength(1);
      });

      it("accepts monthly Pro credits only for a successful payment that granted the same user's term, within its period", async () => {
        const T0 = new Date('2032-07-01T00:00:00.000Z');
        freezeTime(T0);
        const owner = await createUser(client);
        const stranger = await createUser(client);
        await subscribe(owner, T0);
        const [paid] = await paymentsOf(owner);
        const subscription = await client.userSubscription.findUniqueOrThrow({
          where: { authId: owner },
        });
        // A collected payment that did not create or renew the term (no
        // event), and a failed one.
        const unused = await recordPayment(client, subscription.id, {
          periodStart: new Date('2032-09-01T00:00:00.000Z'),
          periodEnd: new Date('2032-10-01T00:00:00.000Z'),
        });
        const failed = await recordPayment(client, subscription.id, {
          status: PaymentStatus.FAILED,
          periodStart: new Date('2032-08-01T00:00:00.000Z'),
          periodEnd: new Date('2032-09-01T00:00:00.000Z'),
        });
        await givenPaidProHistory(
          client,
          stranger,
          { billingInterval: BillingInterval.MONTHLY, startedAt: T0 },
          T0,
        );

        const attempt = (
          authId: string,
          payment: { id: string; periodStart: Date; periodEnd: Date },
          overrides: { periodStart?: Date; expiresAt?: Date } = {},
        ) =>
          wallet().grant({
            authId,
            source: CreditSource.SUBSCRIPTION,
            sourceReference: `attempt:${payment.id}:${String(overrides.periodStart?.getTime())}`,
            amount: 1,
            expiresAt: overrides.expiresAt ?? payment.periodEnd,
            payment: {
              subscriptionId: subscription.id,
              paymentId: payment.id,
              periodStart: overrides.periodStart ?? payment.periodStart,
            },
          });

        await expect(attempt(owner, failed)).rejects.toThrow(
          'require a successful payment',
        );
        await expect(attempt(owner, unused)).rejects.toThrow(
          'created or renewed the paid term',
        );
        await expect(attempt(stranger, paid)).rejects.toThrow(
          "subscription's user",
        );
        await expect(
          attempt(owner, paid, {
            periodStart: new Date(paid.periodStart.getTime() + HOUR),
            expiresAt: new Date(paid.periodEnd.getTime() + HOUR),
          }),
        ).rejects.toThrow('within the paid period');

        await expect(subscriptionAllocations(owner)).resolves.toHaveLength(1);
        await expect(
          client.creditAllocation.count({
            where: { paymentId: { in: [unused.id, failed.id] } },
          }),
        ).resolves.toBe(0);
      });
    });
  },
);

/**
 * Migration 20261124120000_subscription_credit_allocations links monthly
 * Pro credits granted before it (on first use, referenced
 * 'pro:<proStartedAt>:<monthStart>') to the payment of their month.
 */
describeWithDatabase(
  'Linking earlier monthly Pro credits to their payments (migration)',
  () => {
    const MIGRATION = '20261124120000_subscription_credit_allocations';
    let schema: string;
    let client: PrismaClient;

    beforeEach(async () => {
      schema = await createSchema();
      const names = migrationNames();
      await applyMigrations(schema, names.slice(0, names.indexOf(MIGRATION)));
      client = new PrismaClient({
        adapter: new PrismaPg(
          {
            connectionString: TEST_DATABASE_URL as string,
            options: `-c search_path=${schema}`,
          },
          { schema },
        ),
      });
    });

    afterEach(async () => {
      await client?.$disconnect();
      if (schema) await dropSchema(schema);
    });

    /** A monthly Pro allocation as the earlier release wrote it (raw SQL). */
    const legacyAllocation = async (authId: string, proStart: Date) => {
      const pg = await connectToSchema(schema);
      const ref = `pro:${proStart.toISOString()}:${proStart.toISOString()}`;
      const end = new Date('2030-02-01T00:00:00.000Z').toISOString();
      try {
        await pg.query(`
        DO $$
        DECLARE w text := gen_random_uuid()::text; a text := gen_random_uuid()::text; t text := gen_random_uuid()::text;
        BEGIN
          INSERT INTO "CreditWallet" ("id", "authId") VALUES (w, '${authId}');
          INSERT INTO "CreditAllocation" ("id", "walletId", "authId", "source", "sourceReference", "amount", "remaining", "grantedAt", "expiresAt", "updatedAt")
          VALUES (a, w, '${authId}', 'SUBSCRIPTION', '${ref}', 1000, 1000, '${proStart.toISOString()}', '${end}', now());
          INSERT INTO "CreditTransaction" ("id", "walletId", "authId", "type", "amount", "balanceAfter", "idempotencyKey", "occurredAt")
          VALUES (t, w, '${authId}', 'GRANT', 1000, 1000, 'grant:SUBSCRIPTION:${ref}', '${proStart.toISOString()}');
          INSERT INTO "CreditLedgerEntry" ("id", "walletId", "transactionId", "allocationId", "amount")
          VALUES (gen_random_uuid()::text, w, t, a, 1000);
        END $$;`);
      } finally {
        await pg.end();
      }
    };

    it('links each earlier allocation to the user, subscription, payment and month', async () => {
      const start = new Date('2030-01-01T00:00:00.000Z');
      const authId = await createUser(client);
      await givenPaidProHistory(
        client,
        authId,
        { billingInterval: BillingInterval.MONTHLY, startedAt: start },
        start,
      );
      await legacyAllocation(authId, start);

      await applyMigrations(schema, [MIGRATION]);

      const subscription = await client.userSubscription.findUniqueOrThrow({
        where: { authId },
        include: { payments: true },
      });
      await expect(
        client.creditAllocation.findFirstOrThrow({ where: { authId } }),
      ).resolves.toMatchObject({
        subscriptionId: subscription.id,
        paymentId: subscription.payments[0].id,
        periodStart: start,
      });
    });

    it('stops with a clear error when an earlier allocation has no payment to link', async () => {
      const authId = await createUser(client);
      await client.userSubscription.create({ data: { authId } });
      await legacyAllocation(authId, new Date('2030-01-01T00:00:00.000Z'));

      await expect(applyMigrations(schema, [MIGRATION])).rejects.toThrow(
        'could not be linked to the payment of their month',
      );
    });
  },
);
