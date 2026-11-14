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
  amountCents: number;
  currency: string;
}

/** A payment proven by Stripe, ready to be recorded as SUCCEEDED. */
export interface VerifiedStripePayment {
  providerSessionId: string;
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
 * - its first invoice (`subscription_create`) is paid in full in USD.
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
  if (session.payment_status === 'unpaid') {
    return { outcome: 'AWAITING_PAYMENT' };
  }
  if (session.payment_status !== 'paid') return reject('NO_PAYMENT_COLLECTED');

  const currency = expected.currency.toLowerCase();
  if (session.currency !== currency) return reject('CURRENCY_MISMATCH');
  if (session.amount_total !== expected.amountCents) {
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
    invoice.amount_paid !== expected.amountCents ||
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
      amountCents: expected.amountCents,
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

/** The Stripe subscription a renewal must belong to, as stored at checkout. */
export interface ExpectedRenewal {
  providerSubscriptionId: string;
  providerCustomerId: string;
  billingInterval: BillingInterval;
  /** The price fixed when the subscription was bought. */
  amountCents: number;
  currency: string;
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
 * Decides whether an invoice and its subscription, both read from the Stripe
 * API, prove a paid renewal of the stored subscription:
 *
 * - a `subscription_cycle` invoice of this Stripe subscription and customer;
 * - `paid`, in full, in USD, at the price the subscription was bought for;
 * - the subscription still has exactly one item at that price and interval;
 * - its single line covers a valid billing period, whose dates are used as
 *   reported by Stripe.
 */
export function verifyStripeRenewal(
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription,
  expected: ExpectedRenewal,
): RenewalVerification {
  if (invoice.billing_reason !== 'subscription_cycle') {
    return rejectRenewal('NOT_A_RENEWAL');
  }
  if (
    idOf(invoice.parent?.subscription_details?.subscription) !==
      expected.providerSubscriptionId ||
    subscription.id !== expected.providerSubscriptionId
  ) {
    return rejectRenewal('SUBSCRIPTION_MISMATCH');
  }
  if (
    idOf(invoice.customer) !== expected.providerCustomerId ||
    idOf(subscription.customer) !== expected.providerCustomerId
  ) {
    return rejectRenewal('CUSTOMER_MISMATCH');
  }
  if (invoice.status !== 'paid') return rejectRenewal('INVOICE_NOT_PAID');
  const currency = expected.currency.toLowerCase();
  if (invoice.currency !== currency) return rejectRenewal('CURRENCY_MISMATCH');
  if (invoice.amount_paid !== expected.amountCents) {
    return rejectRenewal('AMOUNT_MISMATCH');
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
    return rejectRenewal('PRICE_MISMATCH');
  }

  const period = stripePeriod(invoice, expected.billingInterval);
  if (!period) return rejectRenewal('INVALID_PERIOD');

  return {
    outcome: 'PAID',
    payment: {
      providerPaymentId: invoice.id,
      providerSubscriptionId: expected.providerSubscriptionId,
      amountCents: expected.amountCents,
      currency: 'USD',
      billingInterval: expected.billingInterval,
      ...period,
      paidAt: paidAtOf(invoice),
    },
  };
}
