import { BillingInterval, CreditSource } from '@prisma/client';
import {
  isProActive,
  isTrialActive,
  type SubscriptionRecord,
} from './subscription-access.policy';

/**
 * Which credits a subscription entitles a user to, and which credits are
 * usable, derived from the same date windows as Pro access
 * (subscription-access.policy). Pure functions; no database access.
 *
 * - The free trial comes with `trialCredits`, expiring with the trial. They
 *   are granted when the trial is activated (CreditAllowanceService); buying
 *   paid Pro ends them at once (a trial can only start without Pro history,
 *   so any paid term means the user upgraded).
 * - Every successful payment that creates or renews the paid term comes with
 *   `proMonthlyCredits` for each month it pays for: one month for a monthly
 *   payment (its whole billing period), twelve for a yearly one, allocated
 *   one month at a time as each begins. Each month's credits count from its
 *   start and expire at its end, the billing boundary
 *   (paymentAllowancePeriods).
 * - TRIAL credits are usable only while the trial is active (and Pro has
 *   not been bought) and SUBSCRIPTION credits only while the paid term is
 *   active, so a refund that ends the term early also ends its credits.
 *   PURCHASE, REFERRAL, DAILY_REWARD and MISSION_REWARD credits are usable
 *   with or without Pro.
 */

export interface AllowanceAmounts {
  trialCredits: number;
}

export interface DueAllowance {
  source: typeof CreditSource.TRIAL;
  /** Stable per trial, so a grant is made once. */
  sourceReference: string;
  amount: number;
  expiresAt: Date;
  description: string;
}

/** The reference of a trial's allowance: one per trial (and user). */
export const trialAllowanceReference = (trialStartedAt: Date): string =>
  `trial:${trialStartedAt.toISOString()}`;

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

/** A payment as far as Pro credits are concerned. */
export interface PaidPeriod {
  billingInterval: BillingInterval;
  periodStart: Date;
  periodEnd: Date;
}

/** One month of Pro credits paid for by a payment: [start, end). */
export interface AllowancePeriod {
  start: Date;
  end: Date;
}

/**
 * The months a payment pays Pro credits for. A monthly payment is one month:
 * exactly its billing period as Stripe reports it (anchored periods such as
 * Feb 28 -> Mar 31 included). A yearly payment is split into months counted
 * from its start on the same day (clamped: Jan 31 -> Feb 28 -> Mar 31), the
 * last one ending with the payment's period.
 */
export function paymentAllowancePeriods(
  payment: PaidPeriod,
): AllowancePeriod[] {
  const { periodStart, periodEnd } = payment;
  if (periodEnd.getTime() <= periodStart.getTime()) return [];
  if (payment.billingInterval === BillingInterval.MONTHLY) {
    return [{ start: periodStart, end: periodEnd }];
  }
  const periods: AllowancePeriod[] = [];
  for (let month = 0; ; month += 1) {
    const start = addMonthsClamped(periodStart, month);
    if (start.getTime() >= periodEnd.getTime()) break;
    const next = addMonthsClamped(periodStart, month + 1);
    periods.push({
      start,
      end: next.getTime() < periodEnd.getTime() ? next : periodEnd,
    });
  }
  return periods;
}

/**
 * When a scheduled month's credits are allocated (grant time): now, unless
 * the month already ended while nothing allocated it (the worker was not
 * running); then as of its start, so the history shows the month granted
 * at its start and expiring at its end.
 */
export function scheduledAllocationTime(
  period: AllowancePeriod,
  now: Date,
): Date {
  return period.end.getTime() <= now.getTime() ? period.start : now;
}

/** The reference of one month of Pro credits: one per payment and month. */
export const paymentAllowanceReference = (
  paymentId: string,
  periodStart: Date,
): string => `payment:${paymentId}:${periodStart.toISOString()}`;

/** The trial allowance the user should have received by `now`, if any. */
export function dueAllowances(
  record: SubscriptionRecord | null,
  now: Date,
  amounts: AllowanceAmounts,
): DueAllowance[] {
  if (!record || !trialCreditsApply(record, now)) return [];
  return [
    {
      source: CreditSource.TRIAL,
      sourceReference: trialAllowanceReference(record.trialStartedAt as Date),
      amount: amounts.trialCredits,
      expiresAt: record.trialExpiresAt as Date,
      description: 'Free trial credits',
    },
  ];
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
    case CreditSource.DAILY_REWARD:
    case CreditSource.MISSION_REWARD:
      return true;
    case CreditSource.TRIAL:
      return trialCreditsApply(record, now);
    case CreditSource.SUBSCRIPTION:
      return isProActive(record, now);
    default:
      return false;
  }
}
