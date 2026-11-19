import { BillingInterval, CreditSource } from '@prisma/client';
import {
  isProActive,
  isTrialActive,
  type SubscriptionRecord,
} from './subscription-access.policy';

/**
 * Which allowances a subscription entitles a user to, and which credits are
 * usable, derived from the same date windows as Pro access
 * (subscription-access.policy). Pure functions; no database access.
 *
 * - The free trial comes with `trialCredits`, expiring with the trial. They
 *   are granted when the trial is activated (CreditAllowanceService); buying
 *   paid Pro ends them at once (a trial can only start without Pro history,
 *   so any paid term means the user upgraded).
 * - Monthly Pro credits (`proMonthlyCredits`) are granted for successful
 *   payments only (CreditAllowanceService.grantPaidPeriod): one allocation
 *   per allowance period of a payment, expiring at the end of that period.
 *   For monthly billing the period is the paid period itself, so credits
 *   expire at Stripe's billing boundary; a yearly payment covers twelve
 *   monthly periods.
 * - TRIAL credits are usable only while the trial is active (and Pro has not
 *   been bought) and SUBSCRIPTION credits only while the paid term is
 *   active, so a refund that ends the term early also ends its credits.
 *   PURCHASE and REFERRAL credits are usable with or without Pro.
 */

export interface DueAllowance {
  source: typeof CreditSource.TRIAL;
  /** Stable per trial, so the trial allowance is granted once. */
  sourceReference: string;
  amount: number;
  expiresAt: Date;
  description: string;
}

/** The reference of a trial's allowance: one per trial (and user). */
export const trialAllowanceReference = (trialStartedAt: Date): string =>
  `trial:${trialStartedAt.toISOString()}`;

/** The reference of a payment's allowance period: one per period. */
export const paidAllowanceReference = (
  paymentId: string,
  periodStart: Date,
): string => `payment:${paymentId}:${periodStart.toISOString()}`;

/** Whether trial credits apply: an active trial, and no paid Pro bought. */
function trialCreditsApply(
  record: SubscriptionRecord | null,
  now: Date,
): boolean {
  return (
    record !== null &&
    isTrialActive(record, now) &&
    record.proStartedAt === null
  );
}

/** `anchor` plus `months` calendar months, on the anchor's day (clamped). */
export function addMonthsClamped(anchor: Date, months: number): Date {
  const target = new Date(anchor.getTime());
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(anchor.getUTCDate(), lastDay));
  return target;
}

/** A successful payment's billing facts. */
export interface PaidPeriodSource {
  periodStart: Date;
  periodEnd: Date;
  billingInterval: BillingInterval;
}

/**
 * The allowance period of `payment` at `at`, or null once its paid period is
 * over. Monthly billing: the paid period itself (Stripe's billing period,
 * including anchored ones such as Feb 28 -> Mar 31). Yearly billing: the
 * month of the paid year containing `at`, counted from the payment's start on
 * the same day (clamped), the last one ending with the paid period. A
 * payment confirmed before its period starts gets its first period.
 */
export function paidAllowancePeriod(
  payment: PaidPeriodSource,
  at: Date,
): { start: Date; end: Date } | null {
  const start = payment.periodStart;
  const end = payment.periodEnd;
  const t = Math.max(at.getTime(), start.getTime());
  if (t >= end.getTime()) return null;
  if (payment.billingInterval === BillingInterval.MONTHLY) {
    return { start, end };
  }
  const moment = new Date(t);
  let months =
    (moment.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (moment.getUTCMonth() - start.getUTCMonth());
  // The estimate can be one month off either way around the anchor day.
  while (months > 0 && addMonthsClamped(start, months) > moment) months -= 1;
  while (addMonthsClamped(start, months + 1) <= moment) months += 1;
  const monthEnd = addMonthsClamped(start, months + 1);
  return {
    start: addMonthsClamped(start, months),
    end: monthEnd < end ? monthEnd : end,
  };
}

/** The trial allowance the user should have received by `now`, if any. */
export function dueTrialAllowance(
  record: SubscriptionRecord | null,
  now: Date,
  trialCredits: number,
): DueAllowance | null {
  if (!record || !trialCreditsApply(record, now)) return null;
  return {
    source: CreditSource.TRIAL,
    sourceReference: trialAllowanceReference(record.trialStartedAt as Date),
    amount: trialCredits,
    expiresAt: record.trialExpiresAt as Date,
    description: 'Free trial credits',
  };
}

/** Whether credits from `source` may be used at `now`. */
export function isCreditSourceUsable(
  source: CreditSource,
  record: SubscriptionRecord | null,
  now: Date,
): boolean {
  switch (source) {
    case CreditSource.PURCHASE:
    case CreditSource.REFERRAL:
      return true;
    case CreditSource.TRIAL:
      return trialCreditsApply(record, now);
    case CreditSource.SUBSCRIPTION:
      return isProActive(record, now);
    default:
      return false;
  }
}
