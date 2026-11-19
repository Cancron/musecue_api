import {
  BillingInterval,
  CreditSource,
  type PrismaClient,
} from '@prisma/client';
import { CreditExpirationSweepService } from '../src/credits/credit-expiration-sweep.service';
import { CreditSettingsService } from '../src/credits/credit-settings.service';
import { CreditWalletService } from '../src/credits/credit-wallet.service';
import { addBillingInterval } from '../src/subscription/billing.validation';
import { CreditAllowanceService } from '../src/subscription/credit-allowance.service';
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
import { createUser } from './support/subscription-fixtures';

jest.setTimeout(120_000);

const HOUR = 60 * 60 * 1000;
const { MONTHLY } = BillingInterval;
/** Whole seconds, as Stripe reports times. */
const at = (iso: string) => new Date(iso);

type Event = { payload: string; signature: string };

/**
 * Monthly Pro credits granted by successful payments, end to end: the real
 * HTTP stack (checkout and the signed Stripe webhook), services and a
 * migrated PostgreSQL schema, with Stripe replaced by FakeStripeApi behind
 * the real Stripe SDK and time controlled by freezeTime.
 */
describeWithDatabase(
  'Monthly Pro credits from Stripe payments (PostgreSQL, HTTP)',
  () => {
    let harness: StripeTestApp;
    let client: PrismaClient;
    let api: FakeStripeApi;

    const send = (event: Event) =>
      harness.sendWebhook(event.payload, event.signature);
    const sweep = () => harness.app.get(CreditExpirationSweepService).sweep();

    /** Opens a monthly checkout; returns the Stripe session id. */
    const openCheckout = async (authId: string) => {
      const view = dataOf(
        await harness.startCheckout(authId, 'MONTHLY').expect(201),
      );
      const checkout = await client.checkoutSession.findUniqueOrThrow({
        where: { id: view.checkoutSessionId },
      });
      return checkout.providerSessionId as string;
    };

    /** Buys monthly Pro with a first period starting at the frozen time. */
    const subscribe = async (authId: string) => {
      const sessionId = await openCheckout(authId);
      const session = api.completeSession(sessionId, {
        periodStart: new Date(),
      });
      await send(
        api.signedEvent('checkout.session.completed', sessionId),
      ).expect(200);
      return {
        sessionId,
        subscriptionId: session.subscription as string,
        firstInvoiceId: session.invoice as string,
      };
    };

    const proAllocations = (authId: string) =>
      client.creditAllocation.findMany({
        where: { authId, source: CreditSource.SUBSCRIPTION },
        orderBy: { periodStart: 'asc' },
      });
    const history = async (authId: string) =>
      (
        await client.creditTransaction.findMany({
          where: { authId },
          orderBy: { sequence: 'asc' },
        })
      ).map((t) => [
        t.type,
        t.amount.toFixed(),
        t.balanceAfter.toFixed(),
        t.occurredAt.toISOString(),
      ]);
    const paymentOf = (invoiceId: string) =>
      client.paymentTransaction.findFirstOrThrow({
        where: { providerPaymentId: invoiceId },
      });

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
      it('allocates the monthly Pro credits for the paid period, linked to the user, subscription, payment and ledger', async () => {
        const T0 = at('2031-01-31T10:00:00.000Z');
        freezeTime(T0);
        const userId = await createUser(client);

        const { firstInvoiceId } = await subscribe(userId);

        const subscription = await client.userSubscription.findUniqueOrThrow({
          where: { authId: userId },
        });
        const payment = await paymentOf(firstInvoiceId);
        const periodEnd = addBillingInterval(T0, MONTHLY);
        expect(payment).toMatchObject({
          status: 'SUCCEEDED',
          subscriptionId: subscription.id,
          periodStart: T0,
          periodEnd,
        });
        const [allocation, ...others] = await proAllocations(userId);
        expect(others).toEqual([]);
        expect(allocation).toMatchObject({
          authId: userId,
          source: 'SUBSCRIPTION',
          sourceReference: `payment:${payment.id}:${T0.toISOString()}`,
          subscriptionId: subscription.id,
          paymentId: payment.id,
          periodStart: T0,
          periodEnd,
          grantedAt: T0,
          // Expires at the billing boundary (Jan 31 -> Feb 28).
          expiresAt: at('2031-02-28T10:00:00.000Z'),
        });
        expect(allocation.amount.toFixed()).toBe('1000');
        expect(allocation.remaining.toFixed()).toBe('1000');

        const [grant] = await client.creditTransaction.findMany({
          where: { authId: userId },
          include: { entries: true },
        });
        expect(grant).toMatchObject({
          type: 'GRANT',
          description: 'Monthly Pro credits',
          occurredAt: T0,
          idempotencyKey: `grant:SUBSCRIPTION:payment:${payment.id}:${T0.toISOString()}`,
          entries: [expect.objectContaining({ allocationId: allocation.id })],
        });
        expect(grant.amount.toFixed()).toBe('1000');
        expect(grant.balanceAfter.toFixed()).toBe('1000');
        await expect(
          harness.app.get(CreditWalletService).getBalance(userId),
        ).resolves.toMatchObject({
          available: '1000',
          bySource: { SUBSCRIPTION: '1000' },
        });
      });

      it('allocates the amount an administrator configured at the time of payment', async () => {
        const admin = await createUser(client);
        const settings = harness.app.get(CreditSettingsService);
        await settings.updateSettings(
          { proMonthlyCredits: 1500 },
          { actionedBy: admin },
        );
        try {
          const userId = await createUser(client);
          await subscribe(userId);
          const [allocation] = await proAllocations(userId);
          expect(allocation.amount.toFixed()).toBe('1500');
        } finally {
          await settings.updateSettings(
            { proMonthlyCredits: 1000 },
            { actionedBy: admin },
          );
        }
      });
    });

    describe('renewals', () => {
      it("allocates fresh credits for each paid month and expires the previous month's rest at the billing boundary", async () => {
        const T0 = at('2031-03-15T09:00:00.000Z');
        const boundary1 = addBillingInterval(T0, MONTHLY);
        const boundary2 = addBillingInterval(boundary1, MONTHLY);
        const boundary3 = addBillingInterval(boundary2, MONTHLY);
        freezeTime(T0);
        const userId = await createUser(client);
        const { subscriptionId } = await subscribe(userId);
        await givenCreditsInPostgres(client, userId, 'PURCHASE', '20');
        await givenCreditsInPostgres(client, userId, 'REFERRAL', '5');
        // Monthly credits are spent before purchased ones (they expire first).
        await harness.app.get(CreditWalletService).debit({
          authId: userId,
          amount: '250',
          idempotencyKey: 'ai-run-1',
        });

        // Stripe renews at the billing boundary; the webhook arrives an hour later.
        freezeTime(new Date(boundary1.getTime() + HOUR));
        const renewal1 = api.renewSubscription(subscriptionId).id as string;
        await send(api.signedInvoiceEvent('invoice.paid', renewal1)).expect(
          200,
        );

        freezeTime(new Date(boundary2.getTime() + HOUR));
        const renewal2 = api.renewSubscription(subscriptionId).id as string;
        await send(api.signedInvoiceEvent('invoice.paid', renewal2)).expect(
          200,
        );

        const payments = [
          await client.paymentTransaction.findFirstOrThrow({
            where: { subscription: { authId: userId }, periodStart: T0 },
          }),
          await paymentOf(renewal1),
          await paymentOf(renewal2),
        ];
        expect(
          (await proAllocations(userId)).map((a) => [
            a.paymentId,
            a.periodStart?.toISOString(),
            a.periodEnd?.toISOString(),
            a.expiresAt?.toISOString(),
            a.amount.toFixed(),
            a.remaining.toFixed(),
          ]),
        ).toEqual([
          [
            payments[0].id,
            T0.toISOString(),
            boundary1.toISOString(),
            boundary1.toISOString(),
            '1000',
            '0',
          ],
          [
            payments[1].id,
            boundary1.toISOString(),
            boundary2.toISOString(),
            boundary2.toISOString(),
            '1000',
            '0',
          ],
          [
            payments[2].id,
            boundary2.toISOString(),
            boundary3.toISOString(),
            boundary3.toISOString(),
            '1000',
            '1000',
          ],
        ]);
        // Each period's expiry is logged at its boundary, before the next grant.
        // (The purchased 20 and referral 5 are granted through PostgreSQL.)
        expect(await history(userId)).toEqual([
          ['GRANT', '1000', '1000', T0.toISOString()],
          ['GRANT', '20', '1020', expect.any(String)],
          ['GRANT', '5', '1025', expect.any(String)],
          ['DEBIT', '-250', '775', T0.toISOString()],
          ['EXPIRATION', '-750', '25', boundary1.toISOString()],
          [
            'GRANT',
            '1000',
            '1025',
            new Date(boundary1.getTime() + HOUR).toISOString(),
          ],
          ['EXPIRATION', '-1000', '25', boundary2.toISOString()],
          [
            'GRANT',
            '1000',
            '1025',
            new Date(boundary2.getTime() + HOUR).toISOString(),
          ],
        ]);
        // Purchased and referral credits are untouched.
        await expect(
          harness.app.get(CreditWalletService).getBalance(userId),
        ).resolves.toMatchObject({
          available: '1025',
          bySource: { SUBSCRIPTION: '1000', PURCHASE: '20', REFERRAL: '5' },
        });
        await expectConsistentLedger(client, userId);
      });

      it('expires the last paid month at its boundary when no renewal comes, and logs it', async () => {
        const T0 = at('2031-05-01T00:00:00.000Z');
        const boundary = addBillingInterval(T0, MONTHLY);
        freezeTime(T0);
        const userId = await createUser(client);
        await subscribe(userId);

        freezeTime(new Date(boundary.getTime() - 1));
        await expect(
          harness.app.get(CreditWalletService).getBalance(userId),
        ).resolves.toMatchObject({ available: '1000' });
        freezeTime(boundary);
        await expect(
          harness.app.get(CreditWalletService).getBalance(userId),
        ).resolves.toMatchObject({ available: '0' });

        freezeTime(new Date(boundary.getTime() + 5 * HOUR));
        await sweep();
        expect((await history(userId)).at(-1)).toEqual([
          'EXPIRATION',
          '-1000',
          '0',
          boundary.toISOString(),
        ]);
      });
    });

    describe('failed payments', () => {
      it('allocates nothing for a failed first payment, then exactly once when it is paid', async () => {
        const T0 = at('2031-06-10T12:00:00.000Z');
        freezeTime(T0);
        const userId = await createUser(client);
        const sessionId = await openCheckout(userId);
        const invoiceId = api.failFirstPayment(sessionId, {}, new Date())
          .id as string;

        await send(
          api.signedInvoiceEvent('invoice.payment_failed', invoiceId),
        ).expect(200);

        await expect(
          client.paymentTransaction.count({
            where: { subscription: { authId: userId }, status: 'FAILED' },
          }),
        ).resolves.toBe(1);
        await expect(
          client.creditWallet.count({ where: { authId: userId } }),
        ).resolves.toBe(0);

        // The customer pays with another card in the same checkout.
        api.completeSession(sessionId);
        await send(
          api.signedEvent('checkout.session.completed', sessionId),
        ).expect(200);
        await send(api.signedInvoiceEvent('invoice.paid', invoiceId)).expect(
          200,
        );

        const allocations = await proAllocations(userId);
        expect(allocations).toHaveLength(1);
        const paid = await client.paymentTransaction.findFirstOrThrow({
          where: { subscription: { authId: userId }, status: 'SUCCEEDED' },
        });
        expect(allocations[0].paymentId).toBe(paid.id);
      });

      it('allocates nothing for a failed renewal; a recovered renewal allocates once', async () => {
        const T0 = at('2031-07-05T08:00:00.000Z');
        const boundary = addBillingInterval(T0, MONTHLY);
        freezeTime(T0);
        const userId = await createUser(client);
        const { subscriptionId } = await subscribe(userId);

        freezeTime(new Date(boundary.getTime() + HOUR));
        const invoiceId = api.renewSubscription(subscriptionId, { paid: false })
          .id as string;
        await send(
          api.signedInvoiceEvent('invoice.payment_failed', invoiceId),
        ).expect(200);
        // A retried failure, too.
        api.failInvoiceAttempt(invoiceId);
        await send(
          api.signedInvoiceEvent('invoice.payment_failed', invoiceId),
        ).expect(200);

        await expect(proAllocations(userId)).resolves.toHaveLength(1);
        await expect(
          harness.app.get(CreditEligibilityService).getEligibility(userId),
        ).resolves.toMatchObject({
          eligible: false,
          usableBySource: { SUBSCRIPTION: '0' },
        });

        // Stripe's next retry collects the invoice.
        freezeTime(new Date(boundary.getTime() + 30 * HOUR));
        api.payInvoice(invoiceId);
        const paid = api.signedInvoiceEvent('invoice.paid', invoiceId);
        await send(paid).expect(200);
        await send(paid).expect(200);

        const allocations = await proAllocations(userId);
        expect(allocations).toHaveLength(2);
        const renewal = await paymentOf(invoiceId);
        expect(allocations[1]).toMatchObject({
          paymentId: renewal.id,
          periodStart: boundary,
          periodEnd: renewal.periodEnd,
          grantedAt: new Date(boundary.getTime() + 30 * HOUR),
        });
        await expectConsistentLedger(client, userId);
      });
    });

    describe('duplicated events and idempotency', () => {
      it('allocates once however often, and through whichever event, a payment is confirmed', async () => {
        freezeTime(at('2031-08-01T00:00:00.000Z'));
        const userId = await createUser(client);
        const sessionId = await openCheckout(userId);
        const session = api.completeSession(sessionId, {
          periodStart: new Date(),
        });
        const completed = api.signedEvent(
          'checkout.session.completed',
          sessionId,
        );

        // Concurrent and repeated deliveries of the same event, then the other
        // events Stripe sends for the same payment.
        await Promise.all(Array.from({ length: 5 }, () => send(completed)));
        await send(completed).expect(200);
        await send(
          api.signedEvent(
            'checkout.session.async_payment_succeeded',
            sessionId,
          ),
        ).expect(200);
        await send(
          api.signedInvoiceEvent('invoice.paid', session.invoice as string),
        ).expect(200);

        await expect(proAllocations(userId)).resolves.toHaveLength(1);
        await expect(
          client.creditTransaction.count({ where: { authId: userId } }),
        ).resolves.toBe(1);
      });

      it('allocates a renewal once for repeated and concurrent deliveries', async () => {
        const T0 = at('2031-09-01T00:00:00.000Z');
        freezeTime(T0);
        const userId = await createUser(client);
        const { subscriptionId } = await subscribe(userId);
        freezeTime(new Date(addBillingInterval(T0, MONTHLY).getTime() + HOUR));
        const invoiceId = api.renewSubscription(subscriptionId).id as string;
        const paid = api.signedInvoiceEvent('invoice.paid', invoiceId);

        await Promise.all(Array.from({ length: 5 }, () => send(paid)));
        await send(paid).expect(200);

        await expect(proAllocations(userId)).resolves.toHaveLength(2);
        await expect(
          client.creditTransaction.count({
            where: { authId: userId, type: 'GRANT' },
          }),
        ).resolves.toBe(2);
      });

      it('allocates nothing for a second charge of an already paid period', async () => {
        const T0 = at('2031-10-01T00:00:00.000Z');
        freezeTime(T0);
        const userId = await createUser(client);
        const { subscriptionId } = await subscribe(userId);
        freezeTime(new Date(addBillingInterval(T0, MONTHLY).getTime() + HOUR));
        const invoiceId = api.renewSubscription(subscriptionId).id as string;
        await send(api.signedInvoiceEvent('invoice.paid', invoiceId)).expect(
          200,
        );
        // Stripe charged the same period twice (kept for a refund).
        api.invoices.set('in_second_charge', {
          ...structuredClone(api.invoices.get(invoiceId)),
          id: 'in_second_charge',
        });
        await send(
          api.signedInvoiceEvent('invoice.paid', 'in_second_charge'),
        ).expect(200);

        // Recognised as a duplicate charge: not recorded as a second payment
        // of the period, and no credits for it.
        await expect(
          client.paymentWebhookEvent.findMany({
            where: { objectId: 'in_second_charge' },
            select: { status: true, outcome: true },
          }),
        ).resolves.toEqual([
          { status: 'PROCESSED', outcome: 'DUPLICATE_PAYMENT' },
        ]);
        await expect(
          client.paymentTransaction.count({
            where: { subscription: { authId: userId } },
          }),
        ).resolves.toBe(2);
        await expect(proAllocations(userId)).resolves.toHaveLength(2);
      });

      it('grants nothing more when the current period is checked again later', async () => {
        freezeTime(at('2031-11-01T00:00:00.000Z'));
        const userId = await createUser(client);
        await subscribe(userId);

        await expect(
          harness.app
            .get(CreditAllowanceService)
            .grantCurrentPaidPeriod(userId),
        ).resolves.toBe('ALREADY_GRANTED');
        await harness.app.get(CreditEligibilityService).getEligibility(userId);

        await expect(proAllocations(userId)).resolves.toHaveLength(1);
      });

      it('has PostgreSQL refuse monthly credits that no successful payment of the user paid for, or a period twice', async () => {
        freezeTime(at('2031-12-01T00:00:00.000Z'));
        const userId = await createUser(client);
        const other = await createUser(client);
        await subscribe(userId);
        const [allocation] = await proAllocations(userId);
        const payment = await client.paymentTransaction.findUniqueOrThrow({
          where: { id: allocation.paymentId as string },
        });
        const otherSessionId = await openCheckout(other);
        const failedInvoice = api.failFirstPayment(
          otherSessionId,
          {},
          new Date(),
        ).id as string;
        await send(
          api.signedInvoiceEvent('invoice.payment_failed', failedInvoice),
        ).expect(200);
        const failedPayment = await client.paymentTransaction.findFirstOrThrow({
          where: { subscription: { authId: other }, status: 'FAILED' },
        });
        const otherSubscription =
          await client.userSubscription.findUniqueOrThrow({
            where: { authId: other },
          });
        await client.creditWallet.create({ data: { authId: other } });

        const insert = (authId: string, overrides: Record<string, unknown>) =>
          client.$transaction(async (tx) => {
            const wallet = await tx.creditWallet.findUniqueOrThrow({
              where: { authId },
            });
            await tx.creditAllocation.create({
              data: {
                walletId: wallet.id,
                authId,
                source: 'SUBSCRIPTION',
                sourceReference: `forged-${Math.random()}`,
                amount: 1000,
                remaining: 1000,
                grantedAt: new Date(),
                expiresAt: payment.periodEnd,
                subscriptionId: allocation.subscriptionId,
                paymentId: payment.id,
                periodStart: payment.periodStart,
                periodEnd: payment.periodEnd,
                ...overrides,
              },
            });
          });

        // The same period again (another reference): one per period.
        await expect(insert(userId, {})).rejects.toMatchObject({
          code: 'P2002',
        });
        // Another user's payment.
        await expect(
          insert(other, { subscriptionId: otherSubscription.id }),
        ).rejects.toThrow('must belong to the user and subscription');
        // A failed payment.
        await expect(
          insert(other, {
            subscriptionId: otherSubscription.id,
            paymentId: failedPayment.id,
            periodStart: failedPayment.periodStart,
            periodEnd: failedPayment.periodEnd,
            expiresAt: failedPayment.periodEnd,
          }),
        ).rejects.toThrow('require a successful payment');
        // No payment at all.
        await expect(
          insert(other, {
            subscriptionId: null,
            paymentId: null,
            periodStart: null,
            periodEnd: null,
          }),
        ).rejects.toThrow('require the successful payment that paid for them');

        await expect(proAllocations(userId)).resolves.toHaveLength(1);
        await expect(proAllocations(other)).resolves.toHaveLength(0);
      });
    });
  },
);
