import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';

/**
 * An in-memory emulation of the few Stripe API endpoints the checkout uses,
 * plugged into the real Stripe SDK through its fetch HTTP client. Requests
 * therefore go through the SDK's real encoding, idempotency headers, expand
 * handling and error classes; only the Stripe servers are replaced.
 *
 * Emulated behaviour (as documented by Stripe):
 * - the first response for an Idempotency-Key is replayed for later requests
 *   with the same key; different parameters under the same key fail;
 * - checkout `expires_at` must be 30 minutes to 24 hours in the future;
 * - only `open` checkout sessions can be expired or paid.
 *
 * It is not a full Stripe implementation and cannot prove the real API
 * accepts every parameter.
 */

type Json = Record<string, unknown>;

export interface RecordedRequest {
  method: string;
  path: string;
  params: Json;
  idempotencyKey: string | null;
}

/**
 * connection: the request never reaches Stripe. lost: Stripe processes it but
 * the response is lost (timeout). server: 500. invalid: 400 rejection.
 */
/** How a collection attempt fails (a card decline by default). */
export interface PaymentFailureOptions {
  code?: string;
  declineCode?: string;
  message?: string;
  /** No further automatic retry is scheduled. */
  final?: boolean;
}

type FailureKind = 'connection' | 'lost' | 'server' | 'invalid';

interface StoredResponse {
  status: number;
  body: Json;
  params: string;
}

export const FAKE_WEBHOOK_SECRET = 'whsec_fake_stripe_api_secret';

/** Parses `a[b][0][c]=1` style form bodies / query strings into objects. */
export function parseStripeForm(encoded: string): Json {
  const root: Json = {};
  for (const [rawKey, value] of new URLSearchParams(encoded)) {
    const parts = rawKey.replace(/\]/g, '').split('[');
    let node: Record<string, unknown> | unknown[] = root;
    parts.forEach((part, index) => {
      const last = index === parts.length - 1;
      const key: string | number = /^\d+$/.test(part) ? Number(part) : part;
      const container = node as Record<string | number, unknown>;
      if (last) {
        container[key] = value;
        return;
      }
      if (container[key] === undefined) {
        container[key] = /^\d+$/.test(parts[index + 1]) ? [] : {};
      }
      node = container[key] as Record<string, unknown> | unknown[];
    });
  }
  return root;
}

const str = (value: unknown): string =>
  typeof value === 'string' ? value : '';

export class FakeStripeApi {
  readonly requests: RecordedRequest[] = [];
  readonly customers = new Map<string, Json>();
  readonly sessions = new Map<string, Json>();
  readonly subscriptions = new Map<string, Json>();
  readonly invoices = new Map<string, Json>();
  readonly paymentIntents = new Map<string, Json>();
  readonly charges = new Map<string, Json>();
  readonly refunds = new Map<string, Json>();
  readonly coupons = new Map<string, Json>();
  /** The card fingerprint each customer pays with (none by default). */
  readonly customerCards = new Map<string, string>();
  private readonly idempotency = new Map<string, StoredResponse>();
  private readonly failures = new Map<string, FailureKind[]>();
  private counter = 0;

  /** Random 0-`latencyMs` delay before each request is processed. */
  constructor(private readonly latencyMs = 0) {}

  /** A real Stripe SDK client whose HTTP calls are served by this fake. */
  client(): Stripe {
    return new Stripe('sk_test_fake', {
      httpClient: Stripe.createFetchHttpClient(this.fetch),
      maxNetworkRetries: 0,
      telemetry: false,
    });
  }

  /** Makes the next request to `operation` fail (e.g. 'POST /v1/checkout/sessions'). */
  failNext(operation: string, kind: FailureKind) {
    this.failures.set(operation, [
      ...(this.failures.get(operation) ?? []),
      kind,
    ]);
  }

  count(method: string, path: string | RegExp): number {
    return this.requests.filter(
      (request) =>
        request.method === method &&
        (typeof path === 'string'
          ? request.path === path
          : path.test(request.path)),
    ).length;
  }

  /** Sessions a customer could still pay right now. */
  openSessions(customerId?: string): Json[] {
    return [...this.sessions.values()].filter(
      (session) =>
        session.status === 'open' &&
        (customerId === undefined || session.customer === customerId),
    );
  }

