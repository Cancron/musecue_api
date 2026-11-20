import { PrismaClient } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import request from 'supertest';
import { ActivityLogService } from '../src/common/services/activity-log.service';
import type { CustomLoggerService } from '../src/common/services/custom-logger.service';
import type { PrismaService } from '../src/common/services/prisma.service';
import { SubscriptionAccessService } from '../src/subscription/subscription-access.service';
import { SubscriptionPlanService } from '../src/subscription/subscription-plan.service';
import { FAKE_WEBHOOK_SECRET, FakeStripeApi } from './support/fake-stripe-api';
import { freezeTime } from './support/freeze-time';
import { describeWithDatabase } from './support/migrated-schema';
import {
  createStripeTestApp,
  dataOf,
  type StripeTestApp,
} from './support/stripe-test-app';
import { createUser } from './support/subscription-fixtures';

jest.setTimeout(240_000);

type Signed = { payload: string; signature: string };
type Json = Record<string, unknown>;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (iso: string) => new Date(iso);
const plus = (iso: string, ms: number) =>
  new Date(at(iso).getTime() + ms).toISOString();
/** Moves the application clock (Date only; timers and I/O stay real). */
const travel = (iso: string) => freezeTime(at(iso));

/**
 * The whole Stripe payment lifecycle against a disposable PostgreSQL schema:
 * checkout, confirmed payment, Pro activation, renewal, failed payment,
 * recovery, cancellation, expiration and refunds, for monthly and yearly
 * subscriptions. Artificial users; Stripe is the in-memory FakeStripeApi
 * behind the real Stripe SDK. The clock is frozen at exact billing
 * boundaries, and every checkpoint compares the rows stored in PostgreSQL
 * with independently written expectations (amounts, Stripe periods, Stripe
 * references, event history), checks Pro access with SubscriptionAccessService
 * at exact instants, and runs database-wide invariant checks.
 */
