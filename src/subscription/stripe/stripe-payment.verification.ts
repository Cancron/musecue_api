import { BillingInterval } from '@prisma/client';
import type Stripe from 'stripe';
import { isValidBillingPeriod } from '../billing.validation';
import { CHECKOUT_METADATA, stripeInterval } from './stripe.gateway';

/** The stored checkout a Stripe session must match. */
export interface ExpectedCheckout {
  id: string;
  providerSessionId: string | null;
  providerCustomerId: string;
  billingInterval: BillingInterval;
  /** The plan price: the subscription's price for every period. */
  amountCents: number;
  /** Off the first payment (a one-time coupon); 0 without a discount. */
  discountCents: number;
  currency: string;
}

/** A payment proven by Stripe, ready to be recorded as SUCCEEDED. */
export interface VerifiedStripePayment {
  /** Null when the payment was confirmed from its invoice, not the session. */
  providerSessionId: string | null;
  /** Stripe invoice id (`in_...`): the charge for the first billing period. */
  providerPaymentId: string;
  providerSubscriptionId: string;
  amountCents: number;
  currency: 'USD';
  billingInterval: BillingInterval;
  /** The paid period exactly as reported by Stripe (invoice line period). */
  periodStart: Date;
  periodEnd: Date;
  paidAt: Date | null;
}

export type CheckoutRejectionReason =
  | 'SESSION_MISMATCH'
  | 'NOT_SUBSCRIPTION_MODE'
  | 'NOT_COMPLETE'
  | 'CUSTOMER_MISMATCH'
  | 'NO_PAYMENT_COLLECTED'
  | 'CURRENCY_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'SUBSCRIPTION_MISSING'
  | 'SUBSCRIPTION_NOT_PAID'
  | 'PRICE_MISMATCH'
  | 'INVOICE_MISSING'
  | 'INVOICE_NOT_INITIAL'
  | 'INVOICE_NOT_PAID'
  | 'INVALID_PERIOD';

export type CheckoutVerification =
  | { outcome: 'PAID'; payment: VerifiedStripePayment }
  /** Completed with a delayed payment method; wait for the async result. */
  | { outcome: 'AWAITING_PAYMENT' }
  | { outcome: 'REJECTED'; reason: CheckoutRejectionReason };

const idOf = (value: string | { id: string } | null | undefined) =>
  typeof value === 'string' ? value : (value?.id ?? null);

const expanded = <T extends { id: string }>(
  value: string | T | null | undefined,
): T | null => (value && typeof value === 'object' ? value : null);

const reject = (reason: CheckoutRejectionReason): CheckoutVerification => ({
  outcome: 'REJECTED',
  reason,
});

/** Subscription states in which the first invoice was never paid. */
const UNPAID_SUBSCRIPTION_STATUSES = new Set([
  'incomplete',
  'incomplete_expired',
]);

/**
 * Decides whether a Checkout Session retrieved from Stripe proves that the
 * stored checkout was paid. Every fact that grants access is checked against
 * what the backend stored when the checkout was created (customer, price,
 * interval, currency), not against client input or the webhook payload:
 *
 * - the session belongs to this checkout and customer and is a completed
 *   subscription checkout with `payment_status = paid`;
 * - the subscription has exactly one item at the stored price and interval;
 * - its first invoice (`subscription_create`) is paid in full in USD: the
 *   stored price less the checkout's discount (a one-time coupon), so the
 *   charge reflects the discount while the subscription keeps the plan
 *   price. With a 100% discount that is exactly $0 (Stripe reports
 *   `no_payment_required` and a paid $0 invoice).
 *
 * Anything else is rejected; a delayed payment method that has not settled
 * yet is reported as AWAITING_PAYMENT.
 */
