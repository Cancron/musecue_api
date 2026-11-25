import { BillingInterval } from '@prisma/client';

/**
 * Pro credits are granted per month of a paid period: one month for a
 * monthly payment, twelve months for a yearly payment (never the whole
 * year's credits at once). Pure date rules; the database trigger
 * "CreditAllocation_check_subscription_payment" applies the same ones.
 */

/** Months of credits a paid period is split into. */
export const CREDIT_MONTHS_PER_PERIOD: Record<BillingInterval, number> = {
  MONTHLY: 1,
  YEARLY: 12,
};

/**
 * `anchor` plus `months` calendar months, keeping the anchor's day of month
 * and time where possible and clamping to the last day otherwise (Jan 31 + 1
 * month = Feb 28/29, Jan 31 + 2 months = Mar 31). Always computed from the
 * anchor, so month ends do not drift. Same result as PostgreSQL's
 * `timestamp + interval '<months> months'` on UTC timestamps.
 */
export function addMonthsClamped(anchor: Date, months: number): Date {
  const total = anchor.getUTCMonth() + months;
  const year = anchor.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

export interface PaidPeriod {
  billingInterval: BillingInterval;
  periodStart: Date;
  periodEnd: Date;
}

/** One month of credits within a paid period: [start, end). */
export interface CreditMonth {
  /** 0 for a monthly payment; 0..11 for a yearly payment. */
  index: number;
  start: Date;
  /** The month's billing boundary: its credits expire here. */
  end: Date;
}

/**
 * The credit months of a paid period. Month k starts at periodStart + k
 * months; the last month ends exactly at periodEnd.
 */
export function creditMonths(period: PaidPeriod): CreditMonth[] {
  const count = CREDIT_MONTHS_PER_PERIOD[period.billingInterval];
  const months: CreditMonth[] = [];
  for (let index = 0; index < count; index += 1) {
    const start =
      index === 0
        ? period.periodStart
        : addMonthsClamped(period.periodStart, index);
    const end =
      index === count - 1
        ? period.periodEnd
        : addMonthsClamped(period.periodStart, index + 1);
    if (start.getTime() < end.getTime()) months.push({ index, start, end });
  }
  return months;
}

/**
 * The month whose credits are due at `now`: the first month that has not
 * ended yet (month 0 if the period has not started, e.g. a renewal paid
 * just before the boundary). Null once the paid period has ended.
 */
export function creditMonthAt(
  period: PaidPeriod,
  now: Date,
): CreditMonth | null {
  return (
    creditMonths(period).find((month) => month.end.getTime() > now.getTime()) ??
    null
  );
}
