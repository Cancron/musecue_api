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
   */
  completeSession(
    sessionId: string,
    options: {
      paymentStatus?: 'paid' | 'unpaid';
      periodStart?: Date;
      invoiceAmount?: number;
    } = {},
  ): Json {
    const session = this.requireSession(sessionId);
    if (session.status !== 'open') {
      throw new Error(`Session ${sessionId} is ${str(session.status)}`);
    }
    const paid = (options.paymentStatus ?? 'paid') === 'paid';
    const lineItem = (session.line_items as Json[])[0];
    const priceData = lineItem.price_data as Json;
    const amount = Number(priceData.unit_amount);
    const interval = str((priceData.recurring as Json).interval);
    const start = Math.floor(
      (options.periodStart ?? new Date()).getTime() / 1000,
    );
    const end = anchoredPeriodEnd(start, start, interval);
    const subscriptionId = this.id('sub');
    const invoiceId = this.id('in');
    const created = Math.floor(Date.now() / 1000);

    this.invoices.set(invoiceId, {
      id: invoiceId,
      object: 'invoice',
      billing_reason: 'subscription_create',
      customer: session.customer,
      currency: 'usd',
      amount_paid: paid ? (options.invoiceAmount ?? amount) : 0,
      status: paid ? 'paid' : 'open',
      status_transitions: { paid_at: paid ? created : null },
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: subscriptionId, metadata: {} },
      },
      lines: {
        object: 'list',
        data: [
          {
            id: this.id('il'),
            object: 'line_item',
            amount,
            period: { start, end },
          },
        ],
      },
    });
    this.subscriptions.set(subscriptionId, {
      id: subscriptionId,
      object: 'subscription',
      customer: session.customer,
      status: paid ? 'active' : 'incomplete',
      billing_cycle_anchor: start,
      metadata: (session.subscription_data as Json | undefined)?.metadata ?? {},
      latest_invoice: invoiceId,
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
      status: 'complete',
      payment_status: paid ? 'paid' : 'unpaid',
      subscription: subscriptionId,
      invoice: invoiceId,
      url: null,
    });
    return session;
  }

  /**
   * Stripe bills the next period of a subscription: a `subscription_cycle`
   * invoice for [current period end, next anchored end). Returns the invoice.
   * `paid: false` leaves the invoice open (failed renewal payment).
   */
  renewSubscription(
    subscriptionId: string,
    options: { paid?: boolean; amount?: number } = {},
  ): Json {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription)
      throw new Error(`Unknown subscription ${subscriptionId}`);
    const item = (subscription.items as { data: Json[] }).data[0];
    const price = item.price as Json;
    const interval = str((price.recurring as Json).interval);
    const start = Number(item.current_period_end);
    const end = anchoredPeriodEnd(
      Number(subscription.billing_cycle_anchor),
      start,
      interval,
    );
    const paid = options.paid ?? true;
    const amount = options.amount ?? Number(price.unit_amount);
    const invoiceId = this.id('in');
    this.invoices.set(invoiceId, {
      id: invoiceId,
      object: 'invoice',
      billing_reason: 'subscription_cycle',
      customer: subscription.customer,
      currency: 'usd',
      amount_paid: paid ? amount : 0,
      status: paid ? 'paid' : 'open',
      status_transitions: {
        paid_at: paid ? Math.floor(Date.now() / 1000) : null,
      },
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: subscriptionId, metadata: {} },
      },
      lines: {
        object: 'list',
        data: [
          {
            id: this.id('il'),
            object: 'line_item',
            amount,
            period: { start, end },
          },
        ],
      },
    });
    Object.assign(item, {
      current_period_start: start,
      current_period_end: end,
    });
    Object.assign(subscription, {
      latest_invoice: invoiceId,
      status: paid ? 'active' : 'past_due',
    });
    return this.invoices.get(invoiceId) as Json;
  }

  /** A failed renewal invoice is paid later (e.g. after a card update). */
  payInvoice(invoiceId: string) {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) throw new Error(`Unknown invoice ${invoiceId}`);
    const line = (invoice.lines as { data: Json[] }).data[0];
    Object.assign(invoice, {
      status: 'paid',
      amount_paid: line.amount,
      status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
    });
    const subscriptionId = str(
      ((invoice.parent as Json).subscription_details as Json).subscription,
    );
    Object.assign(this.subscriptions.get(subscriptionId) ?? {}, {
      status: 'active',
    });
  }

  /** A signed event for an invoice, carrying the invoice as it is now. */
  signedInvoiceEvent(
    type: string,
    invoiceId: string,
    overrides: Json = {},
  ): { payload: string; signature: string } {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) throw new Error(`Unknown invoice ${invoiceId}`);
    return this.sign(type, { ...invoice, ...overrides });
  }

  /** The delayed payment of an `unpaid` completed session settles. */
  settleDelayedPayment(sessionId: string) {
    const session = this.requireSession(sessionId);
    const invoice = this.invoices.get(str(session.invoice));
    const subscription = this.subscriptions.get(str(session.subscription));
    if (!invoice || !subscription) throw new Error('Session is not completed');
    const lineItem = (session.line_items as Json[])[0];
    Object.assign(invoice, {
      status: 'paid',
      amount_paid: Number((lineItem.price_data as Json).unit_amount),
      status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
    });
    Object.assign(subscription, { status: 'active' });
    Object.assign(session, { payment_status: 'paid' });
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
    return this.sign(type, { ...this.requireSession(sessionId), ...overrides });
  }

  private sign(type: string, object: Json) {
    const payload = JSON.stringify({
      id: this.id('evt'),
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
    return { payload, signature };
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

    const operation = `${method} ${url.pathname.replace(/\/(cs_test|cus|in|sub)_[^/]+/, '/:id')}`;
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
    const object = /^\/v1\/(invoices|subscriptions)\/([^/]+)$/.exec(path);
    if (object && method === 'GET') {
      const store =
        object[1] === 'invoices' ? this.invoices : this.subscriptions;
      const found = store.get(object[2]);
      return found
        ? { status: 200, body: { ...found } }
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
      return { status: 200, body: { ...session } };
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
    if (params.mode !== 'subscription' || !priceData) {
      return invalid(400, 'parameter_missing', 'Missing subscription price');
    }
    const id = this.id('cs_test');
    const session: Json = {
      id,
      object: 'checkout.session',
      mode: 'subscription',
      status: 'open',
      payment_status: 'unpaid',
      url: `https://checkout.stripe.com/c/pay/${id}`,
      customer,
      client_reference_id: params.client_reference_id ?? null,
      metadata: params.metadata ?? {},
      subscription_data: params.subscription_data,
      currency: priceData.currency,
      amount_total: Number(priceData.unit_amount),
      expires_at: expiresAt,
      success_url: params.success_url,
      cancel_url: params.cancel_url,
      line_items: lineItems,
      subscription: null,
      invoice: null,
    };
    this.sessions.set(id, session);
    return { status: 200, body: { ...session } };
  }

  private expand(session: Json, expand: unknown): Json {
    const paths = Array.isArray(expand) ? expand.map(str) : [];
    const copy: Json = { ...session };
    delete copy.line_items;
    delete copy.subscription_data;
    if (paths.includes('invoice') && session.invoice) {
      copy.invoice = { ...this.invoices.get(str(session.invoice)) };
    }
    if (paths.includes('subscription') && session.subscription) {
      const subscription: Json = {
        ...this.subscriptions.get(str(session.subscription)),
      };
      if (paths.includes('subscription.latest_invoice')) {
        subscription.latest_invoice = {
          ...this.invoices.get(str(subscription.latest_invoice)),
        };
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
