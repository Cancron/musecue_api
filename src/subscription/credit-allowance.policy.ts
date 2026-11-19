import { CreditSource } from '@prisma/client';
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
 * - A paid Pro term comes with `proMonthlyCredits` for every month of the
 *   term (monthly and yearly billing alike), expiring at the end of that
 *   month or of the term, whichever is first. Months are counted from the
 *   term's start, on the same calendar day (clamped to the month's length,
 *   like Stripe's billing anchor: Jan 31 -> Feb 28 -> Mar 31).
 * - TRIAL credits are usable only while the trial is active (and Pro has
 *   not been bought) and
 *   SUBSCRIPTION credits only while the paid term is active, so a refund
 *   that ends the term early also ends its credits. PURCHASE and REFERRAL
 *   credits are usable with or without Pro.
 */

export interface AllowanceAmounts {
  trialCredits: number;
  proMonthlyCredits: number;
}

export interface DueAllowance {
  source: typeof CreditSource.TRIAL | typeof CreditSource.SUBSCRIPTION;
  /** Stable per trial / per month of a term, so a grant is made once. */
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

/** The month of the paid term that contains `now`, or null without one. */
export function currentProAllowancePeriod(
  record: SubscriptionRecord | null,
  now: Date,
): { start: Date; end: Date } | null {
  if (!record || !isProActive(record, now)) return null;
  const anchor = record.proStartedAt as Date;
  let months =
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - anchor.getUTCMonth());
  // The estimate can be one month off either way around the anchor day.
  while (months > 0 && addMonthsClamped(anchor, months) > now) months -= 1;
  while (addMonthsClamped(anchor, months + 1) <= now) months += 1;
  return {
    start: addMonthsClamped(anchor, months),
    end: addMonthsClamped(anchor, months + 1),
  };
}

/** The allowances the user should have received by `now`. */
export function dueAllowances(
  record: SubscriptionRecord | null,
  now: Date,
  amounts: AllowanceAmounts,
): DueAllowance[] {
  const due: DueAllowance[] = [];
  if (record && trialCreditsApply(record, now)) {
    due.push({
      source: CreditSource.TRIAL,
      sourceReference: trialAllowanceReference(record.trialStartedAt as Date),
      amount: amounts.trialCredits,
      expiresAt: record.trialExpiresAt as Date,
      description: 'Free trial credits',
    });
  }
  const period = currentProAllowancePeriod(record, now);
  if (record && period) {
    const termEnd = record.proExpiresAt as Date;
    due.push({
      source: CreditSource.SUBSCRIPTION,
      sourceReference: `pro:${(record.proStartedAt as Date).toISOString()}:${period.start.toISOString()}`,
      amount: amounts.proMonthlyCredits,
      expiresAt: period.end < termEnd ? period.end : termEnd,
      description: 'Monthly Pro credits',
    });
  }
  return due;
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