export function verifyStripeCheckout(
  session: Stripe.Checkout.Session,
  expected: ExpectedCheckout,
): CheckoutVerification {
  if (
    (expected.providerSessionId !== null &&
      session.id !== expected.providerSessionId) ||
    session.metadata?.[CHECKOUT_METADATA.CHECKOUT_ID] !== expected.id
  ) {
    return reject('SESSION_MISMATCH');
  }
  if (session.mode !== 'subscription') return reject('NOT_SUBSCRIPTION_MODE');
  if (session.status !== 'complete') return reject('NOT_COMPLETE');
  if (idOf(session.customer) !== expected.providerCustomerId) {
    return reject('CUSTOMER_MISMATCH');
  }
  const charged = expected.amountCents - expected.discountCents;
  if (session.payment_status === 'unpaid') {
    return { outcome: 'AWAITING_PAYMENT' };
  }
  // A 100% discount: nothing is due for the first period, so Stripe reports
  // no payment required (the first invoice is paid with $0).
  const nothingDue =
    charged === 0 && session.payment_status === 'no_payment_required';
  if (session.payment_status !== 'paid' && !nothingDue) {
    return reject('NO_PAYMENT_COLLECTED');
  }

  const currency = expected.currency.toLowerCase();
  if (session.currency !== currency) return reject('CURRENCY_MISMATCH');
  if (session.amount_total !== charged) {
    return reject('AMOUNT_MISMATCH');
  }

  const subscription = expanded(session.subscription);
  if (!subscription) return reject('SUBSCRIPTION_MISSING');
  if (
    idOf(subscription.customer) !== expected.providerCustomerId ||
    UNPAID_SUBSCRIPTION_STATUSES.has(subscription.status)
  ) {
    return reject('SUBSCRIPTION_NOT_PAID');
  }
  const items = subscription.items.data;
  const price = items.length === 1 ? items[0].price : null;
  if (
    !price ||
    (items[0].quantity ?? 1) !== 1 ||
    price.currency !== currency ||
    price.unit_amount !== expected.amountCents ||
    price.recurring?.interval !== stripeInterval(expected.billingInterval) ||
    price.recurring.interval_count !== 1
  ) {
    return reject('PRICE_MISMATCH');
  }

  const invoice =
    expanded(session.invoice) ?? expanded(subscription.latest_invoice);
  if (!invoice) return reject('INVOICE_MISSING');
  const invoiceSubscription = idOf(
    invoice.parent?.subscription_details?.subscription,
  );
  if (
    invoice.billing_reason !== 'subscription_create' ||
    (invoiceSubscription !== null && invoiceSubscription !== subscription.id)
  ) {
    return reject('INVOICE_NOT_INITIAL');
  }
  if (
    invoice.status !== 'paid' ||
    invoice.currency !== currency ||
    invoice.amount_paid !== charged ||
    idOf(invoice.customer) !== expected.providerCustomerId
  ) {
    return reject('INVOICE_NOT_PAID');
  }

  const period = stripePeriod(invoice, expected.billingInterval);
  if (!period) return reject('INVALID_PERIOD');

  return {
    outcome: 'PAID',
    payment: {
      providerSessionId: session.id,
      providerPaymentId: invoice.id,
      providerSubscriptionId: subscription.id,
      amountCents: charged,
      currency: 'USD',
      billingInterval: expected.billingInterval,
      ...period,
      paidAt: paidAtOf(invoice),
    },
  };
}

/**
 * The paid period of a single-line subscription invoice, exactly as Stripe
 * reports it, or null if it is not a valid billing period for the interval.
 */
function stripePeriod(
  invoice: Stripe.Invoice,
  interval: BillingInterval,
): { periodStart: Date; periodEnd: Date } | null {
  const line = invoice.lines.data.length === 1 ? invoice.lines.data[0] : null;
  if (!line) return null;
  const periodStart = new Date(line.period.start * 1000);
  const periodEnd = new Date(line.period.end * 1000);
  return isValidBillingPeriod(periodStart, periodEnd, interval)
    ? { periodStart, periodEnd }
    : null;
}

const paidAtOf = (invoice: Stripe.Invoice): Date | null => {
  const paidAt = invoice.status_transitions.paid_at;
  return paidAt ? new Date(paidAt * 1000) : null;
};

