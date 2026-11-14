import { BillingInterval } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import type Stripe from 'stripe';
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
import { StripeCheckoutService } from './stripe-checkout.service';
import { StripeWebhookService } from './stripe-webhook.service';
import { StripeGateway } from './stripe.gateway';

const { MONTHLY, YEARLY } = BillingInterval;
const DAY = 24 * 60 * 60 * 1000;

describe('StripeWebhookService', () => {
  const plans = mock<SubscriptionPlanService>();
  const activityLog = mock<ActivityLogService>();
  const logger = mock<CustomLoggerService>();
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
    webhooks = new StripeWebhookService(prisma, gateway, activityLog, logger);
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

    it('ignores invoice.paid for the first invoice, which the checkout already recorded', async () => {
      const { authId, sessionId } = await activated();
      const firstInvoice = api.sessions.get(sessionId)?.invoice as string;
      const before = { ...recordOf(authId) };
      const requestsBefore = api.requests.length;

      await expect(deliverInvoice(firstInvoice)).resolves.toBe('IGNORED');

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

  it.each(['customer.subscription.created', 'payment_intent.succeeded'])(
    'acknowledges and ignores %s',
    async (type) => {
      const event = {
        id: 'evt_1',
        type,
        data: { object: {} },
      } as unknown as Stripe.Event;
      await expect(webhooks.handleEvent(event, meta)).resolves.toBe('IGNORED');
      expect(api.requests).toHaveLength(0);
    },
  );
});
