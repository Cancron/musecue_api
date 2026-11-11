import { BillingInterval, PaymentStatus } from '@prisma/client';
import type { SubscriptionPlanSettings } from './interfaces/subscription-plan.interface';
import { SUBSCRIPTION_PLAN_CURRENCY } from './subscription-plan.constants';

/**
 * Billing rules for the single Pro plan, shared by future checkout and webhook
 * code. They mirror the database rules in migrations
 * 20260918120000_add_payments_and_subscription_events and
 * 20260920120000_calendar_billing_periods_and_gap_free_terms, which enforce
 * the same rules for every writer.
 */

/**
 * End of one billing period starting at `start`: one calendar month or year
 * later in UTC, clamped to the last day of a shorter month (Jan 31 -> Feb 28,
 * Feb 29 -> Feb 28 next year). Same result as PostgreSQL `+ interval`.
 */
export function addBillingInterval(
  start: Date,
  interval: BillingInterval,
): Date {
  const months = interval === BillingInterval.MONTHLY ? 1 : 12;
  const target = new Date(start.getTime());
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  return target;
}

/**
 * Whether [start, end) is exactly one billing period: `end` must be the
 * calendar expiry computed by addBillingInterval (same as the database CHECK).
 */
export function isValidBillingPeriod(
  start: Date,
  end: Date,
  interval: BillingInterval,
): boolean {
  return end.getTime() === addBillingInterval(start, interval).getTime();
}

/** The plan's current price for an interval, in US cents. */
export function planPriceCents(
  plan: Pick<
    SubscriptionPlanSettings,
    'monthlyPriceUsdCents' | 'yearlyPriceUsdCents'
  >,
  interval: BillingInterval,
): number {
  return interval === BillingInterval.MONTHLY
    ? plan.monthlyPriceUsdCents
    : plan.yearlyPriceUsdCents;
}

export interface NewPaymentInput {
  provider: string;
  providerPaymentId: string;
  amountCents: number;
  currency: string;
  billingInterval: BillingInterval;
  periodStart: Date;
  periodEnd: Date;
}

export type PaymentValidationError =
  | 'MISSING_PROVIDER_ID'
  | 'CURRENCY_NOT_SUPPORTED'
  | 'AMOUNT_DOES_NOT_MATCH_PRICE'
  | 'INVALID_BILLING_PERIOD';

/**
 * Validates a payment about to be recorded against the plan's current
 * pricing. Returns every problem found; an empty list means valid.
 */
export function validateNewPayment(
  input: NewPaymentInput,
  plan: Pick<
    SubscriptionPlanSettings,
    'monthlyPriceUsdCents' | 'yearlyPriceUsdCents'
  >,
): PaymentValidationError[] {
  const errors: PaymentValidationError[] = [];
  if (!input.provider.trim() || !input.providerPaymentId.trim()) {
    errors.push('MISSING_PROVIDER_ID');
  }
  if (input.currency !== SUBSCRIPTION_PLAN_CURRENCY) {
    errors.push('CURRENCY_NOT_SUPPORTED');
  }
  if (input.amountCents !== planPriceCents(plan, input.billingInterval)) {
    errors.push('AMOUNT_DOES_NOT_MATCH_PRICE');
  }
  if (
    !isValidBillingPeriod(
      input.periodStart,
      input.periodEnd,
      input.billingInterval,
    )
  ) {
    errors.push('INVALID_BILLING_PERIOD');
  }
  return errors;
}

const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  PENDING: [PaymentStatus.SUCCEEDED, PaymentStatus.FAILED],
  SUCCEEDED: [PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED],
  PARTIALLY_REFUNDED: [PaymentStatus.REFUNDED],
  FAILED: [],
  REFUNDED: [],
};

/** Forward-only payment status changes (same status is always allowed). */
export function canTransitionPayment(
  from: PaymentStatus,
  to: PaymentStatus,
): boolean {
  return from === to || PAYMENT_TRANSITIONS[from].includes(to);
}

export type PaidTermRejection =
  | 'PAYMENT_BELONGS_TO_ANOTHER_SUBSCRIPTION'
  | 'PAYMENT_NOT_VERIFIED'
  | 'INTERVAL_MISMATCH'
  | 'TERM_DOES_NOT_END_WITH_PAID_PERIOD'
  | 'TERM_STARTS_BEFORE_PAID_PERIOD'
  | 'UNPAID_GAP';

export interface PaidTermPayment {
  subscriptionId: string;
  status: PaymentStatus;
  billingInterval: BillingInterval;
  periodStart: Date;
  periodEnd: Date;
}

export interface PaidTerm {
  proStartedAt: Date | null;
  proExpiresAt: Date | null;
}

export interface NextPaidTerm {
  billingInterval: BillingInterval;
  proStartedAt: Date;
  proExpiresAt: Date;
}

/**
 * Whether `payment` may move the subscription's paid term from `current` to
 * `next`. A payment grants access only for the period it covers:
 *
 * - it must be a SUCCEEDED payment of this subscription with the term's
 *   billing interval, and the term must end exactly at its period end;
 * - a new term (first purchase, repurchase after a lapse, or an earlier
 *   start) may not start before the paid period;
 * - a renewal extends the same term from its current expiry, so the payment's
 *   period must start no later than that expiry (no unpaid gap).
 *
 * Changes that grant nothing new (cancelling, shortening) need no payment.
 * Mirrors the database trigger
 * "UserSubscription_paid_term_requires_verified_payment".
 */
export function getPaidTermRejection(
  payment: PaidTermPayment,
  subscriptionId: string,
  current: PaidTerm,
  next: NextPaidTerm,
): PaidTermRejection | null {
  // A renewal keeps the current term's start and extends it from its expiry;
  // anything else is a new term that starts at next.proStartedAt.
  const renewalFrom =
    current.proStartedAt !== null &&
    current.proExpiresAt !== null &&
    next.proStartedAt.getTime() >= current.proStartedAt.getTime() &&
    next.proStartedAt.getTime() < current.proExpiresAt.getTime()
      ? current.proExpiresAt
      : null;
  if (
    renewalFrom !== null &&
    next.proExpiresAt.getTime() <= renewalFrom.getTime()
  ) {
    return null;
  }

  if (payment.subscriptionId !== subscriptionId) {
    return 'PAYMENT_BELONGS_TO_ANOTHER_SUBSCRIPTION';
  }
  if (payment.status !== PaymentStatus.SUCCEEDED) {
    return 'PAYMENT_NOT_VERIFIED';
  }
  if (payment.billingInterval !== next.billingInterval) {
    return 'INTERVAL_MISMATCH';
  }
  if (payment.periodEnd.getTime() !== next.proExpiresAt.getTime()) {
    return 'TERM_DOES_NOT_END_WITH_PAID_PERIOD';
  }
  const grantFrom = renewalFrom ?? next.proStartedAt;
  if (payment.periodStart.getTime() > grantFrom.getTime()) {
    return renewalFrom ? 'UNPAID_GAP' : 'TERM_STARTS_BEFORE_PAID_PERIOD';
  }
  return null;
}
