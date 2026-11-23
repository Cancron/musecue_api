import type { CreditPackageOrder } from '@prisma/client';
import type Stripe from 'stripe';
import {
  PACKAGE_CHECKOUT_METADATA,
  paymentMethodFingerprint,
} from '../../subscription/stripe/stripe.gateway';

/**
 * Pure rules of credit package purchases (no database or Stripe access).
 */

/** The credit reference of an order's PURCHASE credits. */
export const packageOrderCreditReference = (orderId: string) =>
  `credit-package:${orderId}`;

export const CREDIT_PACKAGE_ORDER_MESSAGES = {
  IDEMPOTENCY_KEY_REQUIRED:
    'An Idempotency-Key header (1-200 characters) is required',
  IDEMPOTENCY_KEY_REUSED:
    'This Idempotency-Key was already used for another purchase',
  PACKAGE_UNAVAILABLE: 'This credit package is not available',
  ACCOUNT_INACTIVE: 'Only active, verified accounts can buy credit packages',
  NOT_FOUND: 'Credit package order not found',
  NOT_CANCELABLE: 'This order can no longer be canceled',
  PAYMENT_IN_PROGRESS:
    'This order was already paid or its payment is being processed',
  BUSY: 'Your purchase is being updated by another request; please try again',
  GIFT_NOT_PAYABLE:
    'This gift cannot be paid: it must be yours, accepted and not expired',
  PROVIDER_REJECTED:
    'The payment provider refused to open the checkout; please try again later',
} as const;

/** What Stripe says about a credit package order's checkout. */
export type PackagePaymentVerification =
  | {
      outcome: 'PAID';
      providerSessionId: string;
      paymentIntentId: string;
      amountCents: number;
      /** Stripe's card / bank fingerprint (hash it at once; never stored). */
      paymentMethodFingerprint: string | null;
    }
  /** Completed with a delayed payment method that has not settled. */
  | { outcome: 'AWAITING_PAYMENT'; providerSessionId: string }
  /** Still open, or expired unpaid: nothing was paid. */
  | { outcome: 'NOT_PAID' }
  /** Does not match the order: never grants anything. */
  | { outcome: 'REJECTED'; reason: string };

const idOf = (value: string | { id: string } | null | undefined) =>
  typeof value === 'string' ? value : (value?.id ?? null);

/**
 * Verifies a checkout session read from the Stripe API (with its
 * PaymentIntent and payment method expanded) against the order: the
 * one-time payment of exactly the order's amount in USD, by the order's
 * customer, for this order, collected (PaymentIntent `succeeded`).
 */
export function verifyPackageCheckout(
  session: Stripe.Checkout.Session,
  order: Pick<
    CreditPackageOrder,
    'id' | 'amountUsdCents' | 'providerCustomerId' | 'providerSessionId'
  >,
): PackagePaymentVerification {
  const reject = (reason: string): PackagePaymentVerification => ({
    outcome: 'REJECTED',
    reason,
  });
  if (session.mode !== 'payment') return reject('NOT_A_PAYMENT_CHECKOUT');
  if (session.metadata?.[PACKAGE_CHECKOUT_METADATA.ORDER_ID] !== order.id) {
    return reject('ORDER_MISMATCH');
  }
  if (order.providerSessionId && session.id !== order.providerSessionId) {
    return reject('SESSION_MISMATCH');
  }
  if (idOf(session.customer) !== order.providerCustomerId) {
    return reject('CUSTOMER_MISMATCH');
  }
  if ((session.currency ?? '').toLowerCase() !== 'usd') {
    return reject('CURRENCY_MISMATCH');
  }
  if (session.amount_total !== order.amountUsdCents) {
    return reject('AMOUNT_MISMATCH');
  }
  if (session.status === 'open' || session.status === 'expired') {
    return { outcome: 'NOT_PAID' };
  }
  if (session.status !== 'complete') return reject('UNEXPECTED_STATUS');
  if (session.payment_status === 'unpaid') {
    return { outcome: 'AWAITING_PAYMENT', providerSessionId: session.id };
  }
  if (session.payment_status !== 'paid') return reject('NOT_PAID');

  const intent = session.payment_intent;
  if (!intent || typeof intent === 'string') {
    return reject('PAYMENT_INTENT_MISSING');
  }
  if (intent.status === 'processing') {
    return { outcome: 'AWAITING_PAYMENT', providerSessionId: session.id };
  }
  if (intent.status !== 'succeeded') return reject('PAYMENT_NOT_SUCCEEDED');
  if (
    intent.amount_received !== order.amountUsdCents ||
    intent.currency.toLowerCase() !== 'usd'
  ) {
    return reject('PAYMENT_AMOUNT_MISMATCH');
  }
  const intentOrder = intent.metadata?.[PACKAGE_CHECKOUT_METADATA.ORDER_ID];
  if (intentOrder !== undefined && intentOrder !== order.id) {
    return reject('PAYMENT_ORDER_MISMATCH');
  }
  return {
    outcome: 'PAID',
    providerSessionId: session.id,
    paymentIntentId: intent.id,
    amountCents: intent.amount_received,
    paymentMethodFingerprint: paymentMethodFingerprint(intent.payment_method),
  };
}
