import { Inject, Injectable } from '@nestjs/common';
import { BillingInterval } from '@prisma/client';
import Stripe from 'stripe';
import AppError from '../../common/errors/app.error';
import { STRIPE_SETTINGS, type StripeSettings } from './stripe.config';

/** `provider` value stored on payments, customers and checkouts. */
export const STRIPE_PROVIDER = 'stripe';

export const STRIPE_CLIENT = Symbol('STRIPE_CLIENT');

export const PRO_PRODUCT_NAME = 'MuseCue Pro';

/** Metadata keys written on every Stripe checkout and subscription. */
export const CHECKOUT_METADATA = {
  CHECKOUT_ID: 'checkoutSessionId',
  AUTH_ID: 'authId',
  BILLING_INTERVAL: 'billingInterval',
} as const;

export interface CheckoutSessionRequest {
  /** Local CheckoutSession id; also the source of the idempotency key. */
  checkoutId: string;
  authId: string;
  customerId: string;
  billingInterval: BillingInterval;
  /** The plan price: the subscription's price for every period. */
  amountCents: number;
  expiresAt: Date;
  /**
   * A discount off the first payment only (the subscription price stays
   * `amountCents`): a one-time Stripe coupon created for this checkout.
   */
  discount?: CheckoutDiscountRequest | null;
}

/** Metadata keys written on credit package checkouts and their payments. */
export const PACKAGE_CHECKOUT_METADATA = {
  ORDER_ID: 'creditPackageOrderId',
  AUTH_ID: 'authId',
  PACKAGE_CODE: 'creditPackageCode',
} as const;

/** A Stripe Checkout Session in payment mode for one credit package order. */
export interface PackageCheckoutRequest {
  /** Local CreditPackageOrder id; also the source of the idempotency key. */
  orderId: string;
  authId: string;
  customerId: string;
  packageCode: string;
  credits: number;
  /** The package's list price (the line item). */
  listPriceCents: number;
  /** The order's discount, as a one-time coupon. */
  discount?: CheckoutDiscountRequest | null;
  expiresAt: Date;
}

export interface CheckoutDiscountRequest {
  /** Cents off the first invoice. */
  amountOffCents: number;
  /** Shown to the customer on the Stripe checkout page and invoice. */
  name: string;
}

/** Why a collection attempt failed, as reported by Stripe. */
export interface PaymentFailureDetails {
  /** Decline code when available (e.g. `insufficient_funds`), else the error code. */
  code: string | null;
  message: string | null;
}

/** The parts of a Stripe Checkout Session the checkout flow relies on. */
export interface ProviderCheckoutSession {
  id: string;
  url: string | null;
  /** `open`, `complete` or `expired` (open enum). */
  status: string | null;
  /** `paid`, `unpaid` or `no_payment_required` (open enum). */
  paymentStatus: string;
}

export const stripeIdempotencyKeys = {
  customer: (authId: string) => `musecue-customer-${authId}`,
  checkout: (checkoutId: string) => `musecue-checkout-${checkoutId}`,
  coupon: (checkoutId: string) => `musecue-coupon-${checkoutId}`,
  packageCheckout: (orderId: string) => `musecue-credit-package-${orderId}`,
  /** One cancellation per subscription and paid term. */
  cancel: (subscriptionId: string, termEndsAt: Date) =>
    `musecue-cancel-${subscriptionId}-${termEndsAt.getTime()}`,
};

/** A subscription's cancellation state as Stripe reports it. */
export interface ProviderSubscriptionCancellation {
  id: string;
  status: string;
  /** Auto-renewal is off: the subscription ends at the current period end. */
  cancelAtPeriodEnd: boolean;
  /** When the cancellation was requested (Stripe `canceled_at`). */
  canceledAt: Date | null;
  /** When the subscription will end (Stripe `cancel_at`). */
  cancelAt: Date | null;
}

const fromSeconds = (value: number | null) =>
  value === null ? null : new Date(value * 1000);

export const toProviderCancellation = (
  subscription: Stripe.Subscription,
): ProviderSubscriptionCancellation => ({
  id: subscription.id,
  status: subscription.status,
  cancelAtPeriodEnd: subscription.cancel_at_period_end,
  canceledAt: fromSeconds(subscription.canceled_at),
  cancelAt: fromSeconds(subscription.cancel_at),
});

export const stripeInterval = (interval: BillingInterval): 'month' | 'year' =>
  interval === BillingInterval.MONTHLY ? 'month' : 'year';

/**
 * The only place that talks to the Stripe API. Every call that creates
 * something at Stripe carries a deterministic idempotency key, so a retried
 * or concurrent request returns the same Stripe object instead of a second
 * customer or checkout session.
 */