/** The Stripe subscription an invoice must belong to, as stored at checkout. */
export interface ExpectedInvoice {
  providerSubscriptionId: string;
  providerCustomerId: string;
  billingInterval: BillingInterval;
  /** The price fixed when the subscription was bought. */
  amountCents: number;
  /**
   * Off the first (`subscription_create`) invoice only: the checkout's
   * one-time discount. Renewals are charged `amountCents`.
   */
  initialDiscountCents?: number;
  currency: string;
  /**
   * The MuseCue checkout that created the subscription. When given, the
   * subscription's metadata must name it.
   */
  checkoutId?: string;
}

/** The Stripe subscription a renewal must belong to, as stored at checkout. */
export type ExpectedRenewal = ExpectedInvoice;

/** `subscription_create` is the first payment, `subscription_cycle` a renewal. */
export type InvoiceKind = 'INITIAL' | 'RENEWAL';

/** A subscription invoice of the stored subscription, as Stripe reports it. */
export interface VerifiedStripeInvoice {
  providerInvoiceId: string;
  providerSubscriptionId: string;
  kind: InvoiceKind;
  amountCents: number;
  currency: 'USD';
  billingInterval: BillingInterval;
  periodStart: Date;
  periodEnd: Date;
  paidAt: Date | null;
  /** Collection attempts so far (Stripe `attempt_count`). */
  attemptCount: number;
  /** When Stripe retries next; null when no retry is scheduled. */
  nextRetryAt: Date | null;
}

export type InvoiceRejectionReason =
  | 'NOT_A_SUBSCRIPTION_PAYMENT'
  | 'SUBSCRIPTION_MISMATCH'
  | 'CUSTOMER_MISMATCH'
  | 'INVOICE_NOT_PAYABLE'
  | 'CURRENCY_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'PRICE_MISMATCH'
  | 'INVALID_PERIOD';

export type InvoiceVerification =
  /** Collected in full. */
  | { outcome: 'PAID'; invoice: VerifiedStripeInvoice }
  /** Still open (or uncollectible): nothing has been collected. */
  | { outcome: 'UNPAID'; invoice: VerifiedStripeInvoice }
  | { outcome: 'REJECTED'; reason: InvoiceRejectionReason };

const rejectInvoice = (
  reason: InvoiceRejectionReason,
): InvoiceVerification => ({ outcome: 'REJECTED', reason });

const INVOICE_KINDS: Record<string, InvoiceKind> = {
  subscription_create: 'INITIAL',
  subscription_cycle: 'RENEWAL',
};

/**
 * Decides what an invoice and its subscription, both read from the Stripe
 * API, say about a payment of the stored subscription:
 *
 * - it is the first (`subscription_create`) or a recurring
 *   (`subscription_cycle`) invoice of this Stripe subscription and customer;
 * - it is for the price the subscription was bought for, in USD, and the
 *   subscription still has exactly one item at that price and interval;
 * - its single line covers a valid billing period (dates as Stripe reports);
 * - PAID when collected in full, UNPAID while open or uncollectible. Void or
 *   draft invoices are rejected.
 */
