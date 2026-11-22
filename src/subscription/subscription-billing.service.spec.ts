import { BillingInterval } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import { CreditAllowanceService } from './credit-allowance.service';
import {
  FAKE_WEBHOOK_SECRET,
  FakeStripeApi,
} from '../../test/support/fake-stripe-api';
import { freezeTime } from '../../test/support/freeze-time';
import {
  createInMemoryBillingPrisma,
  type InMemoryBillingPrisma,
} from '../../test/support/in-memory-billing-prisma';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import type { PrismaService } from '../common/services/prisma.service';
import { StripeCancellationService } from './stripe/stripe-cancellation.service';
import { StripeCheckoutService } from './stripe/stripe-checkout.service';
import { StripeRefundService } from './stripe/stripe-refund.service';
import { StripeWebhookService } from './stripe/stripe-webhook.service';
import { StripeGateway } from './stripe/stripe.gateway';
import { SubscriptionBillingService } from './subscription-billing.service';
import { SubscriptionPlanService } from './subscription-plan.service';
import { noCheckoutDiscounts } from '../../test/support/no-checkout-discounts';

const { MONTHLY, YEARLY } = BillingInterval;
const DAY = 24 * 60 * 60 * 1000;
/** Stripe timestamps have whole-second precision. */
const daysAgo = (days: number) =>
  new Date(Math.floor((Date.now() - days * DAY) / 1000) * 1000);

/** Provider identifiers, credentials and raw failure messages. */
const SENSITIVE =
  /\b(cus|sub|in|ch|re|pi|evt|cs|sk|rk|pk|whsec|price|prod|pm)_|Your card/;

