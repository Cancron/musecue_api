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
import { addBillingInterval } from '../billing.validation';
import { resolveSubscriptionAccess } from '../subscription-access.policy';
import { SubscriptionPlanService } from '../subscription-plan.service';
import { StripeCancellationService } from './stripe-cancellation.service';
import { StripeCheckoutService } from './stripe-checkout.service';
import { StripeRefundService } from './stripe-refund.service';
import {
  StripeWebhookService,
  type VerifiedStripeEvent,
  type WebhookOutcome,
} from './stripe-webhook.service';
import { StripeGateway } from './stripe.gateway';

const { MONTHLY, YEARLY } = BillingInterval;
const DAY = 24 * 60 * 60 * 1000;

describe('StripeWebhookService', () => {
  const plans = mock<SubscriptionPlanService>();
  const activityLog = mock<ActivityLogService>();
  const logger = mock<CustomLoggerService>();
  // Trial credits are covered by the credit tests.
  const credits = mock<CreditAllowanceService>();
  const meta = { ip: '203.0.113.5', userAgent: 'Stripe/1.0' };
  let api: FakeStripeApi;
  let db: InMemoryBillingPrisma;
  let gateway: StripeGateway;
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
    gateway = new StripeGateway(
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
    const prisma = db as unknown as PrismaService;
    checkout = new StripeCheckoutService(prisma, plans, gateway, logger);
    webhooks = new StripeWebhookService(
      prisma,
      gateway,
      activityLog,
      logger,
      new StripeCancellationService(prisma, gateway, activityLog, logger),
      new StripeRefundService(prisma, gateway, activityLog, logger),
      credits,
    );
  });

  /** A user with an open checkout; returns ids for the test. */
  async function openCheckout(interval: BillingInterval = MONTHLY) {
    const user = await db.authUser.create({ data: {} });
    const authId = user.id as string;
    const view = await checkout.createCheckout(authId, interval);
    const row = db.checkoutSession.rows.find(
      (candidate) => candidate.id === view.checkoutSessionId,
    );
    return {
      authId,
      checkoutId: view.checkoutSessionId,
      sessionId: row?.providerSessionId as string,
    };
  }

  /** Delivers a webhook through signature verification, like the controller. */
  const deliver = (
    type: string,
    sessionId: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const { payload, signature } = api.signedEvent(type, sessionId, overrides);
    const event = webhooks.verifyEvent(Buffer.from(payload), signature);
    return webhooks.handleEvent(event, meta);
  };

  const recordOf = (authId: string) =>
    db.userSubscription.rows.find((row) => row.authId === authId);
  const checkoutRow = (id: string) =>
    db.checkoutSession.rows.find((row) => row.id === id);
  const accessOf = (authId: string, at = new Date()) =>
    resolveSubscriptionAccess(
      recordOf(authId) as unknown as Parameters<
        typeof resolveSubscriptionAccess
      >[0],
      at,
    );

  const expectNoPaidAccess = (authId: string) => {
    expect(db.paymentTransaction.rows).toHaveLength(0);
    expect(db.subscriptionEvent.rows).toHaveLength(0);
    expect(recordOf(authId)?.proStartedAt ?? null).toBeNull();
    expect(accessOf(authId).hasProAccess).toBe(false);
  };

  describe('checkout.session.completed', () => {
    it('records the verified payment and activates the paid term', async () => {
      const { authId, checkoutId, sessionId } = await openCheckout(MONTHLY);
      const periodStart = new Date();
      periodStart.setUTCMilliseconds(0);
      api.completeSession(sessionId, { periodStart });
      const session = api.sessions.get(sessionId) as Record<string, string>;

      await expect(
        deliver('checkout.session.completed', sessionId),
      ).resolves.toBe('ACTIVATED');

      const periodEnd = addBillingInterval(periodStart, MONTHLY);
      const subscriptionId = recordOf(authId)?.id;
      expect(db.paymentTransaction.rows).toEqual([
        expect.objectContaining({
          subscriptionId,
          provider: 'stripe',
          providerPaymentId: session.invoice,
          status: 'SUCCEEDED',
          amountCents: 1900,
          currency: 'USD',
          billingInterval: 'MONTHLY',
          periodStart,
          periodEnd,
          paidAt: expect.any(Date) as Date,
        }),
      ]);
      const paymentId = db.paymentTransaction.rows[0].id;
      expect(recordOf(authId)).toMatchObject({
        status: 'PRO',
        billingInterval: 'MONTHLY',
        proStartedAt: periodStart,
        proExpiresAt: periodEnd,
        proCanceledAt: null,
        paymentProvider: 'stripe',
        providerSubscriptionId: session.subscription,
      });
      expect(db.subscriptionEvent.rows).toEqual([
        expect.objectContaining({ subscriptionId, type: 'CREATED', paymentId }),
      ]);
      expect(checkoutRow(checkoutId)).toMatchObject({
        status: 'COMPLETED',
        paymentId,
        providerSubscriptionId: session.subscription,
        completedAt: expect.any(Date) as Date,
      });
      expect(accessOf(authId)).toMatchObject({
        hasProAccess: true,
        accessSource: 'PRO',
        accessExpiresAt: periodEnd,
      });
      expect(activityLog.logActivity.mock.calls).toContainEqual([
        expect.objectContaining({
          tableName: 'UserSubscription',
          recordId: subscriptionId,
          action: 'update',
          metadata: { ...meta, actionedBy: null },
        }),
        db,
      ]);
    });

    it('activates the yearly option for a calendar year', async () => {
      const { authId, sessionId } = await openCheckout(YEARLY);
      const periodStart = new Date('2028-02-29T12:00:00.000Z');
      api.completeSession(sessionId, { periodStart });

      await deliver('checkout.session.completed', sessionId);

      expect(recordOf(authId)).toMatchObject({
        billingInterval: 'YEARLY',
        proStartedAt: periodStart,
        proExpiresAt: new Date('2029-02-28T12:00:00.000Z'),
      });
      expect(db.paymentTransaction.rows[0]).toMatchObject({
        amountCents: 19000,
      });
    });

    it('keeps the trial history when a trial user pays', async () => {
      const { authId, sessionId } = await openCheckout();
      const trialStartedAt = new Date(Date.now() - DAY);
      const trialExpiresAt = new Date(Date.now() + 6 * DAY);
      await db.userSubscription.updateMany({
        where: { authId },
        data: {
          status: 'TRIAL',
          trialUsed: true,
          trialStartedAt,
          trialExpiresAt,
        },
      });
      api.completeSession(sessionId);

      await deliver('checkout.session.completed', sessionId);

      expect(recordOf(authId)).toMatchObject({
        status: 'PRO',
        trialUsed: true,
        trialStartedAt,
        trialExpiresAt,
      });
      // Unused trial credits end in the activation's transaction.
      expect(credits.expireTrialCreditsOnUpgrade.mock.calls).toEqual([
        [db, authId, expect.any(Date)],
      ]);
    });

    it('trusts Stripe, not the webhook payload, for the payment status', async () => {
      const { authId, checkoutId, sessionId } = await openCheckout();
      // Stripe: completed with a delayed payment that has not settled.
      api.completeSession(sessionId, { paymentStatus: 'unpaid' });

      await expect(
        deliver('checkout.session.completed', sessionId, {
          payment_status: 'paid',
          amount_total: 1900,
        }),
      ).resolves.toBe('AWAITING_PAYMENT');

      expect(api.count('GET', `/v1/checkout/sessions/${sessionId}`)).toBe(1);
      expect(checkoutRow(checkoutId)?.status).toBe('PROCESSING');
      expectNoPaidAccess(authId);
    });

    it('activates once a delayed payment settles', async () => {
      const { authId, sessionId } = await openCheckout();
      api.completeSession(sessionId, { paymentStatus: 'unpaid' });
      await deliver('checkout.session.completed', sessionId);

      api.settleDelayedPayment(sessionId);
      await expect(
        deliver('checkout.session.async_payment_succeeded', sessionId),
      ).resolves.toBe('ACTIVATED');

      expect(accessOf(authId).hasProAccess).toBe(true);
    });

    it('does not activate a session that Stripe reports as still open', async () => {
      const { authId, checkoutId, sessionId } = await openCheckout();

      await expect(
        deliver('checkout.session.completed', sessionId, {
          status: 'complete',
          payment_status: 'paid',
        }),
      ).resolves.toBe('REJECTED');

      expect(checkoutRow(checkoutId)?.status).toBe('OPEN');
      expectNoPaidAccess(authId);
      expect(logger.logWithMetadata.mock.calls).toContainEqual([
        'error',
        expect.stringContaining('failed payment verification'),
        expect.objectContaining({ reason: 'NOT_COMPLETE', checkoutId }),
      ]);
    });

    it('does not activate when the paid amount is not the backend price', async () => {
      const { authId, sessionId } = await openCheckout();
      api.completeSession(sessionId, { invoiceAmount: 100 });

      await expect(
        deliver('checkout.session.completed', sessionId),
      ).resolves.toBe('REJECTED');
      expectNoPaidAccess(authId);
    });

    it('ignores a completed session that is not a MuseCue checkout', async () => {
      const customer = await api.client().customers.create({ email: 'x@y.z' });
      const foreign = await api.client().checkout.sessions.create({
        mode: 'subscription',
        customer: customer.id,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: 1,
              recurring: { interval: 'month' },
              product_data: { name: 'Other' },
            },
          },
        ],
      });
      api.completeSession(foreign.id);

      await expect(
        deliver('checkout.session.completed', foreign.id),
      ).resolves.toBe('UNKNOWN_CHECKOUT');
      expect(db.paymentTransaction.rows).toHaveLength(0);
      // Unknown sessions are not looked up at Stripe at all.
      expect(api.count('GET', `/v1/checkout/sessions/${foreign.id}`)).toBe(0);
    });

    it('cannot be pointed at another checkout through the payload metadata', async () => {
      const victim = await openCheckout();
      const attacker = await openCheckout();
      api.completeSession(attacker.sessionId);

      // Even a validly signed event only names a session; the checkout is
      // matched by the stored Stripe session id.
      await deliver('checkout.session.completed', attacker.sessionId, {
        metadata: { checkoutSessionId: victim.checkoutId },
      });

      expect(recordOf(victim.authId)?.proStartedAt ?? null).toBeNull();
      expect(accessOf(attacker.authId).hasProAccess).toBe(true);
      expect(checkoutRow(victim.checkoutId)?.status).toBe('OPEN');
    });
  });

  describe('repeated deliveries', () => {
    it('records the payment once when the same event is delivered again', async () => {
      const { authId, sessionId } = await openCheckout();
      api.completeSession(sessionId);
      await deliver('checkout.session.completed', sessionId);
      const before = { ...recordOf(authId) };

      await expect(
        deliver('checkout.session.completed', sessionId),
      ).resolves.toBe('ALREADY_PROCESSED');
      await expect(
        deliver('checkout.session.async_payment_succeeded', sessionId),
      ).resolves.toBe('ALREADY_PROCESSED');

      expect(db.paymentTransaction.rows).toHaveLength(1);
      expect(db.subscriptionEvent.rows).toHaveLength(1);
      expect(recordOf(authId)).toEqual(before);
      expect(credits.expireTrialCreditsOnUpgrade.mock.calls).toHaveLength(1);
      expect(credits.recordPaidPeriod.mock.calls).toHaveLength(1);
    });

    it('records the payment once for concurrent deliveries', async () => {
      const { authId, sessionId } = await openCheckout();
      api.completeSession(sessionId);

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () =>
          deliver('checkout.session.completed', sessionId),
        ),
      );

      expect(
        outcomes.filter((outcome) => outcome === 'ACTIVATED'),
      ).toHaveLength(1);
      expect(db.paymentTransaction.rows).toHaveLength(1);
      expect(db.subscriptionEvent.rows).toHaveLength(1);
      expect(accessOf(authId).hasProAccess).toBe(true);
    });

    it('never stacks a second paid term on an active one', async () => {
      const { authId, checkoutId, sessionId } = await openCheckout();
      api.completeSession(sessionId);
      const now = Date.now();
      const existingTerm = {
        status: 'PRO',
        billingInterval: MONTHLY,
        proStartedAt: new Date(now - DAY),
        proExpiresAt: new Date(now + 20 * DAY),
      };
      await db.userSubscription.updateMany({
        where: { authId },
        data: existingTerm,
      });

      await expect(
        deliver('checkout.session.completed', sessionId),
      ).resolves.toBe('DUPLICATE_PAYMENT');

      // The money is recorded so it can be refunded; the term is unchanged.
      expect(db.paymentTransaction.rows).toEqual([
        expect.objectContaining({ status: 'SUCCEEDED' }),
      ]);
      expect(db.subscriptionEvent.rows).toHaveLength(0);
      expect(recordOf(authId)).toMatchObject(existingTerm);
      expect(checkoutRow(checkoutId)?.status).toBe('COMPLETED');
      // No new term, so nothing to end and no Pro credits.
      expect(credits.expireTrialCreditsOnUpgrade.mock.calls).toHaveLength(0);
      expect(credits.recordPaidPeriod.mock.calls).toHaveLength(0);
      expect(logger.logWithMetadata.mock.calls).toContainEqual([
        'error',
        expect.stringContaining('Duplicate paid Pro checkout'),
        expect.objectContaining({ checkoutId }),
      ]);
    });
  });

  describe('closing checkouts', () => {
    it('marks an expired session and lets the user start a new checkout', async () => {
      const { authId, checkoutId, sessionId } = await openCheckout();
      api.expireByTime(sessionId);

      await expect(
        deliver('checkout.session.expired', sessionId),
      ).resolves.toBe('CLOSED');

      expect(checkoutRow(checkoutId)).toMatchObject({
        status: 'EXPIRED',
        closedReason: 'PROVIDER_EXPIRED',
      });
      await expect(
        checkout.createCheckout(authId, MONTHLY),
      ).resolves.toMatchObject({
        reused: false,
      });
    });

    it('marks a failed delayed payment without granting access', async () => {
      const { authId, checkoutId, sessionId } = await openCheckout();
      api.completeSession(sessionId, { paymentStatus: 'unpaid' });
      await deliver('checkout.session.completed', sessionId);

      await expect(
        deliver('checkout.session.async_payment_failed', sessionId),
      ).resolves.toBe('CLOSED');

      expect(checkoutRow(checkoutId)).toMatchObject({
        status: 'FAILED',
        closedReason: 'ASYNC_PAYMENT_FAILED',
      });
      expectNoPaidAccess(authId);
    });

    it('does not reopen or close a completed checkout', async () => {
      const { checkoutId, sessionId } = await openCheckout();
      api.completeSession(sessionId);
      await deliver('checkout.session.completed', sessionId);

      await deliver('checkout.session.expired', sessionId);
      await deliver('checkout.session.async_payment_failed', sessionId);

      expect(checkoutRow(checkoutId)?.status).toBe('COMPLETED');
    });
  });

  describe('renewals (invoice.paid)', () => {
    /** A user whose first payment (period starting at `periodStart`) was confirmed. */
    async function activated(
      interval: BillingInterval = MONTHLY,
      periodStart = new Date('2026-01-31T10:00:00.000Z'),
    ) {
      const opened = await openCheckout(interval);
      const session = api.completeSession(opened.sessionId, { periodStart });
      await deliver('checkout.session.completed', opened.sessionId);
      return { ...opened, subscriptionId: session.subscription as string };
    }

    const deliverInvoice = (
      invoiceId: string,
      overrides: Record<string, unknown> = {},
      type = 'invoice.paid',
    ) => {
      const { payload, signature } = api.signedInvoiceEvent(
        type,
        invoiceId,
        overrides,
      );
      return webhooks.handleEvent(
        webhooks.verifyEvent(Buffer.from(payload), signature),
        meta,
      );
    };
    const renew = (subscriptionId: string) =>
      api.renewSubscription(subscriptionId).id as string;
    const paymentsOf = (authId: string) =>
      db.paymentTransaction.rows
        .filter((row) => row.subscriptionId === recordOf(authId)?.id)
        .map((row) => ({
          providerPaymentId: row.providerPaymentId,
          periodStart: (row.periodStart as Date).toISOString(),
          periodEnd: (row.periodEnd as Date).toISOString(),
          amountCents: row.amountCents,
          status: row.status,
        }));
    const eventsOf = (authId: string) =>
      db.subscriptionEvent.rows
        .filter((row) => row.subscriptionId === recordOf(authId)?.id)
        .map((row) => row.type);

    it('extends a monthly term to the period end reported by Stripe', async () => {
      const { authId, subscriptionId } = await activated(MONTHLY);
      const firstRenewal = renew(subscriptionId);

      await expect(deliverInvoice(firstRenewal)).resolves.toBe('RENEWED');

      expect(recordOf(authId)).toMatchObject({
        status: 'PRO',
        billingInterval: 'MONTHLY',
        proStartedAt: new Date('2026-01-31T10:00:00.000Z'),
        proExpiresAt: new Date('2026-03-31T10:00:00.000Z'),
      });
      // Anchored on Jan 31: Feb 28 -> Mar 31, exactly as Stripe bills it.
      expect(paymentsOf(authId)).toEqual([
        expect.objectContaining({
          periodStart: '2026-01-31T10:00:00.000Z',
          periodEnd: '2026-02-28T10:00:00.000Z',
        }),
        {
          providerPaymentId: firstRenewal,
          periodStart: '2026-02-28T10:00:00.000Z',
          periodEnd: '2026-03-31T10:00:00.000Z',
          amountCents: 1900,
          status: 'SUCCEEDED',
        },
      ]);
      expect(eventsOf(authId)).toEqual(['CREATED', 'RENEWED']);
      const renewed = db.subscriptionEvent.rows.at(-1);
      expect(renewed?.paymentId).toBe(db.paymentTransaction.rows.at(-1)?.id);
      // Pro credits for the first payment and for the renewal, each with the
      // recorded payment and the period it paid for.
      expect(credits.recordPaidPeriod.mock.calls).toHaveLength(2);
      expect(credits.recordPaidPeriod.mock.calls[1]).toEqual([
        db,
        authId,
        expect.objectContaining({
          id: db.paymentTransaction.rows.at(-1)?.id,
          subscriptionId: recordOf(authId)?.id,
          billingInterval: 'MONTHLY',
          periodStart: new Date('2026-02-28T10:00:00.000Z'),
          periodEnd: new Date('2026-03-31T10:00:00.000Z'),
        }),
        expect.any(Date),
      ]);

      const secondRenewal = renew(subscriptionId);
      await expect(deliverInvoice(secondRenewal)).resolves.toBe('RENEWED');
      expect(recordOf(authId)).toMatchObject({
        proStartedAt: new Date('2026-01-31T10:00:00.000Z'),
        proExpiresAt: new Date('2026-04-30T10:00:00.000Z'),
      });
      expect(eventsOf(authId)).toEqual(['CREATED', 'RENEWED', 'RENEWED']);
      expect(activityLog.logActivity.mock.calls.at(-1)?.[0]).toMatchObject({
        tableName: 'UserSubscription',
        changes: [
          {
            fieldName: 'proExpiresAt',
            oldValue: '2026-03-31T10:00:00.000Z',
            newValue: '2026-04-30T10:00:00.000Z',
          },
        ],
        metadata: { ...meta, actionedBy: null },
      });
    });

    it('extends a yearly term by the yearly period', async () => {
      const { authId, subscriptionId } = await activated(
        YEARLY,
        new Date('2026-03-15T08:00:00.000Z'),
      );

      await expect(deliverInvoice(renew(subscriptionId))).resolves.toBe(
        'RENEWED',
      );

      expect(recordOf(authId)).toMatchObject({
        billingInterval: 'YEARLY',
        proStartedAt: new Date('2026-03-15T08:00:00.000Z'),
        proExpiresAt: new Date('2028-03-15T08:00:00.000Z'),
      });
      expect(paymentsOf(authId).at(-1)).toMatchObject({
        periodStart: '2027-03-15T08:00:00.000Z',
        periodEnd: '2028-03-15T08:00:00.000Z',
        amountCents: 19000,
      });
    });

    it('records a renewal once however often it is delivered', async () => {
      const { authId, subscriptionId } = await activated();
      const invoiceId = renew(subscriptionId);

      await expect(deliverInvoice(invoiceId)).resolves.toBe('RENEWED');
      const afterFirst = { ...recordOf(authId) };
      const requestsAfterFirst = api.requests.length;
      await expect(deliverInvoice(invoiceId)).resolves.toBe(
        'ALREADY_PROCESSED',
      );
      // A replay is recognised without calling Stripe again.
      expect(api.requests).toHaveLength(requestsAfterFirst);
      await expect(deliverInvoice(invoiceId)).resolves.toBe(
        'ALREADY_PROCESSED',
      );

      expect(paymentsOf(authId)).toHaveLength(2);
      expect(eventsOf(authId)).toEqual(['CREATED', 'RENEWED']);
      expect(recordOf(authId)).toEqual(afterFirst);
      // Activation and one renewal: replays allocate nothing.
      expect(credits.recordPaidPeriod.mock.calls).toHaveLength(2);
    });

    it('records a renewal once for concurrent deliveries', async () => {
      const { authId, subscriptionId } = await activated();
      const invoiceId = renew(subscriptionId);

      const outcomes = await Promise.all(
        Array.from({ length: 6 }, () => deliverInvoice(invoiceId)),
      );

      // One renewal; every other delivery is a recognised replay, not a
      // second charge needing a refund.
      expect([...outcomes].sort()).toEqual([
        ...Array<string>(5).fill('ALREADY_PROCESSED'),
        'RENEWED',
      ]);
      expect(
        logger.logWithMetadata.mock.calls.filter(
          ([level]) => level === 'error',
        ),
      ).toEqual([]);
      expect(paymentsOf(authId)).toHaveLength(2);
      expect(eventsOf(authId)).toEqual(['CREATED', 'RENEWED']);
      expect(recordOf(authId)?.proExpiresAt).toEqual(
        new Date('2026-03-31T10:00:00.000Z'),
      );
    });

    it('does not record the first invoice again when invoice.paid follows the checkout', async () => {
      const { authId, sessionId } = await activated();
      const firstInvoice = api.sessions.get(sessionId)?.invoice as string;
      const before = { ...recordOf(authId) };
      const requestsBefore = api.requests.length;

      await expect(deliverInvoice(firstInvoice)).resolves.toBe(
        'ALREADY_PROCESSED',
      );

      expect(paymentsOf(authId)).toHaveLength(1);
      expect(recordOf(authId)).toEqual(before);
      expect(api.requests).toHaveLength(requestsBefore);
    });

    it('extends from the old expiry when the renewal event arrives after the term lapsed', async () => {
      const { authId, subscriptionId } = await activated();
      const invoiceId = renew(subscriptionId);
      // The event arrives late: the term expired on Feb 28.
      const lateAt = new Date('2026-03-02T09:00:00.000Z');
      expect(accessOf(authId, lateAt).hasProAccess).toBe(false);

      const { payload, signature } = api.signedInvoiceEvent(
        'invoice.paid',
        invoiceId,
      );
      await expect(
        webhooks.handleEvent(
          webhooks.verifyEvent(Buffer.from(payload), signature),
          meta,
          lateAt,
        ),
      ).resolves.toBe('RENEWED');

      expect(recordOf(authId)).toMatchObject({
        proStartedAt: new Date('2026-01-31T10:00:00.000Z'),
        proExpiresAt: new Date('2026-03-31T10:00:00.000Z'),
      });
      expect(accessOf(authId, lateAt).hasProAccess).toBe(true);
    });

    it('never lets an older, delayed renewal overwrite a newer period', async () => {
      const { authId, subscriptionId } = await activated();
      const older = renew(subscriptionId); // Feb 28 -> Mar 31
      const newer = renew(subscriptionId); // Mar 31 -> Apr 30

      await expect(deliverInvoice(newer)).resolves.toBe('RENEWED');
      const afterNewer = { ...recordOf(authId) };
      await expect(deliverInvoice(older)).resolves.toBe('ALREADY_COVERED');

      expect(recordOf(authId)?.proExpiresAt).toEqual(
        new Date('2026-04-30T10:00:00.000Z'),
      );
      expect(recordOf(authId)).toEqual(afterNewer);
      // Both payments are kept in the history.
      expect(paymentsOf(authId).map((row) => row.providerPaymentId)).toEqual(
        expect.arrayContaining([older, newer]),
      );
      expect(eventsOf(authId)).toEqual(['CREATED', 'RENEWED', 'RENEWED']);
    });

    it('does not extend access for an invoice Stripe reports as unpaid', async () => {
      const { authId, subscriptionId } = await activated();
      const invoice = api.renewSubscription(subscriptionId, { paid: false });
      const before = { ...recordOf(authId) };

      // Even a payload claiming it was paid is checked against Stripe.
      await expect(
        deliverInvoice(invoice.id as string, {
          status: 'paid',
          amount_paid: 1900,
        }),
      ).resolves.toBe('REJECTED');

      expect(paymentsOf(authId)).toHaveLength(1);
      expect(recordOf(authId)).toEqual(before);
      expect(logger.logWithMetadata.mock.calls).toContainEqual([
        'error',
        expect.stringContaining('Stripe renewal failed payment verification'),
        expect.objectContaining({ reason: 'INVOICE_NOT_PAID' }),
      ]);
    });

    it('extends once a failed renewal invoice is paid later', async () => {
      const { authId, subscriptionId } = await activated();
      const invoiceId = api.renewSubscription(subscriptionId, { paid: false })
        .id as string;
      api.payInvoice(invoiceId);

      await expect(deliverInvoice(invoiceId)).resolves.toBe('RENEWED');
      expect(recordOf(authId)?.proExpiresAt).toEqual(
        new Date('2026-03-31T10:00:00.000Z'),
      );
    });

    it('renews at the price the subscription was bought for after an admin price change', async () => {
      const { authId, subscriptionId } = await activated();
      plans.getProPlan.mockResolvedValue({
        code: 'PRO',
        currency: 'USD',
        planEnabled: true,
        monthlyPriceUsdCents: 2900,
        yearlyPriceUsdCents: 29000,
        trialEnabled: true,
        trialDays: 7,
        updatedAt: null,
      });

      await expect(deliverInvoice(renew(subscriptionId))).resolves.toBe(
        'RENEWED',
      );
      expect(paymentsOf(authId).at(-1)?.amountCents).toBe(1900);

      // A charge at a different amount is not a verified renewal.
      const other = api.renewSubscription(subscriptionId, { amount: 2900 });
      await expect(deliverInvoice(other.id as string)).resolves.toBe(
        'REJECTED',
      );
      // The rejected charge did not extend the term past Mar 31.
      expect(recordOf(authId)?.proExpiresAt).toEqual(
        new Date('2026-03-31T10:00:00.000Z'),
      );
      expect(paymentsOf(authId)).toHaveLength(2);
    });

    it('keeps the trial history untouched', async () => {
      const { authId, subscriptionId } = await activated();
      const trial = {
        trialUsed: true,
        trialStartedAt: new Date('2026-01-20T10:00:00.000Z'),
        trialExpiresAt: new Date('2026-01-27T10:00:00.000Z'),
      };
      await db.userSubscription.updateMany({ where: { authId }, data: trial });

      await deliverInvoice(renew(subscriptionId));

      expect(recordOf(authId)).toMatchObject(trial);
    });

    it('ignores a renewal of a subscription it does not know', async () => {
      const requestsBefore = api.requests.length;
      const { subscriptionId } = await activated();
      const invoiceId = renew(subscriptionId);
      const foreign = { ...api.invoices.get(invoiceId) };
      const parent = foreign.parent as {
        subscription_details: { subscription: string };
      };
      api.invoices.set('in_foreign', {
        ...foreign,
        id: 'in_foreign',
        parent: {
          ...parent,
          subscription_details: {
            ...parent.subscription_details,
            subscription: 'sub_unknown',
          },
        },
      });
      const paymentsBefore = db.paymentTransaction.rows.length;

      await expect(deliverInvoice('in_foreign')).resolves.toBe(
        'UNKNOWN_SUBSCRIPTION',
      );
      expect(db.paymentTransaction.rows).toHaveLength(paymentsBefore);
      expect(
        api.requests
          .slice(requestsBefore)
          .filter((request) => request.path.includes('in_foreign')),
      ).toHaveLength(0);
    });

    it('never records a second payment for a period that is already paid', async () => {
      const { authId, subscriptionId } = await activated();
      const invoiceId = renew(subscriptionId);
      await deliverInvoice(invoiceId);
      api.invoices.set('in_second_charge', {
        ...structuredClone(api.invoices.get(invoiceId)),
        id: 'in_second_charge',
      });
      const before = { ...recordOf(authId) };

      await expect(deliverInvoice('in_second_charge')).resolves.toBe(
        'DUPLICATE_PAYMENT',
      );

      expect(paymentsOf(authId)).toHaveLength(2);
      expect(recordOf(authId)).toEqual(before);
      expect(logger.logWithMetadata.mock.calls).toContainEqual([
        'error',
        expect.stringContaining('already paid period'),
        expect.objectContaining({ providerPaymentId: 'in_second_charge' }),
      ]);
    });

    it('never extends access from a duplicate Stripe subscription', async () => {
      // A second subscription was paid while a term was active (refund case).
      const { authId, checkoutId, sessionId } = await openCheckout();
      const now = Date.now();
      const activeTerm = {
        status: 'PRO',
        billingInterval: MONTHLY,
        proStartedAt: new Date(now - DAY),
        proExpiresAt: new Date(now + 20 * DAY),
      };
      await db.userSubscription.updateMany({
        where: { authId },
        data: activeTerm,
      });
      const duplicate = api.completeSession(sessionId);
      await expect(
        deliver('checkout.session.completed', sessionId),
      ).resolves.toBe('DUPLICATE_PAYMENT');
      expect(checkoutRow(checkoutId)?.providerSubscriptionId).toBe(
        duplicate.subscription,
      );

      await expect(
        deliverInvoice(renew(duplicate.subscription as string)),
      ).resolves.toBe('DUPLICATE_PAYMENT');

      expect(recordOf(authId)).toMatchObject(activeTerm);
      expect(eventsOf(authId)).toEqual([]);
      expect(paymentsOf(authId)).toHaveLength(2);
    });
  });

  describe('failed payments and recovery', () => {
    const PERIOD_START = new Date('2026-01-31T10:00:00.000Z');
    const FIRST_EXPIRY = new Date('2026-02-28T10:00:00.000Z');
    const RENEWED_EXPIRY = new Date('2026-03-31T10:00:00.000Z');

    /** A user whose first monthly payment was confirmed. */
    async function subscribed() {
      const opened = await openCheckout(MONTHLY);
      const session = api.completeSession(opened.sessionId, {
        periodStart: PERIOD_START,
      });
      await deliver('checkout.session.completed', opened.sessionId);
      return { ...opened, subscriptionId: session.subscription as string };
    }

    /** A signed invoice event; resolves the outcome and the Stripe event id. */
    const invoiceEvent = async (
      type: string,
      invoiceId: string,
      now?: Date,
    ): Promise<[WebhookOutcome, string]> => {
      const { payload, signature, eventId } = api.signedInvoiceEvent(
        type,
        invoiceId,
      );
      const event = webhooks.verifyEvent(Buffer.from(payload), signature);
      return [await webhooks.handleEvent(event, meta, now), eventId];
    };
    const failed = async (invoiceId: string) =>
      (await invoiceEvent('invoice.payment_failed', invoiceId))[0];
    const paid = async (invoiceId: string, now?: Date) =>
      (await invoiceEvent('invoice.paid', invoiceId, now))[0];
    const ended = (subscriptionId: string) => {
      const { payload, signature } = api.signedSubscriptionEvent(
        'customer.subscription.deleted',
        subscriptionId,
      );
      return webhooks.handleEvent(
        webhooks.verifyEvent(Buffer.from(payload), signature),
        meta,
      );
    };

    const subscriptionRecordOf = (authId: string) =>
      recordOf(authId)?.id as string;
    const paymentsOf = (authId: string) =>
      db.paymentTransaction.rows.filter(
        (row) => row.subscriptionId === subscriptionRecordOf(authId),
      );
    const eventsOf = (authId: string) =>
      db.subscriptionEvent.rows
        .filter((row) => row.subscriptionId === subscriptionRecordOf(authId))
        .map((row) => row.type);
    const failedRenewal = (subscriptionId: string) =>
      api.renewSubscription(subscriptionId, { paid: false }).id as string;

    describe('a failed renewal', () => {
      it('records the failed attempt without extending or ending access', async () => {
        const { authId, subscriptionId } = await subscribed();
        const invoiceId = failedRenewal(subscriptionId);
        const before = { ...recordOf(authId) };

        const [outcome, eventId] = await invoiceEvent(
          'invoice.payment_failed',
          invoiceId,
        );

        expect(outcome).toBe('PAYMENT_FAILED');
        const attempt = paymentsOf(authId).at(-1);
        expect(attempt).toMatchObject({
          provider: 'stripe',
          providerPaymentId: `${invoiceId}:failed:${eventId}`,
          providerInvoiceId: invoiceId,
          status: 'FAILED',
          amountCents: 1900,
          billingInterval: 'MONTHLY',
          periodStart: FIRST_EXPIRY,
          periodEnd: RENEWED_EXPIRY,
          failedAt: expect.any(Date) as Date,
          failureCode: 'insufficient_funds',
          failureMessage: 'Your card has insufficient funds.',
        });
        expect(attempt?.paidAt).toBeUndefined();
        expect(eventsOf(authId)).toEqual(['CREATED', 'PAYMENT_FAILED']);
        // Only the first (successful) payment allocated Pro credits.
        expect(credits.recordPaidPeriod.mock.calls).toHaveLength(1);
        // Only the past-due marker changes; the paid term does not.
        expect(recordOf(authId)).toEqual({
          ...before,
          pastDueSince: attempt?.failedAt,
          updatedAt: expect.any(Date) as Date,
        });
        // Paid until the old expiry, not a moment longer.
        expect(
          accessOf(authId, new Date(FIRST_EXPIRY.getTime() - 1)).hasProAccess,
        ).toBe(true);
        expect(accessOf(authId, FIRST_EXPIRY).hasProAccess).toBe(false);
      });

      it('records every failed retry once and keeps the first past-due time', async () => {
        const { authId, subscriptionId } = await subscribed();
        const invoiceId = failedRenewal(subscriptionId);
        await failed(invoiceId);
        const firstPastDue = recordOf(authId)?.pastDueSince;
        api.failInvoiceAttempt(invoiceId, { declineCode: 'expired_card' });

        await expect(failed(invoiceId)).resolves.toBe('PAYMENT_FAILED');

        const attempts = paymentsOf(authId).filter(
          (row) => row.status === 'FAILED',
        );
        expect(attempts.map((row) => row.failureCode)).toEqual([
          'insufficient_funds',
          'expired_card',
        ]);
        expect(attempts.map((row) => row.providerInvoiceId)).toEqual([
          invoiceId,
          invoiceId,
        ]);
        expect(recordOf(authId)?.pastDueSince).toEqual(firstPastDue);
        expect(recordOf(authId)?.proExpiresAt).toEqual(FIRST_EXPIRY);
        expect(eventsOf(authId)).toEqual([
          'CREATED',
          'PAYMENT_FAILED',
          'PAYMENT_FAILED',
        ]);
      });

      it('records a redelivered failure event once', async () => {
        const { authId, subscriptionId } = await subscribed();
        const invoiceId = failedRenewal(subscriptionId);
        const { payload, signature } = api.signedInvoiceEvent(
          'invoice.payment_failed',
          invoiceId,
        );
        const redeliver = () =>
          webhooks.handleEvent(
            webhooks.verifyEvent(Buffer.from(payload), signature),
            meta,
          );

        const outcomes = await Promise.all([
          redeliver(),
          redeliver(),
          redeliver(),
        ]);
        const requestsAfter = api.requests.length;
        await expect(redeliver()).resolves.toBe('ALREADY_PROCESSED');

        expect([...outcomes].sort()).toEqual([
          'ALREADY_PROCESSED',
          'ALREADY_PROCESSED',
          'PAYMENT_FAILED',
        ]);
        // A replay is recognised without calling Stripe.
        expect(api.requests).toHaveLength(requestsAfter);
        expect(
          paymentsOf(authId).filter((row) => row.status === 'FAILED'),
        ).toHaveLength(1);
        expect(eventsOf(authId)).toEqual(['CREATED', 'PAYMENT_FAILED']);
      });

      it('still records the failure when Stripe cannot say why it failed', async () => {
        const { authId, subscriptionId } = await subscribed();
        const invoiceId = failedRenewal(subscriptionId);
        api.failNext('GET /v1/invoice_payments', 'server');

        await expect(failed(invoiceId)).resolves.toBe('PAYMENT_FAILED');
        expect(paymentsOf(authId).at(-1)).toMatchObject({
          status: 'FAILED',
          failureCode: 'payment_failed',
          failureMessage: null,
        });
      });

      it('does not record a failure Stripe reports for another price', async () => {
        const { authId, subscriptionId } = await subscribed();
        const invoiceId = api.renewSubscription(subscriptionId, {
          paid: false,
          amount: 900,
        }).id as string;

        await expect(failed(invoiceId)).resolves.toBe('REJECTED');
        expect(paymentsOf(authId)).toHaveLength(1);
        expect(recordOf(authId)?.pastDueSince).toBeNull();
      });
    });

    describe('recovery of a failed renewal', () => {
      it('extends the term once when Stripe finally collects the invoice', async () => {
        const { authId, subscriptionId } = await subscribed();
        const invoiceId = failedRenewal(subscriptionId);
        await failed(invoiceId);
        api.failInvoiceAttempt(invoiceId);
        await failed(invoiceId);
        api.payInvoice(invoiceId);

        await expect(paid(invoiceId)).resolves.toBe('RENEWED');

        expect(recordOf(authId)).toMatchObject({
          status: 'PRO',
          proStartedAt: PERIOD_START,
          proExpiresAt: RENEWED_EXPIRY,
          pastDueSince: null,
        });
        const attempts = paymentsOf(authId).filter(
          (row) => row.providerInvoiceId === invoiceId,
        );
        expect(attempts.map((row) => row.status)).toEqual([
          'FAILED',
          'FAILED',
          'SUCCEEDED',
        ]);
        expect(attempts[2]).toMatchObject({
          providerPaymentId: invoiceId,
          periodStart: FIRST_EXPIRY,
          periodEnd: RENEWED_EXPIRY,
        });
        expect(eventsOf(authId)).toEqual([
          'CREATED',
          'PAYMENT_FAILED',
          'PAYMENT_FAILED',
          'RENEWED',
        ]);
      });

      it('records a recovered payment once however often it is confirmed', async () => {
        const { authId, subscriptionId } = await subscribed();
        const invoiceId = failedRenewal(subscriptionId);
        await failed(invoiceId);
        api.payInvoice(invoiceId);

        const outcomes = await Promise.all(
          Array.from({ length: 5 }, () => paid(invoiceId)),
        );

        expect([...outcomes].sort()).toEqual([
          ...Array<string>(4).fill('ALREADY_PROCESSED'),
          'RENEWED',
        ]);
        expect(
          paymentsOf(authId).filter((row) => row.status === 'SUCCEEDED'),
        ).toHaveLength(2);
        expect(
          eventsOf(authId).filter((type) => type === 'RENEWED'),
        ).toHaveLength(1);
        expect(recordOf(authId)?.proExpiresAt).toEqual(RENEWED_EXPIRY);
      });

      it('restores access from the old expiry when collected after the term lapsed', async () => {
        const { authId, subscriptionId } = await subscribed();
        const invoiceId = failedRenewal(subscriptionId);
        await failed(invoiceId);
        const lapsed = new Date('2026-03-10T08:00:00.000Z');
        expect(accessOf(authId, lapsed).hasProAccess).toBe(false);

        api.payInvoice(invoiceId);
        await expect(paid(invoiceId, lapsed)).resolves.toBe('RENEWED');

        // Extended to the end of the period Stripe collected, never beyond.
        expect(recordOf(authId)).toMatchObject({
          proStartedAt: PERIOD_START,
          proExpiresAt: RENEWED_EXPIRY,
        });
        expect(accessOf(authId, lapsed).hasProAccess).toBe(true);
        expect(
          accessOf(authId, new Date(RENEWED_EXPIRY.getTime() - 1)).hasProAccess,
        ).toBe(true);
        expect(accessOf(authId, RENEWED_EXPIRY).hasProAccess).toBe(false);
      });

      it('keeps a failure that arrives after the invoice was collected as history only', async () => {
        const { authId, subscriptionId } = await subscribed();
        const invoiceId = failedRenewal(subscriptionId);
        // The failure notification is delayed; Stripe collected meanwhile.
        const { payload, signature } = api.signedInvoiceEvent(
          'invoice.payment_failed',
          invoiceId,
        );
        api.payInvoice(invoiceId);
        await paid(invoiceId);
        const afterRecovery = { ...recordOf(authId) };

        await expect(
          webhooks.handleEvent(
            webhooks.verifyEvent(Buffer.from(payload), signature),
            meta,
          ),
        ).resolves.toBe('PAYMENT_FAILED');

        // Not past due, and the term is unchanged.
        expect(recordOf(authId)).toEqual(afterRecovery);
        expect(recordOf(authId)?.pastDueSince).toBeNull();
        expect(eventsOf(authId)).toEqual([
          'CREATED',
          'RENEWED',
          'PAYMENT_FAILED',
        ]);
      });
    });

    describe('when Stripe gives up', () => {
      it('ends past due and cancels renewal, keeping access until expiry', async () => {
        const { authId, subscriptionId } = await subscribed();
        const invoiceId = api.renewSubscription(subscriptionId, {
          paid: false,
          failure: { final: true },
        }).id as string;
        await failed(invoiceId);
        api.cancelSubscription(subscriptionId);

        await expect(ended(subscriptionId)).resolves.toBe('SUBSCRIPTION_ENDED');
        await expect(ended(subscriptionId)).resolves.toBe('ALREADY_PROCESSED');

        expect(recordOf(authId)).toMatchObject({
          proStartedAt: PERIOD_START,
          proExpiresAt: FIRST_EXPIRY,
          pastDueSince: null,
          proCanceledAt: expect.any(Date) as Date,
        });
        expect(eventsOf(authId)).toEqual([
          'CREATED',
          'PAYMENT_FAILED',
          'CANCELED',
        ]);
        expect(
          accessOf(authId, new Date(FIRST_EXPIRY.getTime() - 1)).hasProAccess,
        ).toBe(true);
        expect(accessOf(authId, FIRST_EXPIRY).hasProAccess).toBe(false);
      });

      it('ignores a deletion event that Stripe does not confirm', async () => {
        const { authId, subscriptionId } = await subscribed();
        await expect(ended(subscriptionId)).resolves.toBe('IGNORED');
        expect(recordOf(authId)?.proCanceledAt).toBeNull();
        expect(eventsOf(authId)).toEqual(['CREATED']);
      });
    });

    describe('a failed first payment', () => {
      it('records the failure and grants nothing', async () => {
        const { authId, checkoutId, sessionId } = await openCheckout(YEARLY);
        const invoice = api.failFirstPayment(sessionId);

        await expect(failed(invoice.id as string)).resolves.toBe(
          'PAYMENT_FAILED',
        );

        expect(paymentsOf(authId)).toEqual([
          expect.objectContaining({
            status: 'FAILED',
            providerInvoiceId: invoice.id,
            amountCents: 19000,
            billingInterval: 'YEARLY',
          }),
        ]);
        expect(eventsOf(authId)).toEqual(['PAYMENT_FAILED']);
        expect(recordOf(authId)).toMatchObject({
          proStartedAt: null,
          pastDueSince: null,
        });
        expect(accessOf(authId).hasProAccess).toBe(false);
        // The customer can still pay in the same checkout.
        expect(checkoutRow(checkoutId)?.status).toBe('OPEN');
      });

      it('activates once when the customer then pays in the same checkout', async () => {
        const { authId, sessionId } = await openCheckout();
        const invoiceId = api.failFirstPayment(sessionId).id as string;
        await failed(invoiceId);
        api.completeSession(sessionId);

        await expect(
          deliver('checkout.session.completed', sessionId),
        ).resolves.toBe('ACTIVATED');
        await expect(paid(invoiceId)).resolves.toBe('ALREADY_PROCESSED');

        expect(paymentsOf(authId).map((row) => row.status)).toEqual([
          'FAILED',
          'SUCCEEDED',
        ]);
        expect(eventsOf(authId)).toEqual(['PAYMENT_FAILED', 'CREATED']);
        expect(accessOf(authId).hasProAccess).toBe(true);
      });

      it('activates once when invoice.paid confirms the payment first', async () => {
        const { authId, checkoutId, sessionId } = await openCheckout();
        const invoiceId = api.failFirstPayment(sessionId).id as string;
        await failed(invoiceId);
        api.completeSession(sessionId);

        await expect(paid(invoiceId)).resolves.toBe('ACTIVATED');
        await expect(
          deliver('checkout.session.completed', sessionId),
        ).resolves.toBe('ALREADY_PROCESSED');

        expect(checkoutRow(checkoutId)).toMatchObject({
          status: 'COMPLETED',
          providerSessionId: sessionId,
        });
        expect(eventsOf(authId)).toEqual(['PAYMENT_FAILED', 'CREATED']);
        expect(
          paymentsOf(authId).filter((row) => row.status === 'SUCCEEDED'),
        ).toHaveLength(1);
      });

      it('activates once for concurrent checkout and invoice confirmations', async () => {
        const { authId, sessionId } = await openCheckout();
        const invoiceId = api.failFirstPayment(sessionId).id as string;
        await failed(invoiceId);
        api.completeSession(sessionId);

        const outcomes = await Promise.all([
          paid(invoiceId),
          deliver('checkout.session.completed', sessionId),
          paid(invoiceId),
          deliver('checkout.session.completed', sessionId),
        ]);

        expect(outcomes.filter((o) => o === 'ACTIVATED')).toHaveLength(1);
        expect(
          eventsOf(authId).filter((type) => type === 'CREATED'),
        ).toHaveLength(1);
        expect(
          paymentsOf(authId).filter((row) => row.status === 'SUCCEEDED'),
        ).toHaveLength(1);
      });
    });

    describe('checkout while past due', () => {
      /**
       * Checkout creates real-time Stripe sessions, so these terms are placed
       * relative to the current time: bought `daysAgo` days ago (monthly).
       */
      async function subscribedDaysAgo(daysAgo: number) {
        const opened = await openCheckout(MONTHLY);
        const periodStart = new Date(
          Math.floor((Date.now() - daysAgo * DAY) / 1000) * 1000,
        );
        const session = api.completeSession(opened.sessionId, { periodStart });
        await deliver('checkout.session.completed', opened.sessionId);
        return { ...opened, subscriptionId: session.subscription as string };
      }

      it('refuses a new checkout until Stripe collects or ends the subscription', async () => {
        // The first month lapsed about two weeks ago; its renewal failed and
        // Stripe may still collect it.
        const { authId, subscriptionId } = await subscribedDaysAgo(45);
        const invoiceId = failedRenewal(subscriptionId);
        await failed(invoiceId);
        expect(accessOf(authId).hasProAccess).toBe(false);
        const sessionsBefore = api.sessions.size;

        await expect(
          checkout.createCheckout(authId, MONTHLY),
        ).rejects.toMatchObject({
          status: 409,
          message: expect.stringContaining(
            'Stripe is still retrying',
          ) as string,
        });
        expect(api.sessions.size).toBe(sessionsBefore);

        api.cancelSubscription(subscriptionId);
        await ended(subscriptionId);

        await expect(
          checkout.createCheckout(authId, MONTHLY),
        ).resolves.toMatchObject({ status: 'OPEN' });
      });

      it('allows checkout again once a recovered renewal has lapsed and Stripe ended the subscription', async () => {
        // Bought ~70 days ago; the renewal failed, was recovered, and the
        // recovered period has also ended by now.
        const { authId, subscriptionId } = await subscribedDaysAgo(70);
        const invoiceId = failedRenewal(subscriptionId);
        await failed(invoiceId);
        api.payInvoice(invoiceId);
        await expect(paid(invoiceId)).resolves.toBe('RENEWED');
        expect(recordOf(authId)?.pastDueSince).toBeNull();
        expect(accessOf(authId).hasProAccess).toBe(false);
        const sessionsBefore = api.sessions.size;

        // The Stripe subscription is still active (its next renewal may be
        // collected any moment): a second subscription would charge twice.
        await expect(
          checkout.createCheckout(authId, MONTHLY),
        ).rejects.toMatchObject({
          status: 409,
          message: expect.stringContaining('has not ended yet') as string,
        });
        expect(api.sessions.size).toBe(sessionsBefore);

        api.cancelSubscription(subscriptionId);
        await ended(subscriptionId);
        await expect(
          checkout.createCheckout(authId, MONTHLY),
        ).resolves.toMatchObject({ status: 'OPEN' });
      });

      it('refuses a new checkout while a lapsed term may still renew, so the user is never charged twice', async () => {
        // The first month ended about five days ago and nothing failed: the
        // Stripe subscription is active and its renewal can still arrive.
        const { authId, subscriptionId } = await subscribedDaysAgo(35);
        expect(accessOf(authId).hasProAccess).toBe(false);
        expect(recordOf(authId)?.pastDueSince).toBeNull();
        const sessionsBefore = api.sessions.size;
        const checkoutsBefore = db.checkoutSession.rows.length;

        await expect(
          checkout.createCheckout(authId, MONTHLY),
        ).rejects.toMatchObject({
          status: 409,
          message: expect.stringContaining('has not ended yet') as string,
        });
        expect(api.sessions.size).toBe(sessionsBefore);
        expect(db.checkoutSession.rows).toHaveLength(checkoutsBefore);

        // The renewal is collected: the one subscription continues.
        const renewal = api.renewSubscription(subscriptionId).id as string;
        await expect(paid(renewal)).resolves.toBe('RENEWED');
        expect(accessOf(authId).hasProAccess).toBe(true);
        expect(
          new Set(
            db.checkoutSession.rows.map((row) => row.providerSubscriptionId),
          ),
        ).toEqual(new Set([subscriptionId]));
      });

      it('creates nothing and answers 503 when Stripe cannot tell whether the previous subscription ended', async () => {
        const { authId } = await subscribedDaysAgo(35);
        const sessionsBefore = api.sessions.size;
        api.failNext('GET /v1/subscriptions/:id', 'connection');

        await expect(
          checkout.createCheckout(authId, MONTHLY),
        ).rejects.toMatchObject({ status: 503 });
        expect(api.sessions.size).toBe(sessionsBefore);
      });
    });
  });

  it.each(['customer.subscription.created', 'payment_intent.succeeded'])(
    'acknowledges and ignores %s',
    async (type) => {
      // Stands in for a verified test-mode event of an unhandled type.
      const event = {
        id: 'evt_1',
        type,
        livemode: false,
        data: { object: {} },
      } as unknown as VerifiedStripeEvent;
      await expect(webhooks.handleEvent(event, meta)).resolves.toBe('IGNORED');
      expect(api.requests).toHaveLength(0);
    },
  );
});