export function verifyStripeInvoice(
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription,
  expected: ExpectedInvoice,
): InvoiceVerification {
  const kind = INVOICE_KINDS[invoice.billing_reason ?? ''];
  if (!kind) return rejectInvoice('NOT_A_SUBSCRIPTION_PAYMENT');
  if (
    idOf(invoice.parent?.subscription_details?.subscription) !==
      expected.providerSubscriptionId ||
    subscription.id !== expected.providerSubscriptionId ||
    (expected.checkoutId !== undefined &&
      subscription.metadata?.[CHECKOUT_METADATA.CHECKOUT_ID] !==
        expected.checkoutId)
  ) {
    return rejectInvoice('SUBSCRIPTION_MISMATCH');
  }
  if (
    idOf(invoice.customer) !== expected.providerCustomerId ||
    idOf(subscription.customer) !== expected.providerCustomerId
  ) {
    return rejectInvoice('CUSTOMER_MISMATCH');
  }
  const paid = invoice.status === 'paid';
  if (
    !paid &&
    invoice.status !== 'open' &&
    invoice.status !== 'uncollectible'
  ) {
    return rejectInvoice('INVOICE_NOT_PAYABLE');
  }
  const currency = expected.currency.toLowerCase();
  const expectedAmount =
    kind === 'INITIAL'
      ? expected.amountCents - (expected.initialDiscountCents ?? 0)
      : expected.amountCents;
  if (invoice.currency !== currency) return rejectInvoice('CURRENCY_MISMATCH');
  if ((paid ? invoice.amount_paid : invoice.amount_due) !== expectedAmount) {
    return rejectInvoice('AMOUNT_MISMATCH');
  }

  const items = subscription.items.data;
  const price = items.length === 1 ? items[0].price : null;
  if (
    !price ||
    (items[0].quantity ?? 1) !== 1 ||
    price.currency !== currency ||
    price.unit_amount !== expected.amountCents ||
    price.recurring?.interval !== stripeInterval(expected.billingInterval) ||
    price.recurring.interval_count !== 1
  ) {
    return rejectInvoice('PRICE_MISMATCH');
  }

  const period = stripePeriod(invoice, expected.billingInterval);
  if (!period) return rejectInvoice('INVALID_PERIOD');

  const nextRetry = invoice.next_payment_attempt;
  return {
    outcome: paid ? 'PAID' : 'UNPAID',
    invoice: {
      providerInvoiceId: invoice.id,
      providerSubscriptionId: expected.providerSubscriptionId,
      kind,
      amountCents: expectedAmount,
      currency: 'USD',
      billingInterval: expected.billingInterval,
      ...period,
      paidAt: paid ? paidAtOf(invoice) : null,
      attemptCount: invoice.attempt_count,
      nextRetryAt: nextRetry ? new Date(nextRetry * 1000) : null,
    },
  };
}

/** A verified recurring payment, ready to be recorded as SUCCEEDED. */
export interface VerifiedStripeRenewal {
  /** Stripe invoice id (`in_...`). */
  providerPaymentId: string;
  providerSubscriptionId: string;
  amountCents: number;
  currency: 'USD';
  billingInterval: BillingInterval;
  periodStart: Date;
  periodEnd: Date;
  paidAt: Date | null;
}

export type RenewalRejectionReason =
  | 'NOT_A_RENEWAL'
  | 'SUBSCRIPTION_MISMATCH'
  | 'CUSTOMER_MISMATCH'
  | 'INVOICE_NOT_PAID'
  | 'CURRENCY_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'PRICE_MISMATCH'
  | 'INVALID_PERIOD';

export type RenewalVerification =
  | { outcome: 'PAID'; payment: VerifiedStripeRenewal }
  | { outcome: 'REJECTED'; reason: RenewalRejectionReason };

const rejectRenewal = (
  reason: RenewalRejectionReason,
): RenewalVerification => ({ outcome: 'REJECTED', reason });

/**
 * Whether an invoice proves a paid renewal of the stored subscription: a
 * `subscription_cycle` invoice that verifyStripeInvoice reports as PAID.
 */
export function verifyStripeRenewal(
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription,
  expected: ExpectedRenewal,
): RenewalVerification {
  if (invoice.billing_reason !== 'subscription_cycle') {
    return rejectRenewal('NOT_A_RENEWAL');
  }
  const result = verifyStripeInvoice(invoice, subscription, expected);
  if (result.outcome === 'REJECTED') {
    return rejectRenewal(
      result.reason === 'INVOICE_NOT_PAYABLE'
        ? 'INVOICE_NOT_PAID'
        : result.reason === 'NOT_A_SUBSCRIPTION_PAYMENT'
          ? 'NOT_A_RENEWAL'
          : result.reason,
    );
  }
  if (result.outcome === 'UNPAID') return rejectRenewal('INVOICE_NOT_PAID');
  const verified = result.invoice;
  return {
    outcome: 'PAID',
    payment: {
      providerPaymentId: verified.providerInvoiceId,
      providerSubscriptionId: verified.providerSubscriptionId,
      amountCents: verified.amountCents,
      currency: verified.currency,
      billingInterval: verified.billingInterval,
      periodStart: verified.periodStart,
      periodEnd: verified.periodEnd,
      paidAt: verified.paidAt,
    },
  };
}