  /**
   * The customer pays on the hosted page. With `paymentStatus: 'unpaid'` the
   * session completes with a delayed payment method that has not settled.
   * After failFirstPayment, the same subscription and invoice are collected.
   */
  completeSession(
    sessionId: string,
    options: {
      paymentStatus?: 'paid' | 'unpaid';
      periodStart?: Date;
      invoiceAmount?: number;
      /** The customer pays with this card (Stripe's card fingerprint). */
      cardFingerprint?: string;
    } = {},
  ): Json {
    const session = this.requireSession(sessionId);
    if (options.cardFingerprint) {
      this.customerCards.set(str(session.customer), options.cardFingerprint);
    }
    if (session.status !== 'open') {
      throw new Error(`Session ${sessionId} is ${str(session.status)}`);
    }
    const paid = (options.paymentStatus ?? 'paid') === 'paid';
    if (session.mode === 'payment') {
      return this.completePaymentSession(session, paid);
    }
    if (!session.invoice) this.startSubscription(session, options.periodStart);
    const invoice = this.requireInvoice(str(session.invoice));
    // A 100% discount: nothing is due, Stripe requires no payment.
    const nothingDue = Number(invoice.amount_due) === 0;
    if (paid) {
      this.collect(invoice, options.invoiceAmount);
    }
    Object.assign(session, {
      status: 'complete',
      payment_status: paid
        ? nothingDue
          ? 'no_payment_required'
          : 'paid'
        : 'unpaid',
      url: null,
    });
    return session;
  }

  /**
   * The first payment attempt on the hosted page is declined: Stripe creates
   * the subscription (`incomplete`) and its first invoice, which stays open.
   * The session stays open so the customer can try another card.
   */
  failFirstPayment(
    sessionId: string,
    failure: PaymentFailureOptions = {},
    periodStart?: Date,
  ): Json {
    const session = this.requireSession(sessionId);
    if (session.status !== 'open') {
      throw new Error(`Session ${sessionId} is ${str(session.status)}`);
    }
    if (!session.invoice) this.startSubscription(session, periodStart);
    return this.failInvoiceAttempt(str(session.invoice), failure);
  }

  /**
   * Stripe bills the next period of a subscription: a `subscription_cycle`
   * invoice for [current period end, next anchored end). Returns the invoice.
   * `paid: false` makes the first collection attempt fail (renewal failure).
   */
  renewSubscription(
    subscriptionId: string,
    options: {
      paid?: boolean;
      amount?: number;
      failure?: PaymentFailureOptions;
    } = {},
  ): Json {
    const subscription = this.requireSubscription(subscriptionId);
    const item = (subscription.items as { data: Json[] }).data[0];
    const price = item.price as Json;
    const interval = str((price.recurring as Json).interval);
    const start = Number(item.current_period_end);
    const end = anchoredPeriodEnd(
      Number(subscription.billing_cycle_anchor),
      start,
      interval,
    );
    const invoice = this.newInvoice({
      billingReason: 'subscription_cycle',
      customer: str(subscription.customer),
      subscriptionId,
      metadata: (subscription.metadata as Json | undefined) ?? {},
      amount: options.amount ?? Number(price.unit_amount),
      start,
      end,
    });
    Object.assign(item, {
      current_period_start: start,
      current_period_end: end,
    });
    subscription.latest_invoice = invoice.id;
    if (options.paid ?? true) {
      this.collect(invoice);
    } else {
      this.failInvoiceAttempt(str(invoice.id), options.failure);
    }
    return invoice;
  }

  /**
   * One more collection attempt on an open invoice fails (Stripe's automatic
   * retry). `final: true` means Stripe schedules no further retry.
   */
  failInvoiceAttempt(
    invoiceId: string,
    failure: PaymentFailureOptions = {},
  ): Json {
    const invoice = this.requireInvoice(invoiceId);
    if (invoice.status !== 'open') {
      throw new Error(`Invoice ${invoiceId} is ${str(invoice.status)}`);
    }
    const now = Math.floor(Date.now() / 1000);
    Object.assign(invoice, {
      attempted: true,
      attempt_count: Number(invoice.attempt_count) + 1,
      next_payment_attempt: failure.final ? null : now + 3 * 24 * 60 * 60,
    });
    Object.assign(this.paymentIntentOf(invoice), {
      status: 'requires_payment_method',
      last_payment_error: {
        type: 'card_error',
        code: failure.code ?? 'card_declined',
        decline_code: failure.declineCode ?? 'insufficient_funds',
        message: failure.message ?? 'Your card has insufficient funds.',
      },
    });
    const subscription = this.subscriptions.get(this.subscriptionOf(invoice));
    if (subscription && invoice.billing_reason === 'subscription_cycle') {
      subscription.status = 'past_due';
    }
    return invoice;
  }

  /** An open invoice is finally collected (a Stripe retry or a new card). */
  payInvoice(invoiceId: string) {
    this.collect(this.requireInvoice(invoiceId));
  }

