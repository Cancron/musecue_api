import { BillingInterval } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import { CreditAllowanceService } from '../credit-allowance.service';
import {
  FAKE_WEBHOOK_SECRET,
  FakeStripeApi,
} from '../../../test/support/fake-stripe-api';
import {
  createInMemoryBillingPrisma,
  type InMemoryBillingPrisma,
} from '../../../test/support/in-memory-billing-prisma';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import type { PrismaService } from '../../common/services/prisma.service';
import { resolveSubscriptionAccess } from '../subscription-access.policy';
import { SubscriptionPlanService } from '../subscription-plan.service';
import { StripeCancellationService } from './stripe-cancellation.service';
import { StripeCheckoutService } from './stripe-checkout.service';
import { StripeRefundService } from './stripe-refund.service';
import {
  StripeWebhookService,
  type WebhookOutcome,
} from './stripe-webhook.service';
import { StripeGateway } from './stripe.gateway';
import {
  noCheckoutDiscounts,
  noReferralRewards,
} from '../../../test/support/no-checkout-discounts';

const { MONTHLY, YEARLY } = BillingInterval;
const DAY = 24 * 60 * 60 * 1000;
/** Stripe timestamps have whole-second precision. */
const daysAgo = (days: number) =>
  new Date(Math.floor((Date.now() - days * DAY) / 1000) * 1000);