describe('SubscriptionBillingService', () => {
  const plans = mock<SubscriptionPlanService>();
  const activityLog = mock<ActivityLogService>();
  const logger = mock<CustomLoggerService>();
  // Trial credits are covered by the credit tests.
  const credits = mock<CreditAllowanceService>();
  const meta = { ip: '192.0.2.4', userAgent: 'billing-spec' };
  let api: FakeStripeApi;
  let db: InMemoryBillingPrisma;
  let checkout: StripeCheckoutService;
  let cancellation: StripeCancellationService;
  let webhooks: StripeWebhookService;
  let billing: SubscriptionBillingService;

  const planView = (monthly = 1900, yearly = 19000) => ({
    code: 'PRO' as const,
    currency: 'USD' as const,
    planEnabled: true,
    monthlyPriceUsdCents: monthly,
    yearlyPriceUsdCents: yearly,
    trialEnabled: true,
    trialDays: 7,
    updatedAt: null,
  });

  beforeEach(() => {
    jest.resetAllMocks();
    plans.getProPlan.mockResolvedValue(planView());
    api = new FakeStripeApi();
    db = createInMemoryBillingPrisma();
    const prisma = db as unknown as PrismaService;
    const gateway = new StripeGateway(
      {
        secretKey: 'sk_test_fake',
        webhookSecret: FAKE_WEBHOOK_SECRET,
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
        productId: null,
        checkoutExpiresMinutes: 60,
      },
      api.client(),
    );
    checkout = new StripeCheckoutService(
      prisma,
      plans,
      gateway,
      logger,
      noCheckoutDiscounts(),
    );
    cancellation = new StripeCancellationService(
      prisma,
      gateway,
      activityLog,
      logger,
    );
    webhooks = new StripeWebhookService(
      prisma,
      gateway,
      activityLog,
      logger,
      cancellation,
      new StripeRefundService(prisma, gateway, activityLog, logger, credits),
      credits,
      noCheckoutDiscounts(),
    );
    billing = new SubscriptionBillingService(prisma);
  });

  const handle = (event: { payload: string; signature: string }, now?: Date) =>
    webhooks.handleEvent(
      webhooks.verifyEvent(Buffer.from(event.payload), event.signature),
      meta,
      now,
    );

  async function newUser() {
    return (await db.authUser.create({ data: {} })).id as string;
  }

  /** A user whose first payment (starting `startedDaysAgo` days ago) is recorded. */
  async function subscriber(
    startedDaysAgo = 10,
    interval: BillingInterval = MONTHLY,
  ) {
    const authId = await newUser();
    const view = await checkout.createCheckout(authId, interval);
    const sessionId = db.checkoutSession.rows.find(
      (row) => row.id === view.checkoutSessionId,
    )?.providerSessionId as string;
    const session = api.completeSession(sessionId, {
      periodStart: daysAgo(startedDaysAgo),
    });
    await handle(api.signedEvent('checkout.session.completed', sessionId));
    return {
      authId,
      sessionId,
      subscriptionId: session.subscription as string,
      invoiceId: session.invoice as string,
    };
  }

  const recordOf = (authId: string) =>
    db.userSubscription.rows.find((row) => row.authId === authId);
  const paymentRow = (invoiceId: string) =>
    db.paymentTransaction.rows.find(
      (row) => row.providerPaymentId === invoiceId,
    );
  const historyOf = async (authId: string) =>
    (await billing.getPaymentHistory(authId, { limit: 100 })).items;
  const isoOf = (value: unknown) => (value as Date).toISOString();

  describe('billing information', () => {
    it('describes a user who never paid', async () => {
      const authId = await newUser();

      await expect(billing.getBilling(authId)).resolves.toEqual({
        status: 'FREE',
        hasProAccess: false,
        accessExpiresAt: null,
        subscriptionState: 'NONE',
        plan: null,
        currentPeriod: null,
        autoRenew: false,
        nextRenewalAt: null,
        canceledAt: null,
        pastDueSince: null,
      });
    });

    it('shows a trial as access without a paid plan', async () => {
      const authId = await newUser();
      const trialExpiresAt = new Date(Date.now() + 5 * DAY);
      await db.userSubscription.create({
        data: {
          authId,
          status: 'TRIAL',
          trialUsed: true,
          trialStartedAt: daysAgo(2),
          trialExpiresAt,
        },
      });

      await expect(billing.getBilling(authId)).resolves.toMatchObject({
        status: 'TRIAL',
        hasProAccess: true,
        accessExpiresAt: trialExpiresAt.toISOString(),
        subscriptionState: 'NONE',
        plan: null,
        autoRenew: false,
      });
    });

    it('describes an active monthly subscription from the recorded payment', async () => {
      const { authId, invoiceId } = await subscriber(10);
      const payment = paymentRow(invoiceId);
      const record = recordOf(authId);

      await expect(billing.getBilling(authId)).resolves.toEqual({
        status: 'PRO',
        hasProAccess: true,
        accessExpiresAt: isoOf(record?.proExpiresAt),
        subscriptionState: 'ACTIVE',
        plan: {
          code: 'PRO',
          billingInterval: 'MONTHLY',
          priceCents: 1900,
          currency: 'USD',
        },
        currentPeriod: {
          start: isoOf(payment?.periodStart),
          end: isoOf(payment?.periodEnd),
        },
        autoRenew: true,
        nextRenewalAt: isoOf(record?.proExpiresAt),
        canceledAt: null,
        pastDueSince: null,
      });
    });

    it('shows the yearly plan and its price', async () => {
      const { authId } = await subscriber(3, YEARLY);
      await expect(billing.getBilling(authId)).resolves.toMatchObject({
        plan: { billingInterval: 'YEARLY', priceCents: 19000 },
        subscriptionState: 'ACTIVE',
      });
    });

    it('keeps showing the purchase price after an admin price change', async () => {
      const { authId } = await subscriber(10);
      plans.getProPlan.mockResolvedValue(planView(2900, 29000));

      await expect(billing.getBilling(authId)).resolves.toMatchObject({
        plan: { priceCents: 1900 },
      });
    });

    it('shows the renewed period as the current one after a renewal', async () => {
      const { authId, subscriptionId } = await subscriber(40);
      const renewal = api.renewSubscription(subscriptionId).id as string;
      await handle(api.signedInvoiceEvent('invoice.paid', renewal));
      const payment = paymentRow(renewal);

      await expect(billing.getBilling(authId)).resolves.toMatchObject({
        subscriptionState: 'ACTIVE',
        currentPeriod: {
          start: isoOf(payment?.periodStart),
          end: isoOf(payment?.periodEnd),
        },
        nextRenewalAt: isoOf(payment?.periodEnd),
      });
    });

    it('shows a cancellation: no renewal, access until the period ends', async () => {
      const { authId } = await subscriber(10);
      const canceled = await cancellation.cancelAtPeriodEnd(authId, meta);

      await expect(billing.getBilling(authId)).resolves.toMatchObject({
        status: 'PRO',
        hasProAccess: true,
        subscriptionState: 'CANCELED',
        autoRenew: false,
        nextRenewalAt: null,
        canceledAt: canceled.canceledAt,
        accessExpiresAt: canceled.endsAt,
        currentPeriod: { end: canceled.endsAt },
      });
    });

    it('shows a failed renewal as past due without a current period', async () => {
      const { authId, subscriptionId } = await subscriber(45);
      const invoice = api.renewSubscription(subscriptionId, { paid: false });
      await handle(
        api.signedInvoiceEvent('invoice.payment_failed', invoice.id as string),
      );

      await expect(billing.getBilling(authId)).resolves.toMatchObject({
        status: 'EXPIRED',
        hasProAccess: false,
        subscriptionState: 'PAST_DUE',
        currentPeriod: null,
        autoRenew: false,
        nextRenewalAt: null,
        pastDueSince: isoOf(recordOf(authId)?.pastDueSince),
        plan: { billingInterval: 'MONTHLY', priceCents: 1900 },
      });
    });

    it('shows a refunded subscription as ended immediately', async () => {
      const { authId, invoiceId } = await subscriber(10);
      api.refundInvoice(invoiceId);
      await handle(
        api.signedChargeEvent('charge.refunded', api.chargeOf(invoiceId)),
      );

      await expect(billing.getBilling(authId)).resolves.toMatchObject({
        status: 'EXPIRED',
        hasProAccess: false,
        subscriptionState: 'ENDED',
        currentPeriod: null,
        autoRenew: false,
        nextRenewalAt: null,
        plan: { billingInterval: 'MONTHLY' },
      });
    });

    it('follows the paid period boundary exactly', async () => {
      const { authId } = await subscriber(10);
      const expiry = recordOf(authId)?.proExpiresAt as Date;

      await expect(
        billing.getBilling(authId, new Date(expiry.getTime() - 1)),
      ).resolves.toMatchObject({
        subscriptionState: 'ACTIVE',
        hasProAccess: true,
      });
      await expect(billing.getBilling(authId, expiry)).resolves.toMatchObject({
        status: 'EXPIRED',
        subscriptionState: 'ENDED',
        hasProAccess: false,
        currentPeriod: null,
        nextRenewalAt: null,
      });
    });
  });

  describe('payment history', () => {
    it('is empty for a user without payments', async () => {
      const authId = await newUser();
      await expect(billing.getPaymentHistory(authId)).resolves.toEqual({
        items: [],
        meta: {
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
          hasPreviousPage: false,
          hasNextPage: false,
        },
      });
    });

    it('lists the first payment and renewals, newest first, as recorded', async () => {
      const { authId, invoiceId, subscriptionId } = await subscriber(40);
      const renewal = api.renewSubscription(subscriptionId).id as string;
      await handle(api.signedInvoiceEvent('invoice.paid', renewal));

      const items = await historyOf(authId);

      const first = paymentRow(invoiceId);
      const second = paymentRow(renewal);
      expect(items).toEqual([
        {
          id: second?.id,
          type: 'PAYMENT',
          purpose: 'RENEWAL',
          status: 'SUCCEEDED',
          amountCents: 1900,
          currency: 'USD',
          date: isoOf(second?.paidAt),
          billingInterval: 'MONTHLY',
          period: {
            start: isoOf(second?.periodStart),
            end: isoOf(second?.periodEnd),
          },
          refundedAmountCents: 0,
          paymentId: null,
          failureReason: null,
        },
        expect.objectContaining({
          id: first?.id,
          purpose: 'NEW_SUBSCRIPTION',
          status: 'SUCCEEDED',
          date: isoOf(first?.paidAt),
        }),
      ]);
    });

    it('includes failed renewal attempts and the recovered payment', async () => {
      const { authId, subscriptionId } = await subscriber(45);
      const invoiceId = api.renewSubscription(subscriptionId, {
        paid: false,
      }).id as string;
      await handle(api.signedInvoiceEvent('invoice.payment_failed', invoiceId));
      api.failInvoiceAttempt(invoiceId, { declineCode: 'expired_card' });
      await handle(api.signedInvoiceEvent('invoice.payment_failed', invoiceId));
      api.payInvoice(invoiceId);
      await handle(api.signedInvoiceEvent('invoice.paid', invoiceId));

      const renewalEntries = (await historyOf(authId)).filter(
        (entry) => entry.purpose === 'RENEWAL',
      );

      expect(
        renewalEntries.map((entry) => [entry.status, entry.failureReason]),
      ).toEqual(
        expect.arrayContaining([
          ['SUCCEEDED', null],
          ['FAILED', 'insufficient_funds'],
          ['FAILED', 'expired_card'],
        ]),
      );
      expect(renewalEntries).toHaveLength(3);
      for (const entry of renewalEntries) {
        expect(entry).toMatchObject({ amountCents: 1900, currency: 'USD' });
      }
    });

    it('includes a failed first payment, with a sensitive decline shown generically', async () => {
      const authId = await newUser();
      const view = await checkout.createCheckout(authId, YEARLY);
      const sessionId = db.checkoutSession.rows.find(
        (row) => row.id === view.checkoutSessionId,
      )?.providerSessionId as string;
      const invoiceId = api.failFirstPayment(sessionId, {
        declineCode: 'stolen_card',
        message: 'Your card was reported stolen.',
      }).id as string;
      await handle(api.signedInvoiceEvent('invoice.payment_failed', invoiceId));
      api.completeSession(sessionId);
      await handle(api.signedEvent('checkout.session.completed', sessionId));

      const items = await historyOf(authId);

      expect(
        items.map((entry) => [
          entry.purpose,
          entry.status,
          entry.failureReason,
        ]),
      ).toEqual([
        ['NEW_SUBSCRIPTION', 'SUCCEEDED', null],
        ['NEW_SUBSCRIPTION', 'FAILED', 'card_declined'],
      ]);
      expect(items[1]).toMatchObject({ amountCents: 19000, currency: 'USD' });
      expect(JSON.stringify(items)).not.toMatch(/stolen/);
    });

    it('includes partial and full refunds and the refunded payment status', async () => {
      const { authId, invoiceId } = await subscriber(10);
      const partial = api.refundInvoice(invoiceId, { amount: 500 });
      await handle(
        api.signedChargeEvent('charge.refunded', api.chargeOf(invoiceId)),
      );
      const pending = api.refundInvoice(invoiceId, {
        amount: 1400,
        status: 'pending',
      });
      await handle(
        api.signedRefundEvent('refund.created', pending.id as string),
      );

      const payment = paymentRow(invoiceId);
      const items = await historyOf(authId);
      const refunds = items.filter((entry) => entry.type === 'REFUND');

      expect(items.find((entry) => entry.type === 'PAYMENT')).toMatchObject({
        id: payment?.id,
        status: 'PARTIALLY_REFUNDED',
        amountCents: 1900,
        refundedAmountCents: 500,
      });
      expect(
        refunds
          .map((entry) => [entry.status, entry.amountCents, entry.paymentId])
          .sort(),
      ).toEqual(
        [
          ['PENDING', 1400, payment?.id],
          ['SUCCEEDED', 500, payment?.id],
        ].sort(),
      );
      expect(
        refunds.find((entry) => entry.status === 'SUCCEEDED'),
      ).toMatchObject({
        purpose: 'NEW_SUBSCRIPTION',
        currency: 'USD',
        date: new Date(Number(partial.created) * 1000).toISOString(),
        period: {
          start: isoOf(payment?.periodStart),
          end: isoOf(payment?.periodEnd),
        },
        refundedAmountCents: null,
      });

      api.setRefundStatus(pending.id as string, 'succeeded');
      await handle(
        api.signedRefundEvent('refund.updated', pending.id as string),
      );
      const after = await historyOf(authId);
      expect(after.find((entry) => entry.type === 'PAYMENT')).toMatchObject({
        status: 'REFUNDED',
        refundedAmountCents: 1900,
      });
      expect(
        after
          .filter((entry) => entry.type === 'REFUND')
          .map((entry) => entry.status),
      ).toEqual(['SUCCEEDED', 'SUCCEEDED']);
    });

    it('is not changed by a cancellation', async () => {
      const { authId } = await subscriber(10);
      const before = await historyOf(authId);
      await cancellation.cancelAtPeriodEnd(authId, meta);
      await expect(historyOf(authId)).resolves.toEqual(before);
    });

    it('matches the stored payments and refunds exactly', async () => {
      const { authId, invoiceId, subscriptionId } = await subscriber(40);
      const renewal = api.renewSubscription(subscriptionId).id as string;
      await handle(api.signedInvoiceEvent('invoice.paid', renewal));
      api.refundInvoice(invoiceId, { amount: 300 });
      await handle(
        api.signedChargeEvent('charge.refunded', api.chargeOf(invoiceId)),
      );

      const items = await historyOf(authId);
      const subscriptionId2 = recordOf(authId)?.id;
      const storedPayments = db.paymentTransaction.rows.filter(
        (row) => row.subscriptionId === subscriptionId2,
      );
      const storedRefunds = db.paymentRefund.rows.filter((row) =>
        storedPayments.some((payment) => payment.id === row.paymentId),
      );

      expect(items).toHaveLength(storedPayments.length + storedRefunds.length);
      for (const row of storedPayments) {
        expect(items).toContainEqual(
          expect.objectContaining({
            id: row.id,
            type: 'PAYMENT',
            status: row.status,
            amountCents: row.amountCents,
            currency: row.currency,
            refundedAmountCents: row.refundedAmountCents,
          }),
        );
      }
      for (const row of storedRefunds) {
        expect(items).toContainEqual(
          expect.objectContaining({
            id: row.id,
            type: 'REFUND',
            status: row.status,
            amountCents: row.amountCents,
            paymentId: row.paymentId,
          }),
        );
      }
    });

    it('orders entries by when the money moved, newest first', async () => {
      // Money moves on different days: purchase, renewal, refund, failure.
      const t0 = daysAgo(70);
      const at = (days: number) => new Date(t0.getTime() + days * DAY);
      try {
        freezeTime(at(0));
        const { authId, invoiceId, subscriptionId } = await subscriber(0);
        freezeTime(at(30));
        const renewal = api.renewSubscription(subscriptionId).id as string;
        await handle(api.signedInvoiceEvent('invoice.paid', renewal));
        freezeTime(at(40));
        api.refundInvoice(invoiceId, { amount: 200 });
        await handle(
          api.signedChargeEvent('charge.refunded', api.chargeOf(invoiceId)),
        );
        freezeTime(at(60));
        const failed = api.renewSubscription(subscriptionId, { paid: false });
        await handle(
          api.signedInvoiceEvent('invoice.payment_failed', failed.id as string),
        );
        jest.useRealTimers();

        const items = await historyOf(authId);

        expect(
          items.map((entry) => [entry.type, entry.purpose, entry.status]),
        ).toEqual([
          ['PAYMENT', 'RENEWAL', 'FAILED'],
          ['REFUND', 'NEW_SUBSCRIPTION', 'SUCCEEDED'],
          ['PAYMENT', 'RENEWAL', 'SUCCEEDED'],
          ['PAYMENT', 'NEW_SUBSCRIPTION', 'PARTIALLY_REFUNDED'],
        ]);
        expect(items.map((entry) => entry.date.slice(0, 10))).toEqual(
          [at(60), at(40), at(30), at(0)].map((d) =>
            d.toISOString().slice(0, 10),
          ),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('pages deterministically', async () => {
      const { authId, subscriptionId } = await subscriber(100);
      for (let i = 0; i < 3; i++) {
        const renewal = api.renewSubscription(subscriptionId).id as string;
        await handle(api.signedInvoiceEvent('invoice.paid', renewal));
      }
      const all = await historyOf(authId);

      const page1 = await billing.getPaymentHistory(authId, {
        page: 1,
        limit: 3,
      });
      const page2 = await billing.getPaymentHistory(authId, {
        page: 2,
        limit: 3,
      });
      const beyond = await billing.getPaymentHistory(authId, {
        page: 3,
        limit: 3,
      });

      expect(all).toHaveLength(4);
      expect([...page1.items, ...page2.items]).toEqual(all);
      expect(page1.meta).toEqual({
        page: 1,
        limit: 3,
        total: 4,
        totalPages: 2,
        hasPreviousPage: false,
        hasNextPage: true,
      });
      expect(page2.meta).toMatchObject({
        hasPreviousPage: true,
        hasNextPage: false,
      });
      expect(beyond.items).toEqual([]);
      const dates = all.map((entry) => entry.date);
      expect([...dates].sort().reverse()).toEqual(dates);
      await expect(historyOf(authId)).resolves.toEqual(all);
    });
  });

  describe('privacy', () => {
    it('only ever returns the caller’s own payments', async () => {
      const alice = await subscriber(10);
      const bob = await subscriber(10);
      api.refundInvoice(alice.invoiceId);
      await handle(
        api.signedChargeEvent('charge.refunded', api.chargeOf(alice.invoiceId)),
      );

      const aliceIds = new Set(
        (await historyOf(alice.authId)).map((entry) => entry.id),
      );
      const bobItems = await historyOf(bob.authId);

      expect(bobItems).toHaveLength(1);
      expect(bobItems.some((entry) => aliceIds.has(entry.id))).toBe(false);
      await expect(billing.getBilling(bob.authId)).resolves.toMatchObject({
        subscriptionState: 'ACTIVE',
      });
    });

    it('returns no provider identifiers, credentials or failure messages and calls no Stripe API', async () => {
      const { authId, subscriptionId, invoiceId } = await subscriber(45);
      const failedInvoice = api.renewSubscription(subscriptionId, {
        paid: false,
      }).id as string;
      await handle(
        api.signedInvoiceEvent('invoice.payment_failed', failedInvoice),
      );
      api.refundInvoice(invoiceId, { amount: 100 });
      await handle(
        api.signedChargeEvent('charge.refunded', api.chargeOf(invoiceId)),
      );
      const requests = api.requests.length;

      const output = JSON.stringify([
        await billing.getBilling(authId),
        await billing.getPaymentHistory(authId),
      ]);

      expect(output).not.toMatch(SENSITIVE);
      expect(api.requests).toHaveLength(requests);
      const keys = new Set<string>();
      const collect = (value: unknown) => {
        if (value && typeof value === 'object') {
          for (const [key, child] of Object.entries(value)) {
            keys.add(key);
            collect(child);
          }
        }
      };
      collect(JSON.parse(output));
      for (const key of [
        'provider',
        'providerPaymentId',
        'providerInvoiceId',
        'providerCustomerId',
        'providerSubscriptionId',
        'providerChargeId',
        'providerRefundId',
        'failureMessage',
        'authId',
        'subscriptionId',
      ]) {
        expect(keys.has(key)).toBe(false);
      }
    });
  });
});