  /**
   * Stripe gives up on an `incomplete` subscription whose first invoice was
   * never paid (about 23 hours after it was created): the subscription
   * becomes `incomplete_expired` and its first invoice is voided.
   */
  expireIncompleteSubscription(subscriptionId: string) {
    const subscription = this.requireSubscription(subscriptionId);
    if (subscription.status !== 'incomplete') {
      throw new Error(
        `Subscription ${subscriptionId} is ${str(subscription.status)}`,
      );
    }
    Object.assign(subscription, {
      status: 'incomplete_expired',
      ended_at: Math.floor(Date.now() / 1000),
    });
    Object.assign(this.requireInvoice(str(subscription.latest_invoice)), {
      status: 'void',
      next_payment_attempt: null,
    });
  }

  /** Stripe ends the subscription (e.g. after its last failed retry). */
  cancelSubscription(subscriptionId: string) {
    const now = Math.floor(Date.now() / 1000);
    const subscription = this.requireSubscription(subscriptionId);
    Object.assign(subscription, {
      status: 'canceled',
      // A scheduled cancellation keeps the time it was requested.
      canceled_at: subscription.canceled_at ?? now,
      ended_at: now,
    });
  }

  /** A signed event for an invoice, carrying the invoice as it is now. */
  signedInvoiceEvent(
    type: string,
    invoiceId: string,
    overrides: Json = {},
  ): { payload: string; signature: string; eventId: string } {
    return this.sign(type, {
      ...withoutInternals(this.requireInvoice(invoiceId)),
      ...overrides,
    });
  }

  /** A signed event for a subscription, carrying it as it is now. */
  signedSubscriptionEvent(
    type: string,
    subscriptionId: string,
    overrides: Json = {},
  ): { payload: string; signature: string; eventId: string } {
    return this.sign(type, {
      ...this.requireSubscription(subscriptionId),
      ...overrides,
    });
  }

  /** The delayed payment of an `unpaid` completed session settles. */
  settleDelayedPayment(sessionId: string) {
    const session = this.requireSession(sessionId);
    if (session.mode === 'payment') {
      this.chargePaymentIntent(
        this.paymentIntents.get(str(session.payment_intent)) ?? {},
        str(session.customer),
      );
      Object.assign(session, { payment_status: 'paid' });
      return;
    }
    this.collect(this.requireInvoice(str(session.invoice)));
    Object.assign(session, { payment_status: 'paid' });
  }

  /** The delayed payment of a payment-mode session fails. */
  failDelayedPayment(sessionId: string) {
    const session = this.requireSession(sessionId);
    Object.assign(this.paymentIntents.get(str(session.payment_intent)) ?? {}, {
      status: 'requires_payment_method',
      last_payment_error: {
        type: 'card_error',
        code: 'payment_failed',
        message: 'The payment failed.',
      },
    });
  }

  /**
   * A payment-mode session is paid on the hosted page: its PaymentIntent is
   * created and collected (or, with a delayed method, `processing`).
   */
  private completePaymentSession(session: Json, paid: boolean): Json {
    const coupon = this.sessionCoupon(session);
    if (coupon) {
      coupon.times_redeemed = Number(coupon.times_redeemed) + 1;
    }
    const intentId = this.id('pi');
    const intent: Json = {
      id: intentId,
      object: 'payment_intent',
      amount: session.amount_total,
      amount_received: 0,
      currency: session.currency,
      customer: session.customer,
      metadata: session._paymentIntentMetadata ?? {},
      status: 'processing',
      last_payment_error: null,
      latest_charge: null,
      payment_method: null,
      created: Math.floor(Date.now() / 1000),
    };
    this.paymentIntents.set(intentId, intent);
    if (paid) this.chargePaymentIntent(intent, str(session.customer));
    Object.assign(session, {
      status: 'complete',
      payment_status: paid ? 'paid' : 'unpaid',
      payment_intent: intentId,
      url: null,
    });
    return session;
  }

  /** Collects a PaymentIntent with the customer's card. */
  private chargePaymentIntent(intent: Json, customer: string) {
    const amount = Number(intent.amount);
    const chargeId = this.id('ch');
    this.charges.set(chargeId, {
      id: chargeId,
      object: 'charge',
      amount,
      amount_captured: amount,
      amount_refunded: 0,
      refunded: false,
      currency: intent.currency,
      customer,
      payment_intent: intent.id,
      status: 'succeeded',
      created: Math.floor(Date.now() / 1000),
    });
    const fingerprint = this.customerCards.get(customer);
    Object.assign(intent, {
      status: 'succeeded',
      amount_received: amount,
      last_payment_error: null,
      latest_charge: chargeId,
      payment_method: fingerprint
        ? {
            id: `pm_${fingerprint}`,
            object: 'payment_method',
            type: 'card',
            card: { brand: 'visa', last4: '4242', fingerprint },
          }
        : null,
    });
  }