@Injectable()
export class StripeGateway {
  constructor(
    @Inject(STRIPE_SETTINGS) private readonly settings: StripeSettings,
    @Inject(STRIPE_CLIENT) private readonly client: Stripe | null,
  ) {}

  /** Checkout needs the API key and both redirect URLs. */
  get checkoutConfigured(): boolean {
    return (
      this.client !== null &&
      this.settings.successUrl !== null &&
      this.settings.cancelUrl !== null
    );
  }

  get checkoutExpiresMinutes(): number {
    return this.settings.checkoutExpiresMinutes;
  }

  async createCustomer(authId: string, email: string): Promise<string> {
    const customer = await this.requireClient().customers.create(
      { email, metadata: { [CHECKOUT_METADATA.AUTH_ID]: authId } },
      { idempotencyKey: stripeIdempotencyKeys.customer(authId) },
    );
    return customer.id;
  }

  /**
   * Creates the hosted subscription checkout for one local checkout row. The
   * parameters depend only on the row and configuration, so repeating the
   * call with the same row yields the same Stripe session.
   */
  async createCheckoutSession(
    request: CheckoutSessionRequest,
  ): Promise<ProviderCheckoutSession> {
    const couponId = request.discount
      ? await this.createCheckoutCoupon(request.checkoutId, request.discount)
      : null;
    const session = await this.requireClient().checkout.sessions.create(
      this.checkoutParams(request, couponId),
      { idempotencyKey: stripeIdempotencyKeys.checkout(request.checkoutId) },
    );
    return toProviderSession(session);
  }

  /**
   * A coupon for one checkout: a fixed amount off the first invoice only
   * (`duration: once`), usable once, with an id derived from the checkout.
   * The idempotency key makes retries return the same coupon, so the Stripe
   * charge is exactly the backend's discounted amount while the price of
   * the subscription (and of every renewal) stays the plan price.
   */
  private async createCheckoutCoupon(
    checkoutId: string,
    discount: CheckoutDiscountRequest,
    metadata: Record<string, string> = {
      [CHECKOUT_METADATA.CHECKOUT_ID]: checkoutId,
    },
  ): Promise<string> {
    const coupon = await this.requireClient().coupons.create(
      {
        id: `musecue-${checkoutId}`,
        amount_off: discount.amountOffCents,
        currency: 'usd',
        duration: 'once',
        max_redemptions: 1,
        name: discount.name.slice(0, 40),
        metadata,
      },
      { idempotencyKey: stripeIdempotencyKeys.coupon(checkoutId) },
    );
    return coupon.id;
  }