describeWithDatabase('Stripe payment lifecycle (PostgreSQL)', () => {
  let harness: StripeTestApp;
  let api: FakeStripeApi;

  const client = (): PrismaClient => harness.client;
  const accessService = () => {
    const prisma = client() as unknown as PrismaService;
    return new SubscriptionAccessService(
      prisma,
      new SubscriptionPlanService(
        prisma,
        new ActivityLogService(prisma, mock<CustomLoggerService>()),
      ),
    );
  };

  beforeAll(async () => {
    harness = await createStripeTestApp();
    api = new FakeStripeApi();
    harness.stripe.api = api;
  });

  afterAll(async () => {
    jest.useRealTimers();
    await harness?.close();
  });

  // ---------------------------------------------------------------------
  // Delivery and HTTP helpers
  // ---------------------------------------------------------------------

  /**
   * One delivery attempt. Like Stripe, every attempt (including retries and
   * late redeliveries of an old event) carries the unchanged payload with a
   * signature made at delivery time; the 5-minute tolerance applies to that
   * signature, not to the age of the event.
   */
  const send = (event: Signed) =>
    harness.sendWebhook(
      event.payload,
      api.client().webhooks.generateTestHeaderString({
        payload: event.payload,
        secret: FAKE_WEBHOOK_SECRET,
      }),
    );
  /** Delivers every event `copies` times, all at once; expects 200s. */
  async function deliverParallel(events: Signed[], copies = 1) {
    const responses = await Promise.all(
      events.flatMap((event) =>
        Array.from({ length: copies }, () => send(event)),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual(
      responses.map(() => 200),
    );
  }
  const http = () => request(harness.app.getHttpServer());
  const statusOf = async (authId: string) =>
    dataOf(
      await http()
        .get('/v1/subscription')
        .set('Authorization', harness.bearer(authId))
        .expect(200),
    ) as Json;
  const billingOf = async (authId: string) =>
    dataOf(
      await http()
        .get('/v1/subscription/billing')
        .set('Authorization', harness.bearer(authId))
        .expect(200),
    ) as Json;
  const checkoutOf = (authId: string, interval: string) =>
    http()
      .post('/v1/subscription/checkout')
      .set('Authorization', harness.bearer(authId))
      .send({ billingInterval: interval });

  /** Pro access at exact instants, through SubscriptionAccessService. */
  async function accessAt(authId: string, instants: Record<string, string>) {
    const access = accessService();
    const result: Record<string, boolean> = {};
    for (const [label, iso] of Object.entries(instants)) {
      result[label] = await access.hasProAccess(authId, at(iso));
    }
    return result;
  }

  // ---------------------------------------------------------------------
  // Stored state, read directly from PostgreSQL
  // ---------------------------------------------------------------------

  const iso = (date: Date | null) => date?.toISOString() ?? null;

  /** The user's billing rows, normalized for comparison. */
  async function storedState(authId: string) {
    const record = await client().userSubscription.findUnique({
      where: { authId },
      include: {
        payments: {
          include: { refunds: true },
          orderBy: [{ periodStart: 'asc' }, { status: 'asc' }],
        },
        events: { orderBy: [{ occurredAt: 'asc' }, { type: 'asc' }] },
        checkoutSessions: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!record) return null;
    const paymentRef = new Map(
      record.payments.map((payment) => [payment.id, payment.providerPaymentId]),
    );
    return {
      subscription: {
        status: record.status,
        billingInterval: record.billingInterval,
        proStartedAt: iso(record.proStartedAt),
        proExpiresAt: iso(record.proExpiresAt),
        proCanceledAt: iso(record.proCanceledAt),
        pastDueSince: iso(record.pastDueSince),
        paymentProvider: record.paymentProvider,
        providerSubscriptionId: record.providerSubscriptionId,
        trialUsed: record.trialUsed,
      },
      payments: record.payments.map((payment) => ({
        status: payment.status,
        amountCents: payment.amountCents,
        currency: payment.currency,
        billingInterval: payment.billingInterval,
        periodStart: iso(payment.periodStart),
        periodEnd: iso(payment.periodEnd),
        providerPaymentId: payment.providerPaymentId,
        providerInvoiceId: payment.providerInvoiceId,
        paidAt: iso(payment.paidAt),
        failedAt: iso(payment.failedAt),
        failureCode: payment.failureCode,
        refundedAmountCents: payment.refundedAmountCents,
        refunds: payment.refunds.map((refund) => ({
          providerRefundId: refund.providerRefundId,
          status: refund.status,
          amountCents: refund.amountCents,
        })),
      })),
      events: record.events.map((event) => ({
        type: event.type,
        occurredAt: iso(event.occurredAt),
        payment: event.paymentId ? paymentRef.get(event.paymentId) : null,
      })),
      checkouts: record.checkoutSessions.map((checkout) => ({
        status: checkout.status,
        billingInterval: checkout.billingInterval,
        amountCents: checkout.amountCents,
      })),
    };
  }

  /**
   * Database-wide invariants that no sequence of events may break. Each query
   * returns the offending rows; all must be empty.
   */
  async function assertDatabaseInvariants() {
    const violations = {
      grantingEventWithoutCollectedPayment: await client().$queryRawUnsafe(`
        SELECT e."id" FROM "SubscriptionEvent" e
          JOIN "PaymentTransaction" p ON p."id" = e."paymentId"
         WHERE e."type" IN ('CREATED', 'RENEWED')
           AND (p."subscriptionId" <> e."subscriptionId"
                OR p."status" NOT IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'))`),
      // Collected payments must span the whole paid term.
      termNotCoveredByPayments: await client().$queryRawUnsafe(`
        SELECT s."id" FROM "UserSubscription" s
         WHERE s."proStartedAt" IS NOT NULL AND NOT (
           COALESCE((SELECT MIN(p."periodStart") FROM "PaymentTransaction" p
                      WHERE p."subscriptionId" = s."id"
                        AND p."status" IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED')),
                    'infinity') <= s."proStartedAt"
           AND COALESCE((SELECT MAX(p."periodEnd") FROM "PaymentTransaction" p
                          WHERE p."subscriptionId" = s."id"
                            AND p."status" IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED')),
                        '-infinity') >= s."proExpiresAt")`),
      refundTotalsOutOfSync: await client().$queryRawUnsafe(`
        SELECT p."id" FROM "PaymentTransaction" p
         WHERE EXISTS (SELECT 1 FROM "PaymentRefund" r WHERE r."paymentId" = p."id")
           AND p."refundedAmountCents" <> (
             SELECT COALESCE(SUM(r."amountCents"), 0) FROM "PaymentRefund" r
              WHERE r."paymentId" = p."id" AND r."status" = 'SUCCEEDED')`),
      paymentNotAtPurchasePrice: await client().$queryRawUnsafe(`
        SELECT p."id" FROM "PaymentTransaction" p
          JOIN "UserSubscription" s ON s."id" = p."subscriptionId"
          JOIN "CheckoutSession" c ON c."subscriptionId" = s."id"
                                   AND c."providerSubscriptionId" = s."providerSubscriptionId"
         WHERE p."amountCents" <> c."amountCents"`),
      stripeReferenceMalformed: await client().$queryRawUnsafe(`
        SELECT p."id" FROM "PaymentTransaction" p
         WHERE p."provider" = 'stripe' AND NOT (
           (p."status" <> 'FAILED' AND p."providerPaymentId" = p."providerInvoiceId"
              AND p."providerInvoiceId" LIKE 'in\\_%')
           OR (p."status" = 'FAILED'
              AND p."providerPaymentId" LIKE p."providerInvoiceId" || ':failed:evt\\_%'))`),
      duplicatePaymentsPerInvoice: await client().$queryRawUnsafe(`
        SELECT "providerInvoiceId" FROM "PaymentTransaction"
         WHERE "status" <> 'FAILED' AND "providerInvoiceId" IS NOT NULL
         GROUP BY "providerInvoiceId" HAVING COUNT(*) > 1`),
      duplicateLifecycleEvents: await client().$queryRawUnsafe(`
        SELECT "subscriptionId", "type", "occurredAt" FROM "SubscriptionEvent"
         WHERE "type" IN ('CANCELED', 'PAYMENT_REFUNDED')
         GROUP BY "subscriptionId", "type", "occurredAt" HAVING COUNT(*) > 1`),
      unprocessedWebhookEvents: await client().$queryRawUnsafe(
        `
        SELECT "providerEventId" FROM "PaymentWebhookEvent"
         WHERE "status" <> 'PROCESSED'
           AND "providerEventId" NOT IN (SELECT unnest($1::text[]))`,
        [...expectedRetries],
      ),
    };
    expect(violations).toEqual({
      grantingEventWithoutCollectedPayment: [],
      termNotCoveredByPayments: [],
      refundTotalsOutOfSync: [],
      paymentNotAtPurchasePrice: [],
      stripeReferenceMalformed: [],
      duplicatePaymentsPerInvoice: [],
      duplicateLifecycleEvents: [],
      unprocessedWebhookEvents: [],
    });
  }
  /** Events that legitimately failed (retry later) and were redelivered. */
  const expectedRetries = new Set<string>();

  // ---------------------------------------------------------------------
  // Stripe-side actions
  // ---------------------------------------------------------------------

  /** Starts a checkout through the API; returns the user and session. */
  async function startCheckout(interval: string, parallel = 1) {
    const authId = await createUser(client());
    const responses = await Promise.all(
      Array.from({ length: parallel }, () => checkoutOf(authId, interval)),
    );
    expect(responses.map((response) => response.status)).toEqual(
      responses.map(() => 201),
    );
    const ids = new Set(responses.map((r) => dataOf(r).checkoutSessionId));
    expect(ids.size).toBe(1);
    const row = await client().checkoutSession.findUniqueOrThrow({
      where: { id: [...ids][0] },
    });
    return { authId, sessionId: row.providerSessionId as string };
  }
  const invoiceOf = (invoiceId: string) =>
    api.invoices.get(invoiceId) as Json & {
      lines: { data: { period: { start: number; end: number } }[] };
      status_transitions: { paid_at: number | null };
    };
  const sessionInvoice = (sessionId: string) =>
    api.sessions.get(sessionId)?.invoice as string;
  const sessionSubscription = (sessionId: string) =>
    api.sessions.get(sessionId)?.subscription as string;

  /** The expected stored payment for a Stripe invoice, from Stripe's data. */
  function paymentFromStripe(
    invoiceId: string,
    interval: string,
    overrides: Json = {},
  ) {
    const invoice = invoiceOf(invoiceId);
    const period = invoice.lines.data[0].period;
    const paidAt = invoice.status_transitions.paid_at;
    return {
      status: 'SUCCEEDED',
      amountCents: invoice.amount_paid,
      currency: 'USD',
      billingInterval: interval,
      periodStart: new Date(period.start * 1000).toISOString(),
      periodEnd: new Date(period.end * 1000).toISOString(),
      providerPaymentId: invoiceId,
      providerInvoiceId: invoiceId,
      paidAt: paidAt ? new Date(paidAt * 1000).toISOString() : null,
      failedAt: null,
      failureCode: null,
      refundedAmountCents: 0,
      refunds: [],
      ...overrides,
    };
  }

  describe.each([
    {
      interval: 'MONTHLY',
      price: 1900,
      // Anchored on Jan 31: Stripe bills Feb 28, Mar 31, Apr 30.
      bounds: [
        '2030-01-31T10:00:00.000Z',
        '2030-02-28T10:00:00.000Z',
        '2030-03-31T10:00:00.000Z',
        '2030-04-30T10:00:00.000Z',
      ],
    },
    {
      interval: 'YEARLY',
      price: 19000,
      // Anchored on Feb 29, 2028: Feb 28, 2029, then Feb 28, 2030 and 2031.
      bounds: [
        '2028-02-29T12:00:00.000Z',
        '2029-02-28T12:00:00.000Z',
        '2030-02-28T12:00:00.000Z',
        '2031-02-28T12:00:00.000Z',
      ],
    },
  ])('$interval subscription', ({ interval, price, bounds }) => {
    const [b0, b1, b2, b3] = bounds;
    const justBefore = (iso: string) => plus(iso, -1);
    const CANCELED_AT = plus(b2, 5 * DAY);
    const RECOVERED_AT = plus(b2, 2 * DAY);

    /** The main user, living through every step in order. */
    let alice: { authId: string; sessionId: string };
    let invoices: { first: string; renewal: string; recovered: string };
    let failureEvent: Signed;
    let aliceExpired: Awaited<ReturnType<typeof storedState>>;

    afterEach(async () => {
      await assertDatabaseInvariants();
    });

    it('1. a new user has no subscription and no Pro access', async () => {
      travel(plus(b0, -HOUR));
      const authId = await createUser(client());

      await expect(storedState(authId)).resolves.toBeNull();
      await expect(statusOf(authId)).resolves.toMatchObject({
        status: 'FREE',
        hasProAccess: false,
      });
      await expect(billingOf(authId)).resolves.toMatchObject({
        subscriptionState: 'NONE',
        plan: null,
      });
    });

    it('2. parallel checkout requests create one session at the configured price and grant nothing', async () => {
      travel(plus(b0, -5 * 60_000));
      alice = await startCheckout(interval, 6);

      const state = await storedState(alice.authId);
      expect(state).toMatchObject({
        subscription: {
          status: 'FREE',
          proStartedAt: null,
          billingInterval: null,
        },
        payments: [],
        events: [],
        checkouts: [
          { status: 'OPEN', billingInterval: interval, amountCents: price },
        ],
      });
      expect(api.sessions.get(alice.sessionId)).toMatchObject({
        status: 'open',
        amount_total: price,
      });
      await expect(
        client().paymentCustomer.count({ where: { authId: alice.authId } }),
      ).resolves.toBe(1);
      await expect(accessAt(alice.authId, { now: b0 })).resolves.toEqual({
        now: false,
      });
    });

    it('3. paying on the Stripe page alone (redirect, no webhook) grants nothing', async () => {
      travel(b0);
      api.completeSession(alice.sessionId);
      invoices = {
        first: sessionInvoice(alice.sessionId),
        renewal: '',
        recovered: '',
      };

      await expect(storedState(alice.authId)).resolves.toMatchObject({
        payments: [],
        subscription: { proStartedAt: null },
      });
      await expect(statusOf(alice.authId)).resolves.toMatchObject({
        status: 'FREE',
        hasProAccess: false,
      });
    });

    it('4. the confirmed payment, delivered many times at once, activates Pro once', async () => {
      await deliverParallel(
        [
          api.signedEvent('checkout.session.completed', alice.sessionId),
          api.signedInvoiceEvent('invoice.paid', invoices.first),
        ],
        4,
      );

      const first = paymentFromStripe(invoices.first, interval);
      expect(first).toMatchObject({
        amountCents: price,
        periodStart: b0,
        periodEnd: b1,
        paidAt: b0,
      });
      await expect(storedState(alice.authId)).resolves.toEqual({
        subscription: {
          status: 'PRO',
          billingInterval: interval,
          proStartedAt: b0,
          proExpiresAt: b1,
          proCanceledAt: null,
          pastDueSince: null,
          paymentProvider: 'stripe',
          providerSubscriptionId: sessionSubscription(alice.sessionId),
          trialUsed: false,
        },
        payments: [first],
        events: [{ type: 'CREATED', occurredAt: b0, payment: invoices.first }],
        checkouts: [
          {
            status: 'COMPLETED',
            billingInterval: interval,
            amountCents: price,
          },
        ],
      });
      await expect(
        accessAt(alice.authId, {
          start: b0,
          lastInstant: justBefore(b1),
          expiry: b1,
        }),
      ).resolves.toEqual({ start: true, lastInstant: true, expiry: false });
      await expect(billingOf(alice.authId)).resolves.toMatchObject({
        subscriptionState: 'ACTIVE',
        plan: { billingInterval: interval, priceCents: price },
        currentPeriod: { start: b0, end: b1 },
        autoRenew: true,
        nextRenewalAt: b1,
      });
    });

    it('5. the renewal at the period end extends Pro by exactly one Stripe period', async () => {
      travel(b1);
      invoices.renewal = api.renewSubscription(
        sessionSubscription(alice.sessionId),
      ).id as string;
      const paid = api.signedInvoiceEvent('invoice.paid', invoices.renewal);
      await deliverParallel([paid], 3);
      await deliverParallel([paid]);

      const state = await storedState(alice.authId);
      expect(state?.payments).toEqual([
        paymentFromStripe(invoices.first, interval),
        paymentFromStripe(invoices.renewal, interval, {
          periodStart: b1,
          periodEnd: b2,
          paidAt: b1,
        }),
      ]);
      expect(state?.subscription).toMatchObject({
        status: 'PRO',
        proStartedAt: b0,
        proExpiresAt: b2,
      });
      expect(state?.events.map((e) => [e.type, e.payment])).toEqual([
        ['CREATED', invoices.first],
        ['RENEWED', invoices.renewal],
      ]);
      await expect(
        accessAt(alice.authId, {
          oldExpiry: b1,
          lastInstant: justBefore(b2),
          expiry: b2,
        }),
      ).resolves.toEqual({ oldExpiry: true, lastInstant: true, expiry: false });
    });

    it('6. a failed renewal is recorded, grants nothing, and the paid period ends on time', async () => {
      travel(b2);
      invoices.recovered = api.renewSubscription(
        sessionSubscription(alice.sessionId),
        { paid: false },
      ).id as string;
      failureEvent = api.signedInvoiceEvent(
        'invoice.payment_failed',
        invoices.recovered,
      );
      await deliverParallel([failureEvent], 3);

      const state = await storedState(alice.authId);
      expect(state?.payments[2]).toEqual({
        ...paymentFromStripe(invoices.recovered, interval),
        status: 'FAILED',
        providerPaymentId: expect.stringMatching(
          new RegExp(`^${invoices.recovered}:failed:evt_`),
        ) as string,
        paidAt: null,
        failedAt: b2,
        failureCode: 'insufficient_funds',
        amountCents: price,
        periodStart: b2,
        periodEnd: b3,
      });
      expect(state?.payments).toHaveLength(3);
      expect(state?.subscription).toMatchObject({
        proExpiresAt: b2,
        pastDueSince: b2,
      });
      expect(state?.events.map((e) => e.type)).toEqual([
        'CREATED',
        'RENEWED',
        'PAYMENT_FAILED',
      ]);
      await expect(accessAt(alice.authId, { now: b2 })).resolves.toEqual({
        now: false,
      });
      await expect(statusOf(alice.authId)).resolves.toMatchObject({
        status: 'EXPIRED',
        hasProAccess: false,
      });
      await expect(billingOf(alice.authId)).resolves.toMatchObject({
        subscriptionState: 'PAST_DUE',
        currentPeriod: null,
        pastDueSince: b2,
      });
      // A second subscription could be charged on top: refused.
      await checkoutOf(alice.authId, interval).expect(409);
    });

    it('7. recovery extends Pro from the old expiry once, and a late failure event changes nothing', async () => {
      travel(RECOVERED_AT);
      api.payInvoice(invoices.recovered);
      await deliverParallel(
        [api.signedInvoiceEvent('invoice.paid', invoices.recovered)],
        3,
      );
      await deliverParallel([failureEvent]);

      const state = await storedState(alice.authId);
      expect(
        state?.payments.map((p) => [p.status, p.providerInvoiceId]),
      ).toEqual([
        ['SUCCEEDED', invoices.first],
        ['SUCCEEDED', invoices.renewal],
        // Same period: ordered by status (enum order), not by time.
        ['SUCCEEDED', invoices.recovered],
        ['FAILED', invoices.recovered],
      ]);
      expect(state?.payments[2]).toEqual(
        paymentFromStripe(invoices.recovered, interval, {
          periodStart: b2,
          periodEnd: b3,
          paidAt: RECOVERED_AT,
        }),
      );
      expect(state?.subscription).toMatchObject({
        status: 'PRO',
        proStartedAt: b0,
        proExpiresAt: b3,
        pastDueSince: null,
      });
      expect(state?.events.map((e) => e.type)).toEqual([
        'CREATED',
        'RENEWED',
        'PAYMENT_FAILED',
        'RENEWED',
      ]);
      await expect(
        accessAt(alice.authId, {
          lapsedGap: plus(b2, DAY),
          now: RECOVERED_AT,
          lastInstant: justBefore(b3),
          expiry: b3,
        }),
      ).resolves.toEqual({
        // The period is paid from b2, so the days before recovery count too.
        lapsedGap: true,
        now: true,
        lastInstant: true,
        expiry: false,
      });
    });

    it('8. cancellation (parallel requests) stops renewal but keeps the current period', async () => {
      travel(CANCELED_AT);
      const before = await storedState(alice.authId);
      const responses = await Promise.all(
        Array.from({ length: 5 }, async () =>
          http()
            .post('/v1/subscription/cancel')
            .set(await harness.stepUp(alice.authId, 'SUBSCRIPTION_CANCEL')),
        ),
      );
      expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      const firstCancellations = responses.filter(
        (r) =>
          (r.body as { data: { alreadyCanceled: boolean } }).data
            .alreadyCanceled === false,
      );
      expect(firstCancellations).toHaveLength(1);
      // Stripe's own notification of the same change adds nothing.
      await deliverParallel(
        [
          api.signedSubscriptionEvent(
            'customer.subscription.updated',
            sessionSubscription(alice.sessionId),
          ),
        ],
        3,
      );

      const state = await storedState(alice.authId);
      expect(state).toEqual({
        ...before,
        subscription: { ...before?.subscription, proCanceledAt: CANCELED_AT },
        events: [
          ...(before?.events ?? []),
          { type: 'CANCELED', occurredAt: CANCELED_AT, payment: null },
        ],
      });
      expect(
        api.subscriptions.get(sessionSubscription(alice.sessionId)),
      ).toMatchObject({
        status: 'active',
        cancel_at_period_end: true,
      });
      await expect(
        accessAt(alice.authId, {
          now: CANCELED_AT,
          lastInstant: justBefore(b3),
          expiry: b3,
        }),
      ).resolves.toEqual({ now: true, lastInstant: true, expiry: false });
      await expect(billingOf(alice.authId)).resolves.toMatchObject({
        subscriptionState: 'CANCELED',
        autoRenew: false,
        nextRenewalAt: null,
        canceledAt: CANCELED_AT,
        currentPeriod: { start: b2, end: b3 },
      });
    });

    it('9. an application restart changes nothing', async () => {
      const read = async () => ({
        stored: await storedState(alice.authId),
        status: await statusOf(alice.authId),
        billing: await billingOf(alice.authId),
        history: dataOf(
          await http()
            .get('/v1/subscription/payments?limit=100')
            .set('Authorization', harness.bearer(alice.authId))
            .expect(200),
        ),
      });
      const before = await read();
      const requests = api.requests.length;

      await harness.restart();

      await expect(read()).resolves.toEqual(before);
      expect(api.requests).toHaveLength(requests);
    });

    it('10. the subscription expires exactly at the end of the paid period', async () => {
      travel(b3);
      api.cancelSubscription(sessionSubscription(alice.sessionId));
      const before = await storedState(alice.authId);
      await deliverParallel(
        [
          api.signedSubscriptionEvent(
            'customer.subscription.deleted',
            sessionSubscription(alice.sessionId),
          ),
        ],
        3,
      );

      aliceExpired = await storedState(alice.authId);
      expect(aliceExpired).toEqual(before);
      await expect(
        accessAt(alice.authId, { lastInstant: justBefore(b3), expiry: b3 }),
      ).resolves.toEqual({ lastInstant: true, expiry: false });
      await expect(statusOf(alice.authId)).resolves.toMatchObject({
        status: 'EXPIRED',
        hasProAccess: false,
        pro: { canceledAt: CANCELED_AT, expiresAt: b3 },
      });
      await expect(billingOf(alice.authId)).resolves.toMatchObject({
        subscriptionState: 'ENDED',
        autoRenew: false,
      });
      // The user may buy again (and would get a new, separate term).
      await checkoutOf(alice.authId, interval).expect(201);
    });

    it.each(['reversed', 7, 42, 2024] as const)(
      '11. the same lifecycle delivered out of order (%s), duplicated and in parallel ends in the same stored state',
      async (order) => {
        // Stripe-side, the same lifecycle at the same instants; nothing is
        // delivered until the end.
        travel(plus(b0, -5 * 60_000));
        const bob = await startCheckout(interval);
        const subscription = () => sessionSubscription(bob.sessionId);
        const events: Signed[] = [];
        travel(b0);
        api.completeSession(bob.sessionId);
        events.push(
          api.signedEvent('checkout.session.completed', bob.sessionId),
        );
        events.push(
          api.signedInvoiceEvent('invoice.paid', sessionInvoice(bob.sessionId)),
        );
        travel(b1);
        const p1 = api.renewSubscription(subscription()).id as string;
        events.push(api.signedInvoiceEvent('invoice.paid', p1));
        travel(b2);
        const p2 = api.renewSubscription(subscription(), { paid: false })
          .id as string;
        events.push(api.signedInvoiceEvent('invoice.payment_failed', p2));
        travel(RECOVERED_AT);
        api.payInvoice(p2);
        events.push(api.signedInvoiceEvent('invoice.paid', p2));
        travel(CANCELED_AT);
        await api
          .client()
          .subscriptions.update(subscription(), { cancel_at_period_end: true });
        events.push(
          api.signedSubscriptionEvent(
            'customer.subscription.updated',
            subscription(),
          ),
        );
        travel(b3);
        api.cancelSubscription(subscription());
        events.push(
          api.signedSubscriptionEvent(
            'customer.subscription.deleted',
            subscription(),
          ),
        );

        // Deterministic shuffle, every event twice and in parallel, redelivered
        // like Stripe's retries until all are accepted.
        const shuffled =
          order === 'reversed' ? [...events].reverse() : shuffle(events, order);
        let pending = shuffled;
        for (let round = 0; round < 6 && pending.length > 0; round++) {
          const responses = await Promise.all(
            [...pending, ...pending].map(async (event) => ({
              event,
              status: (await send(event)).status,
            })),
          );
          for (const { event, status } of responses) {
            expect([200, 503]).toContain(status);
            if (status === 503) {
              expectedRetries.add(
                (JSON.parse(event.payload) as { id: string }).id,
              );
            }
          }
          const accepted = new Set(
            responses.filter((r) => r.status === 200).map((r) => r.event),
          );
          pending = pending.filter((event) => !accepted.has(event));
        }
        expect(pending).toEqual([]);
        // Every retried event was eventually processed.
        for (const event of events) {
          expectedRetries.delete(
            (JSON.parse(event.payload) as { id: string }).id,
          );
        }

        const normalize = (
          state: Awaited<ReturnType<typeof storedState>>,
          ids: Record<string, string>,
        ) => {
          const text = JSON.stringify(state);
          const mapped = Object.entries(ids).reduce(
            (value, [id, label]) => value.split(id).join(label),
            text,
          );
          const parsed = JSON.parse(
            mapped.replace(/:failed:evt_[0-9a-f]+/g, ':failed:<event>'),
          ) as NonNullable<Awaited<ReturnType<typeof storedState>>>;
          return {
            ...parsed,
            // Failure reasons are only readable while the invoice is unpaid; a
            // failure event delivered after the recovery keeps the generic code.
            payments: parsed.payments.map((payment) => ({
              ...payment,
              failureCode: payment.failureCode ? '<failure>' : null,
            })),
          };
        };
        const bobState = normalize(await storedState(bob.authId), {
          [sessionInvoice(bob.sessionId)]: 'FIRST',
          [p1]: 'RENEWAL',
          [p2]: 'RECOVERED',
          [subscription()]: 'SUBSCRIPTION',
        });
        const aliceState = normalize(aliceExpired, {
          [invoices.first]: 'FIRST',
          [invoices.renewal]: 'RENEWAL',
          [invoices.recovered]: 'RECOVERED',
          [sessionSubscription(alice.sessionId)]: 'SUBSCRIPTION',
        });
        // Known limitation (see README): when a renewal is recorded before the
        // earlier renewal that bridges it to the current term, the paid term
        // restarts at the later period, and the database rule that a term
        // moved earlier must be covered by one payment (migration 20260920)
        // keeps it there. Only this "Pro since" date may then differ; all
        // payments, amounts, periods, events and the access at any time the
        // late events can be delivered (after the later period started) match.
        const { proStartedAt: bobStart, ...bobSubscription } =
          bobState.subscription;
        const { proStartedAt: aliceStart, ...aliceSubscription } =
          aliceState.subscription;
        expect({ ...bobState, subscription: bobSubscription }).toEqual({
          ...aliceState,
          subscription: aliceSubscription,
        });
        expect(aliceStart).toBe(b0);
        expect([b0, b2]).toContain(bobStart);
        const joined = bobStart === b0;
        await expect(
          accessAt(bob.authId, {
            ...(joined ? { start: b0, renewed: b1 } : {}),
            recovered: RECOVERED_AT,
            lastInstant: justBefore(b3),
            expiry: b3,
          }),
        ).resolves.toEqual({
          ...(joined ? { start: true, renewed: true } : {}),
          recovered: true,
          lastInstant: true,
          expiry: false,
        });
      },
    );

    it('12. a full refund in the middle of a period ends Pro at once; replays never restore it', async () => {
      travel(plus(b0, -5 * 60_000));
      const carol = await startCheckout(interval);
      travel(b0);
      api.completeSession(carol.sessionId);
      const completed = api.signedEvent(
        'checkout.session.completed',
        carol.sessionId,
      );
      await deliverParallel([completed]);
      const refundedAt = plus(b0, 3 * DAY);
      travel(refundedAt);
      const invoice = sessionInvoice(carol.sessionId);
      const refund = api.refundInvoice(invoice, {
        reason: 'requested_by_customer',
      });
      await deliverParallel(
        [
          api.signedChargeEvent('charge.refunded', api.chargeOf(invoice)),
          api.signedRefundEvent('refund.created', refund.id as string),
        ],
        3,
      );
      // Old events of the refunded payment arrive again later.
      travel(plus(refundedAt, DAY));
      await deliverParallel(
        [completed, api.signedInvoiceEvent('invoice.paid', invoice)],
        2,
      );

      const state = await storedState(carol.authId);
      expect(state?.payments).toEqual([
        paymentFromStripe(invoice, interval, {
          status: 'REFUNDED',
          refundedAmountCents: price,
          refunds: [
            {
              providerRefundId: refund.id,
              status: 'SUCCEEDED',
              amountCents: price,
            },
          ],
        }),
      ]);
      expect(state?.subscription).toMatchObject({
        status: 'EXPIRED',
        proStartedAt: b0,
        proExpiresAt: refundedAt,
      });
      expect(state?.events.map((e) => [e.type, e.occurredAt])).toEqual([
        ['CREATED', b0],
        ['PAYMENT_REFUNDED', refundedAt],
      ]);
      await expect(
        accessAt(carol.authId, {
          beforeRefund: justBefore(refundedAt),
          refunded: refundedAt,
          paidPeriodLeft: justBefore(b1),
        }),
      ).resolves.toEqual({
        beforeRefund: true,
        refunded: false,
        paidPeriodLeft: false,
      });
      await expect(statusOf(carol.authId)).resolves.toMatchObject({
        status: 'EXPIRED',
        hasProAccess: false,
      });
    });

    it('13. a partial refund of a renewal also ends Pro at once and leaves the other payment intact', async () => {
      travel(plus(b0, -5 * 60_000));
      const dave = await startCheckout(interval);
      travel(b0);
      api.completeSession(dave.sessionId);
      await deliverParallel([
        api.signedEvent('checkout.session.completed', dave.sessionId),
      ]);
      travel(b1);
      const renewal = api.renewSubscription(sessionSubscription(dave.sessionId))
        .id as string;
      await deliverParallel([api.signedInvoiceEvent('invoice.paid', renewal)]);
      const refundedAt = plus(b1, DAY);
      travel(refundedAt);
      const partial = Math.floor(price / 4);
      const refund = api.refundInvoice(renewal, { amount: partial });
      await deliverParallel(
        [api.signedChargeEvent('charge.refunded', api.chargeOf(renewal))],
        3,
      );

      const state = await storedState(dave.authId);
      expect(state?.payments).toEqual([
        paymentFromStripe(sessionInvoice(dave.sessionId), interval),
        paymentFromStripe(renewal, interval, {
          status: 'PARTIALLY_REFUNDED',
          refundedAmountCents: partial,
          refunds: [
            {
              providerRefundId: refund.id,
              status: 'SUCCEEDED',
              amountCents: partial,
            },
          ],
        }),
      ]);
      expect(state?.subscription).toMatchObject({
        status: 'EXPIRED',
        proExpiresAt: refundedAt,
      });
      await expect(
        accessAt(dave.authId, {
          firstPeriod: plus(b0, DAY),
          beforeRefund: justBefore(refundedAt),
          refunded: refundedAt,
        }),
      ).resolves.toEqual({
        firstPeriod: true,
        beforeRefund: true,
        refunded: false,
      });
    });

    it('14. without any successful payment there is never Pro access', async () => {
      travel(plus(b0, -5 * 60_000));
      const erin = await startCheckout(interval);
      travel(b0);
      const failed = api.failFirstPayment(erin.sessionId);
      await deliverParallel(
        [api.signedInvoiceEvent('invoice.payment_failed', failed.id as string)],
        3,
      );
      travel(plus(b0, 2 * HOUR));
      api.expireByTime(erin.sessionId);
      await deliverParallel([
        api.signedEvent('checkout.session.expired', erin.sessionId),
      ]);

      const state = await storedState(erin.authId);
      expect(state).toMatchObject({
        subscription: {
          status: 'FREE',
          proStartedAt: null,
          pastDueSince: null,
        },
        payments: [{ status: 'FAILED', amountCents: price, paidAt: null }],
        events: [{ type: 'PAYMENT_FAILED', payment: null }],
        checkouts: [{ status: 'EXPIRED' }],
      });
      await expect(
        accessAt(erin.authId, { start: b0, later: plus(b0, 10 * DAY) }),
      ).resolves.toEqual({ start: false, later: false });
      await expect(statusOf(erin.authId)).resolves.toMatchObject({
        status: 'FREE',
        hasProAccess: false,
      });
    });
  });

  /** Boundaries where a lapsed term, a renewal or a refund are in flight. */
  describe('payment safety at billing boundaries', () => {
    afterEach(async () => {
      await assertDatabaseInvariants();
    });
    const eventIdOf = (event: Signed) =>
      (JSON.parse(event.payload) as { id: string }).id;

    it('never starts a second subscription while a lapsed term’s renewal is still being collected', async () => {
      const b0 = '2033-05-31T10:00:00.000Z';
      const b1 = '2033-06-30T10:00:00.000Z';
      const b2 = '2033-07-31T10:00:00.000Z';
      travel(plus(b0, -5 * 60_000));
      const user = await startCheckout('MONTHLY');
      travel(b0);
      api.completeSession(user.sessionId);
      await deliverParallel([
        api.signedEvent('checkout.session.completed', user.sessionId),
      ]);
      const subscriptionId = sessionSubscription(user.sessionId);

      // Stripe collects a renewal up to about an hour after the period ends;
      // until then the paid term has lapsed.
      const lapsed = plus(b1, 30 * 60_000);
      travel(lapsed);
      await expect(accessAt(user.authId, { lapsed })).resolves.toEqual({
        lapsed: false,
      });
      const sessionsBefore = api.sessions.size;
      const responses = await Promise.all(
        ['MONTHLY', 'YEARLY', 'MONTHLY', 'YEARLY'].map((option) =>
          checkoutOf(user.authId, option),
        ),
      );
      expect(responses.map((response) => response.status)).toEqual([
        409, 409, 409, 409,
      ]);
      expect(api.sessions.size).toBe(sessionsBefore);

      // The renewal arrives and extends the one subscription.
      const renewal = api.renewSubscription(subscriptionId).id as string;
      await deliverParallel(
        [api.signedInvoiceEvent('invoice.paid', renewal)],
        2,
      );
      const state = await storedState(user.authId);
      expect(state?.subscription).toMatchObject({
        status: 'PRO',
        proStartedAt: b0,
        proExpiresAt: b2,
        providerSubscriptionId: subscriptionId,
      });
      expect(state?.payments.map((p) => [p.status, p.periodEnd])).toEqual([
        ['SUCCEEDED', b1],
        ['SUCCEEDED', b2],
      ]);
      expect(state?.checkouts).toEqual([
        { status: 'COMPLETED', billingInterval: 'MONTHLY', amountCents: 1900 },
      ]);
      const customer = await client().paymentCustomer.findFirstOrThrow({
        where: { authId: user.authId },
      });
      expect(
        [...api.subscriptions.values()].filter(
          (subscription) =>
            subscription.customer === customer.providerCustomerId,
        ),
      ).toHaveLength(1);
    });

    it('applies a refund made before its payment was recorded as soon as the payment is recorded', async () => {
      const b0 = '2033-09-15T08:00:00.000Z';
      travel(plus(b0, -5 * 60_000));
      const user = await startCheckout('YEARLY');
      travel(b0);
      api.completeSession(user.sessionId);
      const invoice = sessionInvoice(user.sessionId);

      // Refunded in Stripe before MuseCue recorded the payment.
      const refundedAt = plus(b0, HOUR);
      travel(refundedAt);
      api.refundInvoice(invoice, { reason: 'requested_by_customer' });
      const refundEvent = api.signedChargeEvent(
        'charge.refunded',
        api.chargeOf(invoice),
      );
      expect((await send(refundEvent)).status).toBe(503);
      expectedRetries.add(eventIdOf(refundEvent));

      // The payment events arrive (twice each, at once).
      const recordedAt = plus(b0, 2 * HOUR);
      travel(recordedAt);
      await deliverParallel(
        [
          api.signedEvent('checkout.session.completed', user.sessionId),
          api.signedInvoiceEvent('invoice.paid', invoice),
        ],
        2,
      );
      const state = await storedState(user.authId);
      expect(state?.payments).toEqual([
        paymentFromStripe(invoice, 'YEARLY', {
          status: 'REFUNDED',
          refundedAmountCents: 19000,
          refunds: [
            expect.objectContaining({
              status: 'SUCCEEDED',
              amountCents: 19000,
            }),
          ],
        }),
      ]);
      expect(state?.subscription).toMatchObject({
        status: 'EXPIRED',
        proStartedAt: b0,
        proExpiresAt: recordedAt,
      });
      expect(state?.events.map((e) => [e.type, e.occurredAt])).toEqual([
        ['CREATED', b0],
        ['PAYMENT_REFUNDED', refundedAt],
      ]);
      await expect(statusOf(user.authId)).resolves.toMatchObject({
        hasProAccess: false,
      });

      // Stripe retries the refund event: nothing changes.
      await deliverParallel([refundEvent], 2);
      expectedRetries.delete(eventIdOf(refundEvent));
      await expect(storedState(user.authId)).resolves.toEqual(state);
    });
  });

  /**
   * A user on the free trial buys Pro. The existing subscription rules still
   * apply: the trial history is never changed, paid Pro wins while both run,
   * the trial can never be restarted, and a refund ends only the paid term
   * (the trial keeps its own window).
   */
  describe('a free-trial user buying Pro', () => {
    const justBefore = (iso: string) => plus(iso, -1);

    afterEach(async () => {
      await assertDatabaseInvariants();
    });

    const trialOf = async (authId: string) => {
      const record = await client().userSubscription.findUniqueOrThrow({
        where: { authId },
        include: {
          events: { orderBy: [{ occurredAt: 'asc' }, { type: 'asc' }] },
        },
      });
      return {
        fields: {
          trialUsed: record.trialUsed,
          trialStartedAt: iso(record.trialStartedAt),
          trialExpiresAt: iso(record.trialExpiresAt),
        },
        events: record.events.map((event) => event.type),
      };
    };
    async function startTrial() {
      const authId = await createUser(client());
      await http()
        .post('/v1/subscription/trial')
        .set('Authorization', harness.bearer(authId))
        .expect(201);
      return { authId, trial: await trialOf(authId) };
    }
    /** Checkout through the API, then paid on Stripe and confirmed. */
    async function buyPro(authId: string, interval: string, paidAt: string) {
      const response = await checkoutOf(authId, interval).expect(201);
      const row = await client().checkoutSession.findUniqueOrThrow({
        where: { id: dataOf(response).checkoutSessionId },
      });
      const sessionId = row.providerSessionId as string;
      travel(paidAt);
      api.completeSession(sessionId);
      await deliverParallel(
        [
          api.signedEvent('checkout.session.completed', sessionId),
          api.signedInvoiceEvent('invoice.paid', sessionInvoice(sessionId)),
        ],
        2,
      );
      return {
        subscriptionId: sessionSubscription(sessionId),
        invoiceId: sessionInvoice(sessionId),
      };
    }

    it('keeps the trial history through purchase, renewal, cancellation and expiration (monthly)', async () => {
      travel('2031-06-10T09:00:00.000Z');
      const { authId, trial } = await startTrial();
      expect(trial.fields).toEqual({
        trialUsed: true,
        trialStartedAt: '2031-06-10T09:00:00.000Z',
        trialExpiresAt: expect.any(String) as string,
      });
      const trialEnd = trial.fields.trialExpiresAt as string;
      await expect(statusOf(authId)).resolves.toMatchObject({
        status: 'TRIAL',
        hasProAccess: true,
        accessSource: 'TRIAL',
        accessExpiresAt: trialEnd,
      });

      // Bought during the trial.
      const b0 = '2031-06-12T09:00:00.000Z';
      const b1 = '2031-07-12T09:00:00.000Z';
      const b2 = '2031-08-12T09:00:00.000Z';
      travel(plus(b0, -5 * 60_000));
      const { subscriptionId } = await buyPro(authId, 'MONTHLY', b0);
      let now = await trialOf(authId);
      expect(now).toEqual({
        fields: trial.fields,
        events: [...trial.events, 'CREATED'],
      });
      await expect(statusOf(authId)).resolves.toMatchObject({
        status: 'PRO',
        hasProAccess: true,
        accessSource: 'PRO',
        accessExpiresAt: b1,
        trial: {
          eligible: false,
          ineligibleReason: 'TRIAL_ALREADY_USED',
          used: true,
          active: true,
          startedAt: trial.fields.trialStartedAt,
          expiresAt: trialEnd,
        },
        pro: { active: true, startedAt: b0, expiresAt: b1, canceledAt: null },
      });

      // Renewal.
      travel(b1);
      const renewal = api.renewSubscription(subscriptionId).id as string;
      await deliverParallel(
        [api.signedInvoiceEvent('invoice.paid', renewal)],
        2,
      );
      now = await trialOf(authId);
      expect(now).toEqual({
        fields: trial.fields,
        events: [...trial.events, 'CREATED', 'RENEWED'],
      });
      await expect(
        accessAt(authId, { renewed: b1, lastInstant: justBefore(b2) }),
      ).resolves.toEqual({ renewed: true, lastInstant: true });

      // Cancellation at period end.
      const canceledAt = plus(b1, 3 * DAY);
      travel(canceledAt);
      await http()
        .post('/v1/subscription/cancel')
        .set(await harness.stepUp(authId, 'SUBSCRIPTION_CANCEL'))
        .expect(200);
      expect((await trialOf(authId)).fields).toEqual(trial.fields);
      await expect(statusOf(authId)).resolves.toMatchObject({
        hasProAccess: true,
        accessSource: 'PRO',
        pro: { active: true, expiresAt: b2, canceledAt },
      });

      // Expiration: no access, and the trial can never be restarted.
      travel(b2);
      api.cancelSubscription(subscriptionId);
      await deliverParallel([
        api.signedSubscriptionEvent(
          'customer.subscription.deleted',
          subscriptionId,
        ),
      ]);
      await expect(statusOf(authId)).resolves.toMatchObject({
        status: 'EXPIRED',
        hasProAccess: false,
        accessSource: null,
        trial: { eligible: false, ineligibleReason: 'TRIAL_ALREADY_USED' },
        pro: { active: false, expiresAt: b2, canceledAt },
      });
      await http()
        .post('/v1/subscription/trial')
        .set('Authorization', harness.bearer(authId))
        .expect(409);
      await expect(trialOf(authId)).resolves.toEqual({
        fields: trial.fields,
        events: [...trial.events, 'CREATED', 'RENEWED', 'CANCELED'],
      });
      await expect(
        accessAt(authId, {
          duringTrial: plus(trial.fields.trialStartedAt as string, HOUR),
          lastInstant: justBefore(b2),
          expiry: b2,
        }),
      ).resolves.toEqual({
        duringTrial: true,
        lastInstant: true,
        expiry: false,
      });
    });

    it('a full refund during the trial ends paid Pro at once; the trial keeps its own window (yearly)', async () => {
      travel('2032-03-01T08:00:00.000Z');
      const { authId, trial } = await startTrial();
      const trialEnd = trial.fields.trialExpiresAt as string;
      const b0 = '2032-03-02T08:00:00.000Z';
      travel(plus(b0, -5 * 60_000));
      const { invoiceId } = await buyPro(authId, 'YEARLY', b0);
      await expect(statusOf(authId)).resolves.toMatchObject({
        accessSource: 'PRO',
        accessExpiresAt: '2033-03-02T08:00:00.000Z',
      });

      const refundedAt = plus(b0, DAY);
      expect(at(refundedAt).getTime()).toBeLessThan(at(trialEnd).getTime());
      travel(refundedAt);
      api.refundInvoice(invoiceId, { reason: 'requested_by_customer' });
      await deliverParallel(
        [api.signedChargeEvent('charge.refunded', api.chargeOf(invoiceId))],
        2,
      );

      const state = await storedState(authId);
      expect(state?.payments).toMatchObject([
        { status: 'REFUNDED', amountCents: 19000, refundedAmountCents: 19000 },
      ]);
      expect(state?.subscription).toMatchObject({ proExpiresAt: refundedAt });
      await expect(trialOf(authId)).resolves.toEqual({
        fields: trial.fields,
        events: [...trial.events, 'CREATED', 'PAYMENT_REFUNDED'],
      });
      // Access continues from the trial only, until the trial's own expiry.
      await expect(statusOf(authId)).resolves.toMatchObject({
        status: 'TRIAL',
        hasProAccess: true,
        accessSource: 'TRIAL',
        accessExpiresAt: trialEnd,
        pro: { active: false },
      });
      await expect(
        accessAt(authId, {
          trialLastInstant: plus(trialEnd, -1),
          trialEnd,
          paidYearLeft: plus(trialEnd, 30 * DAY),
        }),
      ).resolves.toEqual({
        trialLastInstant: true,
        trialEnd: false,
        paidYearLeft: false,
      });
    });
  });
});

/** A deterministic shuffle (mulberry32), so failures are reproducible. */
function shuffle<T>(items: T[], seed: number): T[] {
  let state = seed;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