describe('StripeRefundService (refund webhooks)', () => {
  const plans = mock<SubscriptionPlanService>();
  const activityLog = mock<ActivityLogService>();
  const logger = mock<CustomLoggerService>();
  // Trial credits are covered by the credit tests.
  const credits = mock<CreditAllowanceService>();
  const meta = { ip: '203.0.113.9', userAgent: 'Stripe/1.0' };
  let api: FakeStripeApi;
  let db: InMemoryBillingPrisma;
  let checkout: StripeCheckoutService;
  let webhooks: StripeWebhookService;

  beforeEach(() => {
    jest.resetAllMocks();
    plans.getProPlan.mockResolvedValue({
      code: 'PRO',
      currency: 'USD',
      planEnabled: true,
      monthlyPriceUsdCents: 1900,
      yearlyPriceUsdCents: 19000,
      trialEnabled: true,
      trialDays: 7,
      updatedAt: null,
    });
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
    webhooks = new StripeWebhookService(
      prisma,
      gateway,
      activityLog,
      logger,
      new StripeCancellationService(prisma, gateway, activityLog, logger),
      new StripeRefundService(prisma, gateway, activityLog, logger, credits),
      credits,
      noCheckoutDiscounts(),
      noReferralRewards(),
    );
  });

  const handle = (
    event: { payload: string; signature: string },
    now?: Date,
  ): Promise<WebhookOutcome> =>
    webhooks.handleEvent(
      webhooks.verifyEvent(Buffer.from(event.payload), event.signature),
      meta,
      now,
    );

  /** A user whose first payment (starting `startedDaysAgo` days ago) is recorded. */
  async function subscriber(
    startedDaysAgo = 10,
    interval: BillingInterval = MONTHLY,
  ) {
    const user = await db.authUser.create({ data: {} });
    const authId = user.id as string;
    const view = await checkout.createCheckout(authId, interval);
    const row = db.checkoutSession.rows.find(
      (candidate) => candidate.id === view.checkoutSessionId,
    );
    const sessionId = row?.providerSessionId as string;
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

  /** Stripe renews the subscription and the renewal is recorded. */
  async function renewed(subscriptionId: string) {
    const invoiceId = api.renewSubscription(subscriptionId).id as string;
    await handle(api.signedInvoiceEvent('invoice.paid', invoiceId));
    return invoiceId;
  }

  const recordOf = (authId: string) =>
    db.userSubscription.rows.find((row) => row.authId === authId);
  const paymentOf = (invoiceId: string) =>
    db.paymentTransaction.rows.find(
      (row) => row.providerPaymentId === invoiceId,
    );
  const refundsOf = (invoiceId: string) =>
    db.paymentRefund.rows.filter(
      (row) => row.paymentId === paymentOf(invoiceId)?.id,
    );
  const eventsOf = (authId: string) =>
    db.subscriptionEvent.rows
      .filter((row) => row.subscriptionId === recordOf(authId)?.id)
      .map((row) => row.type);
  const hasAccess = (authId: string, at: Date) =>
    resolveSubscriptionAccess(
      recordOf(authId) as unknown as Parameters<
        typeof resolveSubscriptionAccess
      >[0],
      at,
    ).hasProAccess;
  const chargeRefunded = (invoiceId: string, now?: Date) =>
    handle(
      api.signedChargeEvent('charge.refunded', api.chargeOf(invoiceId)),
      now,
    );

  it('records refunds of a detached payment without recreating deleted account data', async () => {
    const { invoiceId } = await subscriber(10);
    const payment = paymentOf(invoiceId)!;
    const original = {
      id: payment.id,
      amountCents: payment.amountCents,
      providerPaymentId: payment.providerPaymentId,
    };
    payment.subscriptionId = null;
    db.userSubscription.rows.splice(0);
    db.subscriptionEvent.rows.splice(0);
    db.paymentCustomer.rows.splice(0);
    api.refundInvoice(invoiceId);

    await expect(chargeRefunded(invoiceId)).resolves.toBe('REFUNDED');
    expect(paymentOf(invoiceId)).toMatchObject({
      ...original,
      subscriptionId: null,
      status: 'REFUNDED',
      refundedAmountCents: 1900,
    });
    expect(refundsOf(invoiceId)).toHaveLength(1);
    expect(db.userSubscription.rows).toHaveLength(0);
    expect(db.subscriptionEvent.rows).toHaveLength(0);
    await expect(chargeRefunded(invoiceId)).resolves.toBe('ALREADY_PROCESSED');
    expect(refundsOf(invoiceId)).toHaveLength(1);
  });

  describe('a full refund', () => {
    it('records the refund, marks the payment REFUNDED and revokes access now', async () => {
      const { authId, invoiceId } = await subscriber(10);
      const before = { ...recordOf(authId) };
      const refund = api.refundInvoice(invoiceId, { reason: 'fraudulent' });
      const now = new Date();

      await expect(chargeRefunded(invoiceId, now)).resolves.toBe('REFUNDED');

      const refundedAt = new Date(Number(refund.created) * 1000);
      expect(refundsOf(invoiceId)).toEqual([
        expect.objectContaining({
          provider: 'stripe',
          providerRefundId: refund.id,
          providerChargeId: api.chargeOf(invoiceId),
          status: 'SUCCEEDED',
          amountCents: 1900,
          currency: 'USD',
          reason: 'fraudulent',
          providerCreatedAt: refundedAt,
        }),
      ]);
      expect(paymentOf(invoiceId)).toMatchObject({
        status: 'REFUNDED',
        amountCents: 1900,
        refundedAmountCents: 1900,
        refundedAt,
        paidAt: expect.any(Date) as Date,
      });
      // The paid period had not ended: access ends now, not at expiry.
      expect(recordOf(authId)).toMatchObject({
        status: 'EXPIRED',
        proStartedAt: before.proStartedAt,
        proExpiresAt: now,
        trialUsed: before.trialUsed,
      });
      expect(hasAccess(authId, new Date(now.getTime() - 1))).toBe(true);
      expect(hasAccess(authId, now)).toBe(false);
      expect(eventsOf(authId)).toEqual(['CREATED', 'PAYMENT_REFUNDED']);
      // The payment's Pro credits end with its access, in the same transaction.
      expect(credits.endRefundedPaymentCredits.mock.calls).toEqual([
        [expect.anything(), authId, paymentOf(invoiceId)?.id, now],
      ]);
      expect(activityLog.logActivity.mock.calls.at(-1)?.[0]).toMatchObject({
        tableName: 'UserSubscription',
        changes: [
          {
            fieldName: 'proExpiresAt',
            oldValue: (before.proExpiresAt as Date).toISOString(),
            newValue: now.toISOString(),
          },
          { fieldName: 'status', oldValue: 'PRO', newValue: 'EXPIRED' },
        ],
        metadata: { ...meta, actionedBy: null },
      });
    });

    it('revokes a yearly subscription immediately as well', async () => {
      const { authId, invoiceId } = await subscriber(30, YEARLY);
      api.refundInvoice(invoiceId);
      const now = new Date();

      await chargeRefunded(invoiceId, now);

      expect(paymentOf(invoiceId)).toMatchObject({
        status: 'REFUNDED',
        refundedAmountCents: 19000,
      });
      expect(recordOf(authId)?.proExpiresAt).toEqual(now);
      expect(hasAccess(authId, now)).toBe(false);
    });
  });

  describe('a partial refund', () => {
    it('marks the payment PARTIALLY_REFUNDED and revokes access now', async () => {
      const { authId, invoiceId } = await subscriber(10);
      const refund = api.refundInvoice(invoiceId, { amount: 500 });
      const now = new Date();

      await expect(chargeRefunded(invoiceId, now)).resolves.toBe('REFUNDED');

      expect(paymentOf(invoiceId)).toMatchObject({
        status: 'PARTIALLY_REFUNDED',
        amountCents: 1900,
        refundedAmountCents: 500,
        refundedAt: new Date(Number(refund.created) * 1000),
      });
      expect(refundsOf(invoiceId)).toEqual([
        expect.objectContaining({ amountCents: 500, status: 'SUCCEEDED' }),
      ]);
      expect(recordOf(authId)).toMatchObject({
        status: 'EXPIRED',
        proExpiresAt: now,
      });
    });

    it('completes to REFUNDED on a later refund without restoring or moving access', async () => {
      const { authId, invoiceId } = await subscriber(10);
      api.refundInvoice(invoiceId, { amount: 500 });
      const first = new Date();
      await chargeRefunded(invoiceId, first);
      api.refundInvoice(invoiceId, { amount: 1400 });

      await expect(
        chargeRefunded(invoiceId, new Date(first.getTime() + 60_000)),
      ).resolves.toBe('REFUNDED');

      expect(paymentOf(invoiceId)).toMatchObject({
        status: 'REFUNDED',
        refundedAmountCents: 1900,
      });
      expect(
        refundsOf(invoiceId)
          .map((row) => row.amountCents)
          .sort(),
      ).toEqual([1400, 500]);
      // Revoked at the first refund; the second one changes nothing more.
      expect(recordOf(authId)?.proExpiresAt).toEqual(first);
      expect(eventsOf(authId)).toEqual([
        'CREATED',
        'PAYMENT_REFUNDED',
        'PAYMENT_REFUNDED',
      ]);
    });
  });

  describe('repeated and delayed events', () => {
    it('records a refund once however often its events arrive', async () => {
      const { authId, invoiceId } = await subscriber(10);
      const refund = api.refundInvoice(invoiceId);
      const now = new Date();
      const events = [
        api.signedChargeEvent('charge.refunded', api.chargeOf(invoiceId)),
        api.signedRefundEvent('refund.created', refund.id as string),
        api.signedRefundEvent('charge.refund.updated', refund.id as string),
        api.signedRefundEvent('refund.updated', refund.id as string),
      ];

      const outcomes = await Promise.all(
        [...events, ...events].map((event) => handle(event, now)),
      );
      const after = { ...recordOf(authId) };
      await expect(
        handle(events[0], new Date(now.getTime() + DAY)),
      ).resolves.toBe('ALREADY_PROCESSED');

      expect(outcomes.filter((o) => o === 'REFUNDED')).toHaveLength(1);
      expect(
        outcomes
          .filter((o) => o !== 'REFUNDED')
          .every((o) => o === 'ALREADY_PROCESSED'),
      ).toBe(true);
      expect(refundsOf(invoiceId)).toHaveLength(1);
      expect(eventsOf(authId)).toEqual(['CREATED', 'PAYMENT_REFUNDED']);
      expect(recordOf(authId)).toEqual(after);
      expect(recordOf(authId)?.proExpiresAt).toEqual(now);
    });

    it('never restores access from a stale refund event', async () => {
      const { authId, invoiceId } = await subscriber(10);
      const refund = api.refundInvoice(invoiceId, { status: 'pending' });
      const stalePending = api.signedRefundEvent(
        'refund.created',
        refund.id as string,
      );
      api.setRefundStatus(refund.id as string, 'succeeded');
      const now = new Date();
      await chargeRefunded(invoiceId, now);
      const after = { ...recordOf(authId) };

      // The old "pending" event arrives last: Stripe's current state wins.
      await expect(handle(stalePending)).resolves.toBe('ALREADY_PROCESSED');

      expect(recordOf(authId)).toEqual(after);
      expect(refundsOf(invoiceId)[0]?.status).toBe('SUCCEEDED');
      expect(hasAccess(authId, new Date())).toBe(false);
    });

    it('does not give access back when the refunded payment’s own events are replayed', async () => {
      const { authId, sessionId, invoiceId } = await subscriber(10);
      api.refundInvoice(invoiceId);
      const now = new Date();
      await chargeRefunded(invoiceId, now);
      const after = { ...recordOf(authId) };

      await expect(
        handle(api.signedEvent('checkout.session.completed', sessionId)),
      ).resolves.toBe('ALREADY_PROCESSED');
      await expect(
        handle(api.signedInvoiceEvent('invoice.paid', invoiceId)),
      ).resolves.toBe('ALREADY_PROCESSED');

      expect(recordOf(authId)).toEqual(after);
      expect(hasAccess(authId, new Date())).toBe(false);
    });

    it('leaves newer payments and their access untouched when an old payment is refunded late', async () => {
      const { authId, subscriptionId, invoiceId: first } = await subscriber(40);
      const second = await renewed(subscriptionId);
      const before = { ...recordOf(authId) };
      const secondPayment = { ...paymentOf(second) };
      api.refundInvoice(first);

      await expect(chargeRefunded(first)).resolves.toBe('REFUNDED');

      // The first period is over; the current access was paid by the renewal.
      expect(paymentOf(first)).toMatchObject({ status: 'REFUNDED' });
      expect(paymentOf(second)).toEqual(secondPayment);
      expect(recordOf(authId)).toMatchObject({
        status: 'PRO',
        proStartedAt: before.proStartedAt,
        proExpiresAt: before.proExpiresAt,
      });
      expect(hasAccess(authId, new Date())).toBe(true);
      expect(eventsOf(authId)).toEqual([
        'CREATED',
        'RENEWED',
        'PAYMENT_REFUNDED',
      ]);
      // Its month is over; the renewal's credits stay.
      expect(credits.endRefundedPaymentCredits.mock.calls).toHaveLength(0);
    });
  });

  describe('a new paid period after a refund', () => {
    it('grants access again for a renewal paid after the refund', async () => {
      // First period: 35 to ~5 days ago. It was refunded while it ran.
      const { authId, subscriptionId, invoiceId } = await subscriber(35);
      const refundedAt = new Date(daysAgo(35).getTime() + 10 * DAY);
      api.refundInvoice(invoiceId);
      await chargeRefunded(invoiceId, refundedAt);
      expect(recordOf(authId)?.proExpiresAt).toEqual(refundedAt);
      expect(hasAccess(authId, new Date())).toBe(false);

      // Stripe still billed the next period (which contains today): paid.
      const next = await renewed(subscriptionId);

      const nextPayment = paymentOf(next);
      expect(nextPayment).toMatchObject({ status: 'SUCCEEDED' });
      expect(recordOf(authId)).toMatchObject({
        status: 'PRO',
        proStartedAt: nextPayment?.periodStart,
        proExpiresAt: nextPayment?.periodEnd,
      });
      expect(hasAccess(authId, new Date())).toBe(true);
      // The gap between the refund and the new period stays without access.
      expect(hasAccess(authId, new Date(refundedAt.getTime() + DAY))).toBe(
        false,
      );
      // The refunded payment keeps its refund.
      expect(paymentOf(invoiceId)).toMatchObject({ status: 'REFUNDED' });
    });
  });

  describe('refund states', () => {
    it('records a pending refund without changing the payment or access, then applies it when it succeeds', async () => {
      const { authId, invoiceId } = await subscriber(10);
      const before = { ...recordOf(authId) };
      const refund = api.refundInvoice(invoiceId, { status: 'pending' });

      await expect(
        handle(api.signedRefundEvent('refund.created', refund.id as string)),
      ).resolves.toBe('REFUND_RECORDED');

      expect(refundsOf(invoiceId)).toEqual([
        expect.objectContaining({ status: 'PENDING', amountCents: 1900 }),
      ]);
      expect(paymentOf(invoiceId)).toMatchObject({
        status: 'SUCCEEDED',
        refundedAmountCents: 0,
      });
      expect(recordOf(authId)).toEqual(before);

      api.setRefundStatus(refund.id as string, 'succeeded');
      const now = new Date();
      await expect(
        handle(
          api.signedRefundEvent('refund.updated', refund.id as string),
          now,
        ),
      ).resolves.toBe('REFUNDED');
      expect(refundsOf(invoiceId)[0]?.status).toBe('SUCCEEDED');
      expect(paymentOf(invoiceId)).toMatchObject({ status: 'REFUNDED' });
      expect(recordOf(authId)?.proExpiresAt).toEqual(now);
    });

    it('records a failed refund without changing the payment or access', async () => {
      const { authId, invoiceId } = await subscriber(10);
      const before = { ...recordOf(authId) };
      const refund = api.refundInvoice(invoiceId, { status: 'pending' });
      await handle(
        api.signedRefundEvent('refund.created', refund.id as string),
      );
      api.setRefundStatus(refund.id as string, 'failed');

      await expect(
        handle(api.signedRefundEvent('refund.failed', refund.id as string)),
      ).resolves.toBe('REFUND_RECORDED');

      expect(refundsOf(invoiceId)[0]?.status).toBe('FAILED');
      expect(paymentOf(invoiceId)).toMatchObject({ status: 'SUCCEEDED' });
      expect(recordOf(authId)).toEqual(before);
      expect(eventsOf(authId)).toEqual(['CREATED']);
    });

    it('applies a new full refund after an earlier refund was canceled', async () => {
      const { authId, invoiceId } = await subscriber(10);
      const canceled = api.refundInvoice(invoiceId, { status: 'pending' });
      api.setRefundStatus(canceled.id as string, 'canceled');
      api.refundInvoice(invoiceId);
      const now = new Date();

      await expect(chargeRefunded(invoiceId, now)).resolves.toBe('REFUNDED');

      expect(
        refundsOf(invoiceId)
          .map((row) => [row.status, row.amountCents])
          .sort(),
      ).toEqual([
        ['CANCELED', 1900],
        ['SUCCEEDED', 1900],
      ]);
      expect(paymentOf(invoiceId)).toMatchObject({
        status: 'REFUNDED',
        refundedAmountCents: 1900,
      });
      expect(recordOf(authId)?.proExpiresAt).toEqual(now);
    });

    it('keeps a succeeded refund and the revocation if Stripe later reports it failed', async () => {
      const { authId, invoiceId } = await subscriber(10);
      const refund = api.refundInvoice(invoiceId);
      const now = new Date();
      await chargeRefunded(invoiceId, now);
      const after = { ...recordOf(authId) };
      api.setRefundStatus(refund.id as string, 'failed');

      await expect(
        handle(api.signedRefundEvent('refund.failed', refund.id as string)),
      ).resolves.toBe('ALREADY_PROCESSED');

      expect(refundsOf(invoiceId)[0]?.status).toBe('SUCCEEDED');
      expect(paymentOf(invoiceId)).toMatchObject({ status: 'REFUNDED' });
      expect(recordOf(authId)).toEqual(after);
      expect(logger.logWithMetadata.mock.calls).toContainEqual([
        'error',
        expect.stringContaining('change to a final refund'),
        expect.objectContaining({ recorded: 'SUCCEEDED', reported: 'FAILED' }),
      ]);
    });
  });

  describe('which payments are affected', () => {
    it('refunds a duplicate payment without touching the access of the original one', async () => {
      const { authId } = await subscriber(10);
      const before = { ...recordOf(authId) };
      // A second checkout was paid while the term was active (the
      // DUPLICATE_PAYMENT case): it records the payment but grants nothing.
      const opened = await db.checkoutSession.create({
        data: {
          subscriptionId: before.id,
          provider: 'stripe',
          providerCustomerId: db.paymentCustomer.rows[0]?.providerCustomerId,
          billingInterval: MONTHLY,
          amountCents: 1900,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      const session = await api.client().checkout.sessions.create({
        mode: 'subscription',
        customer: opened.providerCustomerId as string,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        metadata: { checkoutSessionId: opened.id as string },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: 1900,
              recurring: { interval: 'month' },
              product_data: { name: 'MuseCue Pro' },
            },
          },
        ],
      });
      await db.checkoutSession.updateMany({
        where: { id: opened.id },
        data: { status: 'OPEN', providerSessionId: session.id, url: 'x' },
      });
      const paid = api.completeSession(session.id);
      await expect(
        handle(api.signedEvent('checkout.session.completed', session.id)),
      ).resolves.toBe('DUPLICATE_PAYMENT');
      const duplicateInvoice = paid.invoice as string;
      api.refundInvoice(duplicateInvoice);

      await expect(chargeRefunded(duplicateInvoice)).resolves.toBe('REFUNDED');

      expect(paymentOf(duplicateInvoice)).toMatchObject({ status: 'REFUNDED' });
      expect(recordOf(authId)).toMatchObject({
        status: 'PRO',
        proExpiresAt: before.proExpiresAt,
      });
      expect(hasAccess(authId, new Date())).toBe(true);
    });

    it('ignores a refund of a charge that paid no MuseCue invoice', async () => {
      const { invoiceId } = await subscriber(10);
      api.refundInvoice(invoiceId);
      const chargeId = api.chargeOf(invoiceId);
      const charge = api.charges.get(chargeId) as Record<string, unknown>;
      charge.payment_intent = 'pi_elsewhere';
      const payments = db.paymentTransaction.rows.length;

      await expect(
        handle(api.signedChargeEvent('charge.refunded', chargeId)),
      ).resolves.toBe('UNKNOWN_PAYMENT');
      expect(db.paymentRefund.rows).toHaveLength(0);
      expect(db.paymentTransaction.rows).toHaveLength(payments);
    });

    it('rejects a charge of another customer and records nothing', async () => {
      const { authId, invoiceId } = await subscriber(10);
      const before = { ...recordOf(authId) };
      api.refundInvoice(invoiceId);
      const charge = api.charges.get(api.chargeOf(invoiceId)) as Record<
        string,
        unknown
      >;
      charge.customer = 'cus_someone_else';

      await expect(chargeRefunded(invoiceId)).resolves.toBe('REJECTED');
      expect(db.paymentRefund.rows).toHaveLength(0);
      expect(paymentOf(invoiceId)).toMatchObject({ status: 'SUCCEEDED' });
      expect(recordOf(authId)).toEqual(before);
    });

    it('asks Stripe to retry a refund of a payment that is not recorded yet, and applies it once the payment is recorded', async () => {
      const user = await db.authUser.create({ data: {} });
      const authId = user.id as string;
      const view = await checkout.createCheckout(authId, MONTHLY);
      const sessionId = db.checkoutSession.rows.find(
        (row) => row.id === view.checkoutSessionId,
      )?.providerSessionId as string;
      const session = api.completeSession(sessionId, {
        periodStart: daysAgo(3),
      });
      const invoiceId = session.invoice as string;
      // Refunded before MuseCue processed the payment.
      api.refundInvoice(invoiceId);

      await expect(chargeRefunded(invoiceId)).rejects.toMatchObject({
        status: 503,
      });
      expect(db.paymentRefund.rows).toHaveLength(0);

      // The payment event arrives: the refund Stripe already made is applied
      // in the same delivery, so the refunded payment grants no access now.
      const now = new Date();
      await expect(
        handle(api.signedEvent('checkout.session.completed', sessionId), now),
      ).resolves.toBe('ACTIVATED');
      expect(db.paymentTransaction.rows).toEqual([
        expect.objectContaining({
          status: 'REFUNDED',
          refundedAmountCents: 1900,
        }),
      ]);
      expect(recordOf(authId)?.proExpiresAt).toEqual(now);
      expect(hasAccess(authId, now)).toBe(false);

      // Stripe's retried refund event then changes nothing.
      await expect(chargeRefunded(invoiceId, now)).resolves.toBe(
        'ALREADY_PROCESSED',
      );
      expect(db.paymentRefund.rows).toHaveLength(1);
      expect(db.subscriptionEvent.rows.map((row) => row.type).sort()).toEqual([
        'CREATED',
        'PAYMENT_REFUNDED',
      ]);
    });

    it('applies a partial refund of a renewal made before the renewal was recorded', async () => {
      const { authId, subscriptionId } = await subscriber(35);
      const renewal = api.renewSubscription(subscriptionId).id as string;
      api.refundInvoice(renewal, { amount: 500 });
      await expect(chargeRefunded(renewal)).rejects.toMatchObject({
        status: 503,
      });

      const now = new Date();
      await expect(
        handle(api.signedInvoiceEvent('invoice.paid', renewal), now),
      ).resolves.toBe('RENEWED');

      expect(paymentOf(renewal)).toMatchObject({
        status: 'PARTIALLY_REFUNDED',
        refundedAmountCents: 500,
      });
      expect(recordOf(authId)?.proExpiresAt).toEqual(now);
      expect(hasAccess(authId, now)).toBe(false);
      expect(eventsOf(authId)).toEqual([
        'CREATED',
        'RENEWED',
        'PAYMENT_REFUNDED',
      ]);
    });

    it('keeps the payment recorded when Stripe cannot be asked about refunds; the retried refund event applies it', async () => {
      const user = await db.authUser.create({ data: {} });
      const authId = user.id as string;
      const view = await checkout.createCheckout(authId, MONTHLY);
      const sessionId = db.checkoutSession.rows.find(
        (row) => row.id === view.checkoutSessionId,
      )?.providerSessionId as string;
      const invoiceId = api.completeSession(sessionId, {
        periodStart: daysAgo(3),
      }).invoice as string;
      api.refundInvoice(invoiceId);
      api.failNext('GET /v1/invoice_payments', 'connection');

      await expect(
        handle(api.signedEvent('checkout.session.completed', sessionId)),
      ).resolves.toBe('ACTIVATED');
      expect(paymentOf(invoiceId)?.status).toBe('SUCCEEDED');

      const now = new Date();
      await expect(chargeRefunded(invoiceId, now)).resolves.toBe('REFUNDED');
      expect(paymentOf(invoiceId)?.status).toBe('REFUNDED');
      expect(hasAccess(authId, now)).toBe(false);
    });

    it('makes no extra Stripe call for a payment without refunds beyond finding its charge', async () => {
      const { invoiceId } = await subscriber(3);
      expect(paymentOf(invoiceId)?.status).toBe('SUCCEEDED');
      expect(db.paymentRefund.rows).toHaveLength(0);
      expect(api.count('GET', /^\/v1\/refunds/)).toBe(0);
    });
  });

  it('refuses a new checkout after a refund while the Stripe subscription can still renew', async () => {
    const { authId, invoiceId, subscriptionId } = await subscriber(10);
    api.refundInvoice(invoiceId);
    await chargeRefunded(invoiceId);
    expect(hasAccess(authId, new Date())).toBe(false);

    await expect(
      checkout.createCheckout(authId, MONTHLY),
    ).rejects.toMatchObject({ status: 409 });

    api.cancelSubscription(subscriptionId);
    await expect(
      checkout.createCheckout(authId, MONTHLY),
    ).resolves.toMatchObject({ status: 'OPEN' });
  });

  it('keeps the trial history of a former trial user', async () => {
    const { authId, invoiceId } = await subscriber(10);
    const trial = {
      trialUsed: true,
      trialStartedAt: daysAgo(30),
      trialExpiresAt: daysAgo(23),
    };
    await db.userSubscription.updateMany({ where: { authId }, data: trial });
    api.refundInvoice(invoiceId);

    await chargeRefunded(invoiceId);

    expect(recordOf(authId)).toMatchObject({ ...trial, status: 'EXPIRED' });
  });
});