  /**
   * Creates the hosted one-time payment checkout for a credit package
   * order: the package at its list price, less the order's discount as a
   * one-time coupon, so Stripe charges exactly the order's amount. The
   * idempotency key derives from the order, so retried or concurrent calls
   * return the same Stripe session.
   */
  async createPackageCheckoutSession(
    request: PackageCheckoutRequest,
  ): Promise<ProviderCheckoutSession> {
    const metadata = {
      [PACKAGE_CHECKOUT_METADATA.ORDER_ID]: request.orderId,
      [PACKAGE_CHECKOUT_METADATA.AUTH_ID]: request.authId,
      [PACKAGE_CHECKOUT_METADATA.PACKAGE_CODE]: request.packageCode,
    };
    const couponId = request.discount
      ? await this.createCheckoutCoupon(request.orderId, request.discount, {
          [PACKAGE_CHECKOUT_METADATA.ORDER_ID]: request.orderId,
        })
      : null;
    const session = await this.requireClient().checkout.sessions.create(
      {
        mode: 'payment',
        customer: request.customerId,
        client_reference_id: request.authId,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: request.listPriceCents,
              product_data: {
                name: `${request.credits} MuseCue credits`,
              },
            },
          },
        ],
        ...(couponId
          ? { discounts: [{ coupon: couponId }] }
          : { allow_promotion_codes: false }),
        adaptive_pricing: { enabled: false },
        success_url: this.settings.successUrl ?? undefined,
        cancel_url: this.settings.cancelUrl ?? undefined,
        expires_at: Math.floor(request.expiresAt.getTime() / 1000),
        metadata,
        payment_intent_data: { metadata },
      },
      {
        idempotencyKey: stripeIdempotencyKeys.packageCheckout(request.orderId),
      },
    );
    return toProviderSession(session);
  }

  /**
   * A credit package checkout with its PaymentIntent and payment method,
   * read from Stripe for payment verification.
   */
  retrievePackageCheckout(sessionId: string): Promise<Stripe.Checkout.Session> {
    return this.requireClient().checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent', 'payment_intent.payment_method'],
    });
  }

  async retrieveCheckoutSession(
    sessionId: string,
  ): Promise<ProviderCheckoutSession> {
    return toProviderSession(
      await this.requireClient().checkout.sessions.retrieve(sessionId),
    );
  }

  /**
   * The session with its invoice and subscription (and the subscription's
   * latest invoice as a fallback), read from Stripe rather than taken from the
   * webhook payload, for payment verification.
   */
  retrieveCheckoutForVerification(
    sessionId: string,
  ): Promise<Stripe.Checkout.Session> {
    return this.requireClient().checkout.sessions.retrieve(sessionId, {
      expand: ['invoice', 'subscription', 'subscription.latest_invoice'],
    });
  }

  /** An invoice read from Stripe (not from the webhook payload). */
  retrieveInvoice(invoiceId: string): Promise<Stripe.Invoice> {
    return this.requireClient().invoices.retrieve(invoiceId);
  }

  /** A subscription with its items and their prices, read from Stripe. */
  retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    return this.requireClient().subscriptions.retrieve(subscriptionId);
  }

  /**
   * Why the latest collection attempt of an invoice failed (the PaymentIntent's
   * `last_payment_error`). Best effort: returns null when Stripe does not say
   * or cannot be asked, so a failure is recorded even without its reason.
   */
  async retrievePaymentFailure(
    invoiceId: string,
  ): Promise<PaymentFailureDetails | null> {
    try {
      const client = this.requireClient();
      const payments = await client.invoicePayments.list({
        invoice: invoiceId,
        limit: 1,
      });
      const intent = payments.data[0]?.payment.payment_intent;
      const intentId = typeof intent === 'string' ? intent : intent?.id;
      if (!intentId) return null;
      const error = (await client.paymentIntents.retrieve(intentId))
        .last_payment_error;
      if (!error) return null;
      return {
        code: error.decline_code ?? error.code ?? null,
        message: error.message ?? null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Turns auto-renewal off: the subscription stays active and paid until the
   * end of its current period, then Stripe ends it. Nothing is refunded and
   * the period is not shortened.
   */
  async cancelAtPeriodEnd(
    subscriptionId: string,
    termEndsAt: Date,
  ): Promise<ProviderSubscriptionCancellation> {
    return toProviderCancellation(
      await this.requireClient().subscriptions.update(
        subscriptionId,
        { cancel_at_period_end: true },
        {
          idempotencyKey: stripeIdempotencyKeys.cancel(
            subscriptionId,
            termEndsAt,
          ),
        },
      ),
    );
  }

  /**
   * Whether the configured key is a live-mode key (`sk_live_` / `rk_live_`).
   * Events of the other mode are not about this integration's objects.
   */
  get liveMode(): boolean {
    return /^(sk|rk)_live_/.test(this.settings.secretKey ?? '');
  }

  /** Whether the Stripe API can be called (secret key configured). */
  get apiConfigured(): boolean {
    return this.client !== null;
  }

  /** A charge read from Stripe (not from the webhook payload). */
  retrieveCharge(chargeId: string): Promise<Stripe.Charge> {
    return this.requireClient().charges.retrieve(chargeId);
  }

  /** Every refund of a charge, in any status, read from Stripe. */
  listChargeRefunds(chargeId: string): Promise<Stripe.Refund[]> {
    return this.requireClient()
      .refunds.list({ charge: chargeId, limit: 100 })
      .autoPagingToArray({ limit: 10_000 });
  }

  /** The invoice a PaymentIntent paid, or null if it paid no invoice. */
  async findInvoiceForPaymentIntent(
    paymentIntentId: string,
  ): Promise<string | null> {
    const payments = await this.requireClient().invoicePayments.list({
      payment: { type: 'payment_intent', payment_intent: paymentIntentId },
      limit: 1,
    });
    const invoice = payments.data[0]?.invoice;
    return typeof invoice === 'string' ? invoice : (invoice?.id ?? null);
  }

  /**
   * The charge that collected an invoice, or null when the invoice has no
   * collected payment. Used to find refunds made before the payment itself
   * was recorded.
   */
  async findChargeForInvoice(invoiceId: string): Promise<string | null> {
    const client = this.requireClient();
    const payments = await client.invoicePayments.list({
      invoice: invoiceId,
      limit: 10,
    });
    const paid = payments.data.find((payment) => payment.status === 'paid');
    if (!paid) return null;
    const direct = paid.payment.charge;
    if (direct) return typeof direct === 'string' ? direct : direct.id;
    const intent = paid.payment.payment_intent;
    const intentId = typeof intent === 'string' ? intent : intent?.id;
    if (!intentId) return null;
    const charge = (await client.paymentIntents.retrieve(intentId))
      .latest_charge;
    return typeof charge === 'string' ? charge : (charge?.id ?? null);
  }

  /**
   * The fingerprint of the payment method that paid an invoice (the same
   * card or bank account always has the same fingerprint), or null when the
   * invoice has no collected payment or its method has none. Callers hash
   * it at once and never store it.
   */
  async retrievePaymentMethodFingerprint(
    invoiceId: string,
  ): Promise<string | null> {
    const client = this.requireClient();
    const payments = await client.invoicePayments.list({
      invoice: invoiceId,
      limit: 10,
    });
    const paid = payments.data.find((payment) => payment.status === 'paid');
    const intent = paid?.payment.payment_intent;
    const intentId = typeof intent === 'string' ? intent : intent?.id;
    if (!intentId) return null;
    const paymentIntent = await client.paymentIntents.retrieve(intentId, {
      expand: ['payment_method'],
    });
    return paymentMethodFingerprint(paymentIntent.payment_method);
  }

  /** Stripe only expires `open` sessions; others reject the request. */
  async expireCheckoutSession(
    sessionId: string,
  ): Promise<ProviderCheckoutSession> {
    return toProviderSession(
      await this.requireClient().checkout.sessions.expire(sessionId),
    );
  }

  /**
   * Verifies the `Stripe-Signature` header against the raw request body
   * (including the timestamp tolerance that limits replays) and parses the
   * event. Unsigned or tampered payloads are rejected with 400.
   */
  constructEvent(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Stripe.Event {
    if (!this.client || !this.settings.webhookSecret) {
      throw AppError.serviceUnavailable('Payments are not configured');
    }
    if (!rawBody || rawBody.length === 0 || !signature) {
      throw AppError.badRequest('Invalid webhook signature');
    }
    try {
      return this.client.webhooks.constructEvent(
        rawBody,
        signature,
        this.settings.webhookSecret,
      );
    } catch {
      throw AppError.badRequest('Invalid webhook signature');
    }
  }

  /**
   * True when Stripe definitely rejected the request, so nothing was created
   * and the same request will keep failing. Network failures, timeouts,
   * rate limits, server errors and idempotency conflicts are not definitive:
   * the object may exist at Stripe.
   */
  static isDefinitiveRejection(error: unknown): boolean {
    return (
      error instanceof Stripe.errors.StripeInvalidRequestError ||
      error instanceof Stripe.errors.StripeAuthenticationError ||
      error instanceof Stripe.errors.StripePermissionError
    );
  }

  private checkoutParams(
    request: CheckoutSessionRequest,
    couponId: string | null,
  ): Stripe.Checkout.SessionCreateParams {
    const metadata = {
      [CHECKOUT_METADATA.CHECKOUT_ID]: request.checkoutId,
      [CHECKOUT_METADATA.AUTH_ID]: request.authId,
      [CHECKOUT_METADATA.BILLING_INTERVAL]: request.billingInterval,
    };
    return {
      mode: 'subscription',
      customer: request.customerId,
      client_reference_id: request.authId,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: request.amountCents,
            recurring: {
              interval: stripeInterval(request.billingInterval),
              interval_count: 1,
            },
            ...(this.settings.productId
              ? { product: this.settings.productId }
              : { product_data: { name: PRO_PRODUCT_NAME } }),
          },
        },
      ],
      // The charged amount must equal the backend price in USD, less the
      // backend's discount (Stripe accepts either a discount or the
      // promotion-code switch, not both; customers never enter codes there).
      ...(couponId
        ? { discounts: [{ coupon: couponId }] }
        : { allow_promotion_codes: false }),
      adaptive_pricing: { enabled: false },
      success_url: this.settings.successUrl ?? undefined,
      cancel_url: this.settings.cancelUrl ?? undefined,
      expires_at: Math.floor(request.expiresAt.getTime() / 1000),
      metadata,
      subscription_data: { metadata },
    };
  }

  private requireClient(): Stripe {
    if (!this.client) {
      throw AppError.serviceUnavailable('Payments are not configured');
    }
    return this.client;
  }
}

function toProviderSession(
  session: Stripe.Checkout.Session,
): ProviderCheckoutSession {
  return {
    id: session.id,
    url: session.url,
    status: session.status,
    paymentStatus: session.payment_status,
  };
}

/**
 * The fingerprint of an expanded payment method (the same card or bank
 * account always has the same one), or null. Callers hash it at once.
 */
export function paymentMethodFingerprint(
  method: string | Stripe.PaymentMethod | null,
): string | null {
  if (!method || typeof method === 'string') return null;
  return (
    method.card?.fingerprint ??
    method.us_bank_account?.fingerprint ??
    method.sepa_debit?.fingerprint ??
    method.bacs_debit?.fingerprint ??
    method.au_becs_debit?.fingerprint ??
    method.acss_debit?.fingerprint ??
    null
  );
}