  /** The charge that collected an invoice. */
  chargeOf(invoiceId: string): string {
    const charge = str(this.requireInvoice(invoiceId)._charge);
    if (!charge) throw new Error(`Invoice ${invoiceId} has no charge`);
    return charge;
  }

  /**
   * A refund made in Stripe (e.g. from the dashboard) of the charge that
   * collected an invoice: full by default, or `amount` cents. A `pending`
   * refund only counts once it succeeds.
   */
  refundInvoice(
    invoiceId: string,
    options: {
      amount?: number;
      status?: 'succeeded' | 'pending' | 'failed';
      reason?: string;
    } = {},
  ): Json {
    const charge = this.charges.get(this.chargeOf(invoiceId)) as Json;
    const refundId = this.id('re');
    const refund: Json = {
      id: refundId,
      object: 'refund',
      amount: options.amount ?? Number(charge.amount),
      charge: charge.id,
      payment_intent: charge.payment_intent,
      currency: charge.currency,
      created: Math.floor(Date.now() / 1000),
      reason: options.reason ?? 'requested_by_customer',
      status: 'pending',
    };
    this.refunds.set(refundId, refund);
    this.setRefundStatus(refundId, options.status ?? 'succeeded');
    return refund;
  }

  /** A refund changes status in Stripe (e.g. a pending refund succeeds). */
  setRefundStatus(refundId: string, status: string) {
    const refund = this.refunds.get(refundId);
    if (!refund) throw new Error(`Unknown refund ${refundId}`);
    const charge = this.charges.get(str(refund.charge)) as Json;
    if (status === 'succeeded' && refund.status !== 'succeeded') {
      charge.amount_refunded =
        Number(charge.amount_refunded) + Number(refund.amount);
      charge.refunded = charge.amount_refunded === charge.amount;
    }
    refund.status = status;
  }

  /** A signed event for a charge, carrying the charge as it is now. */
  signedChargeEvent(
    type: string,
    chargeId: string,
    overrides: Json = {},
  ): { payload: string; signature: string; eventId: string } {
    const charge = this.charges.get(chargeId);
    if (!charge) throw new Error(`Unknown charge ${chargeId}`);
    return this.sign(type, { ...charge, ...overrides });
  }

  /** A signed event for a refund, carrying the refund as it is now. */
  signedRefundEvent(
    type: string,
    refundId: string,
    overrides: Json = {},
  ): { payload: string; signature: string; eventId: string } {
    const refund = this.refunds.get(refundId);
    if (!refund) throw new Error(`Unknown refund ${refundId}`);
    return this.sign(type, { ...refund, ...overrides });
  }

  /**
   * POST /v1/subscriptions/:id with `cancel_at_period_end`. Like Stripe:
   * canceled subscriptions cannot be updated; scheduling a cancellation sets
   * `cancel_at` to the current period end and `canceled_at` to the request
   * time; unscheduling clears both.
   */
  private updateSubscription(
    subscriptionId: string,
    params: Json,
  ): { status: number; body: Json } {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      return invalid(404, 'resource_missing', 'No such subscription');
    }
    if (subscription.status === 'canceled') {
      return invalid(
        400,
        undefined,
        'A canceled subscription can only update its cancellation_details and metadata.',
      );
    }
    if (params.cancel_at_period_end !== undefined) {
      const cancel = params.cancel_at_period_end === 'true';
      const item = (subscription.items as { data: Json[] }).data[0];
      Object.assign(subscription, {
        cancel_at_period_end: cancel,
        cancel_at: cancel ? item.current_period_end : null,
        canceled_at: cancel ? Math.floor(Date.now() / 1000) : null,
      });
    }
    return { status: 200, body: { ...subscription } };
  }

  /** Creates the subscription and its first (open) invoice for a session. */
  private startSubscription(session: Json, periodStart?: Date) {
    const lineItem = (session.line_items as Json[])[0];
    const priceData = lineItem.price_data as Json;
    const amount = Number(priceData.unit_amount);
    // A `duration: once` coupon discounts the first invoice only.
    const coupon = this.sessionCoupon(session);
    const discount = coupon ? Math.min(Number(coupon.amount_off), amount) : 0;
    const interval = str((priceData.recurring as Json).interval);
    const start = Math.floor((periodStart ?? new Date()).getTime() / 1000);
    const end = anchoredPeriodEnd(start, start, interval);
    const subscriptionId = this.id('sub');
    const metadata =
      (session.subscription_data as Json | undefined)?.metadata ?? {};
    const invoice = this.newInvoice({
      billingReason: 'subscription_create',
      customer: str(session.customer),
      subscriptionId,
      metadata: metadata as Json,
      amount,
      discount,
      start,
      end,
    });
    if (coupon) {
      coupon.times_redeemed = Number(coupon.times_redeemed) + 1;
    }
    this.subscriptions.set(subscriptionId, {
      id: subscriptionId,
      object: 'subscription',
      customer: session.customer,
      status: 'incomplete',
      billing_cycle_anchor: start,
      cancel_at_period_end: false,
      cancel_at: null,
      canceled_at: null,
      ended_at: null,
      metadata,
      latest_invoice: invoice.id,
      items: {
        object: 'list',
        data: [
          {
            id: this.id('si'),
            object: 'subscription_item',
            quantity: 1,
            current_period_start: start,
            current_period_end: end,
            price: {
              id: this.id('price'),
              object: 'price',
              currency: priceData.currency,
              unit_amount: amount,
              recurring: { interval, interval_count: 1 },
            },
          },
        ],
      },
    });
    Object.assign(session, {
      subscription: subscriptionId,
      invoice: invoice.id,
    });
  }

  private newInvoice(input: {
    billingReason: string;
    customer: string;
    subscriptionId: string;
    /** Snapshot of the subscription metadata, as Stripe copies it. */
    metadata: Json;
    /** The price (line amount) before any discount. */
    amount: number;
    /** Discount off the invoice total (a coupon). */
    discount?: number;
    start: number;
    end: number;
  }): Json {
    const discount = input.discount ?? 0;
    const invoiceId = this.id('in');
    const paymentIntentId = this.id('pi');
    this.paymentIntents.set(paymentIntentId, {
      id: paymentIntentId,
      object: 'payment_intent',
      status: 'requires_payment_method',
      last_payment_error: null,
    });
    const invoice: Json = {
      id: invoiceId,
      object: 'invoice',
      billing_reason: input.billingReason,
      customer: input.customer,
      currency: 'usd',
      subtotal: input.amount,
      total: input.amount - discount,
      total_discount_amounts: discount > 0 ? [{ amount: discount }] : [],
      amount_due: input.amount - discount,
      amount_paid: 0,
      status: 'open',
      attempted: false,
      attempt_count: 0,
      next_payment_attempt: null,
      status_transitions: { paid_at: null },
      parent: {
        type: 'subscription_details',
        subscription_details: {
          subscription: input.subscriptionId,
          metadata: input.metadata,
        },
      },
      lines: {
        object: 'list',
        data: [
          {
            id: this.id('il'),
            object: 'line_item',
            amount: input.amount,
            period: { start: input.start, end: input.end },
          },
        ],
      },
      // Not part of the Stripe invoice object; used to emulate invoice payments.
      _paymentIntent: paymentIntentId,
    };
    this.invoices.set(invoiceId, invoice);
    return invoice;
  }

  /**
   * Marks an invoice paid (its amount due after discounts, or `amount`) and
   * its subscription active.
   */
  private collect(invoice: Json, amount?: number) {
    const collected = amount ?? Number(invoice.amount_due);
    Object.assign(invoice, {
      status: 'paid',
      attempted: true,
      attempt_count: Number(invoice.attempt_count) + 1,
      next_payment_attempt: null,
      amount_paid: collected,
      status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
    });
    Object.assign(this.subscriptions.get(this.subscriptionOf(invoice)) ?? {}, {
      status: 'active',
    });
    // A $0 invoice is paid without any charge.
    if (collected === 0) return;
    const chargeId = this.id('ch');
    this.charges.set(chargeId, {
      id: chargeId,
      object: 'charge',
      amount: collected,
      amount_captured: collected,
      amount_refunded: 0,
      refunded: false,
      currency: invoice.currency,
      customer: invoice.customer,
      payment_intent: invoice._paymentIntent,
      status: 'succeeded',
      created: Math.floor(Date.now() / 1000),
    });
    invoice._charge = chargeId;
    const fingerprint = this.customerCards.get(str(invoice.customer));
    Object.assign(this.paymentIntentOf(invoice), {
      status: 'succeeded',
      last_payment_error: null,
      latest_charge: chargeId,
      payment_method: fingerprint
        ? {
            id: `pm_${fingerprint}`,
            object: 'payment_method',
            type: 'card',
            card: { brand: 'visa', last4: '4242', fingerprint },
          }
        : null,
    });
    Object.assign(this.subscriptions.get(this.subscriptionOf(invoice)) ?? {}, {
      status: 'active',
    });
  }

  private subscriptionOf(invoice: Json): string {
    return str(
      ((invoice.parent as Json).subscription_details as Json).subscription,
    );
  }

  private paymentIntentOf(invoice: Json): Json {
    return this.paymentIntents.get(str(invoice._paymentIntent)) ?? {};
  }

  private requireInvoice(invoiceId: string): Json {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) throw new Error(`Unknown invoice ${invoiceId}`);
    return invoice;
  }

  private requireSubscription(subscriptionId: string): Json {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      throw new Error(`Unknown subscription ${subscriptionId}`);
    }
    return subscription;
  }

  /** Stripe expires an open session once `expires_at` has passed. */
  expireByTime(sessionId: string) {
    const session = this.requireSession(sessionId);
    if (session.status === 'open') {
      Object.assign(session, { status: 'expired', url: null });
    }
  }

  /**
   * A signed webhook delivery carrying the session as it is now (payload
   * objects are never expanded), like Stripe sends it.
   */
  signedEvent(
    type: string,
    sessionId: string,
    overrides: Json = {},
  ): { payload: string; signature: string } {
    return this.sign(type, {
      ...withoutInternals(this.requireSession(sessionId)),
      ...overrides,
    });
  }

  private sign(type: string, object: Json) {
    const eventId = this.id('evt');
    const payload = JSON.stringify({
      id: eventId,
      object: 'event',
      api_version: '2026-10-28.endive',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      type,
      data: { object },
    });
    const signature = this.client().webhooks.generateTestHeaderString({
      payload,
      secret: FAKE_WEBHOOK_SECRET,
    });
    return { payload, signature, eventId };
  }

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (this.latencyMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.random() * this.latencyMs),
      );
    }
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : '';
    const params = parseStripeForm(
      method === 'GET' ? url.search.slice(1) : body,
    );
    const idempotencyKey = headers.get('idempotency-key');
    this.requests.push({ method, path: url.pathname, params, idempotencyKey });

    const operation = `${method} ${url.pathname.replace(/\/(cs_test|cus|in|sub|pi|ch|re)_[^/]+/, '/:id')}`;
    const failure = this.failures.get(operation)?.shift();
    if (failure === 'connection') throw new TypeError('fetch failed');
    if (failure === 'server') {
      return json(500, { error: { type: 'api_error', message: 'boom' } });
    }
    if (failure === 'invalid') {
      return json(400, {
        error: { type: 'invalid_request_error', message: 'Invalid request' },
      });
    }

    const response = this.respond(method, url.pathname, params, idempotencyKey);
    if (failure === 'lost') throw new TypeError('fetch failed');
    return json(response.status, response.body, response.replayed);
  };

  private respond(
    method: string,
    path: string,
    params: Json,
    idempotencyKey: string | null,
  ): { status: number; body: Json; replayed?: boolean } {
    if (method === 'POST' && idempotencyKey) {
      const stored = this.idempotency.get(idempotencyKey);
      const fingerprint = `${path}?${JSON.stringify(params)}`;
      if (stored) {
        if (stored.params !== fingerprint) {
          return {
            status: 400,
            body: {
              error: {
                type: 'idempotency_error',
                message:
                  'Keys for idempotent requests can only be used with the same parameters they were first used with.',
              },
            },
          };
        }
        return { status: stored.status, body: stored.body, replayed: true };
      }
      const response = this.route(method, path, params);
      this.idempotency.set(idempotencyKey, {
        ...response,
        params: fingerprint,
      });
      return response;
    }
    return this.route(method, path, params);
  }

  private route(
    method: string,
    path: string,
    params: Json,
  ): { status: number; body: Json } {
    if (method === 'POST' && path === '/v1/customers') {
      const customer = {
        id: this.id('cus'),
        object: 'customer',
        email: params.email,
        metadata: params.metadata ?? {},
      };
      this.customers.set(customer.id, customer);
      return { status: 200, body: customer };
    }
    if (method === 'POST' && path === '/v1/checkout/sessions') {
      return this.createSession(params);
    }
    if (method === 'POST' && path === '/v1/coupons') {
      return this.createCoupon(params);
    }
    if (method === 'GET' && path === '/v1/refunds') {
      const data = [...this.refunds.values()]
        .filter((refund) => refund.charge === params.charge)
        .reverse();
      return {
        status: 200,
        body: { object: 'list', data, has_more: false, url: path },
      };
    }
    const charge = /^\/v1\/charges\/([^/]+)$/.exec(path);
    if (charge && method === 'GET') {
      const found = this.charges.get(charge[1]);
      return found
        ? { status: 200, body: { ...found } }
        : invalid(404, 'resource_missing', 'No such charge');
    }
    if (method === 'GET' && path === '/v1/invoice_payments') {
      const byIntent = str(
        (params.payment as Json | undefined)?.payment_intent,
      );
      const invoice = byIntent
        ? [...this.invoices.values()].find(
            (candidate) => candidate._paymentIntent === byIntent,
          )
        : this.invoices.get(str(params.invoice));
      const data = invoice
        ? [
            {
              id: `inpay_${str(invoice.id)}`,
              object: 'invoice_payment',
              invoice: invoice.id,
              status: invoice.status === 'paid' ? 'paid' : 'open',
              payment: {
                type: 'payment_intent',
                payment_intent: invoice._paymentIntent,
              },
            },
          ]
        : [];
      return {
        status: 200,
        body: { object: 'list', data, has_more: false, url: path },
      };
    }
    const intent = /^\/v1\/payment_intents\/([^/]+)$/.exec(path);
    if (intent && method === 'GET') {
      const found = this.paymentIntents.get(intent[1]);
      return found
        ? { status: 200, body: { ...found } }
        : invalid(404, 'resource_missing', 'No such payment_intent');
    }
    const update = /^\/v1\/subscriptions\/([^/]+)$/.exec(path);
    if (update && method === 'POST') {
      return this.updateSubscription(update[1], params);
    }
    const object = /^\/v1\/(invoices|subscriptions)\/([^/]+)$/.exec(path);
    if (object && method === 'GET') {
      const store =
        object[1] === 'invoices' ? this.invoices : this.subscriptions;
      const found = store.get(object[2]);
      return found
        ? { status: 200, body: withoutInternals(found) }
        : invalid(404, 'resource_missing', `No such ${object[1]}`);
    }
    const match = /^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/.exec(path);
    const session = match ? this.sessions.get(match[1]) : undefined;
    if (match && !session) {
      return invalid(404, 'resource_missing', 'No such checkout.session');
    }
    if (session && method === 'GET' && !match?.[2]) {
      return { status: 200, body: this.expand(session, params.expand) };
    }
    if (session && method === 'POST' && match?.[2]) {
      if (session.status !== 'open') {
        return invalid(
          400,
          undefined,
          'Only Checkout Sessions with a status in ["open"] can be expired.',
        );
      }
      Object.assign(session, { status: 'expired', url: null });
      return { status: 200, body: withoutInternals(session) };
    }
    return invalid(404, 'resource_missing', `Unknown route ${method} ${path}`);
  }

  private createSession(params: Json): { status: number; body: Json } {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = Number(params.expires_at);
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt < now + 30 * 60 ||
      expiresAt > now + 24 * 60 * 60
    ) {
      return invalid(
        400,
        'parameter_invalid_integer',
        'expires_at must be 30 minutes to 24 hours in the future',
      );
    }
    const customer = str(params.customer);
    if (!this.customers.has(customer)) {
      return invalid(400, 'resource_missing', 'No such customer');
    }
    const lineItems = params.line_items as Json[] | undefined;
    const priceData = lineItems?.[0]?.price_data as Json | undefined;
    const mode = str(params.mode);
    if (!['subscription', 'payment'].includes(mode) || !priceData) {
      return invalid(400, 'parameter_missing', 'Missing line item price');
    }
    if ((mode === 'payment') !== (priceData.recurring === undefined)) {
      return invalid(
        400,
        undefined,
        'Recurring prices require subscription mode, one-time prices payment mode',
      );
    }
    const discounts = params.discounts as Json[] | undefined;
    if (discounts && params.allow_promotion_codes !== undefined) {
      return invalid(
        400,
        undefined,
        'You may only specify one of these parameters: allow_promotion_codes, discounts.',
      );
    }
    const couponId = discounts ? str(discounts[0]?.coupon) : '';
    const coupon = couponId ? this.coupons.get(couponId) : undefined;
    if (couponId && !coupon) {
      return invalid(400, 'resource_missing', `No such coupon: '${couponId}'`);
    }
    const unitAmount = Number(priceData.unit_amount);
    const id = this.id('cs_test');
    const session: Json = {
      id,
      object: 'checkout.session',
      mode,
      status: 'open',
      payment_status: 'unpaid',
      url: `https://checkout.stripe.com/c/pay/${id}`,
      customer,
      client_reference_id: params.client_reference_id ?? null,
      metadata: params.metadata ?? {},
      subscription_data: params.subscription_data,
      currency: priceData.currency,
      amount_subtotal: unitAmount,
      amount_total: coupon
        ? Math.max(0, unitAmount - Number(coupon.amount_off))
        : unitAmount,
      discounts: coupon ? [{ coupon: coupon.id }] : [],
      expires_at: expiresAt,
      success_url: params.success_url,
      cancel_url: params.cancel_url,
      line_items: lineItems,
      subscription: null,
      invoice: null,
      payment_intent: null,
      // Not part of the Stripe session object: the PaymentIntent metadata.
      _paymentIntentMetadata:
        (params.payment_intent_data as Json | undefined)?.metadata ?? {},
    };
    this.sessions.set(id, session);
    return { status: 200, body: withoutInternals(session) };
  }

  /** POST /v1/coupons: a fixed amount off, like Stripe (ids are unique). */
  private createCoupon(params: Json): { status: number; body: Json } {
    const id = params.id ? str(params.id) : this.id('coupon');
    if (this.coupons.has(id)) {
      return invalid(400, 'resource_already_exists', 'Coupon already exists.');
    }
    const amountOff = Number(params.amount_off);
    if (!Number.isInteger(amountOff) || amountOff <= 0) {
      return invalid(400, 'parameter_invalid_integer', 'Invalid amount_off');
    }
    const coupon: Json = {
      id,
      object: 'coupon',
      amount_off: amountOff,
      percent_off: null,
      currency: params.currency ?? null,
      duration: params.duration,
      max_redemptions:
        params.max_redemptions === undefined
          ? null
          : Number(params.max_redemptions),
      times_redeemed: 0,
      name: params.name ?? null,
      metadata: params.metadata ?? {},
      valid: true,
    };
    this.coupons.set(id, coupon);
    return { status: 200, body: { ...coupon } };
  }

  /** The coupon a session was created with, if any. */
  private sessionCoupon(session: Json): Json | undefined {
    const discounts = session.discounts as Json[] | undefined;
    const couponId = discounts?.[0] ? str(discounts[0].coupon) : '';
    return couponId ? this.coupons.get(couponId) : undefined;
  }

  private expand(session: Json, expand: unknown): Json {
    const paths = Array.isArray(expand) ? expand.map(str) : [];
    const copy: Json = withoutInternals(session);
    delete copy.line_items;
    delete copy.subscription_data;
    if (paths.includes('payment_intent') && session.payment_intent) {
      const intent: Json = {
        ...this.paymentIntents.get(str(session.payment_intent)),
      };
      if (
        !paths.includes('payment_intent.payment_method') &&
        intent.payment_method
      ) {
        intent.payment_method = (intent.payment_method as Json).id;
      }
      copy.payment_intent = intent;
    }
    if (paths.includes('invoice') && session.invoice) {
      copy.invoice = withoutInternals(
        this.requireInvoice(str(session.invoice)),
      );
    }
    if (paths.includes('subscription') && session.subscription) {
      const subscription: Json = {
        ...this.subscriptions.get(str(session.subscription)),
      };
      if (paths.includes('subscription.latest_invoice')) {
        subscription.latest_invoice = withoutInternals(
          this.requireInvoice(str(subscription.latest_invoice)),
        );
      }
      copy.subscription = subscription;
    }
    return copy;
  }

  private requireSession(sessionId: string): Json {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    return session;
  }

  /** Globally unique like real Stripe ids, and ordered within one fake. */
  private id(prefix: string) {
    this.counter += 1;
    return `${prefix}_${this.counter.toString().padStart(6, '0')}${randomBytes(4).toString('hex')}`;
  }
}

/**
 * The end of the billing period starting at `startSeconds`, as Stripe
 * computes it: the next month (or year) on the anchor's day of month, clamped
 * to shorter months, at the anchor's time of day (UTC). A subscription
 * anchored on Jan 31 renews Feb 28, Mar 31, Apr 30, ...
 */
function anchoredPeriodEnd(
  anchorSeconds: number,
  startSeconds: number,
  interval: string,
): number {
  const anchor = new Date(anchorSeconds * 1000);
  const start = new Date(startSeconds * 1000);
  const months = interval === 'year' ? 12 : 1;
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Math.floor(
    Date.UTC(
      year,
      month,
      Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
    ) / 1000,
  );
}

function invalid(status: number, code: string | undefined, message: string) {
  return {
    status,
    body: { error: { type: 'invalid_request_error', code, message } },
  };
}

function json(status: number, body: Json, replayed = false): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'request-id': `req_${Math.random().toString(36).slice(2, 10)}`,
      ...(replayed ? { 'idempotent-replayed': 'true' } : {}),
    },
  });
}

/** Drops fields the fake keeps for itself (prefixed with `_`). */
function withoutInternals(object: Json): Json {
  return Object.fromEntries(
    Object.entries(object).filter(([key]) => !key.startsWith('_')),
  );
}
