/**
 * Values used before an administrator has saved the plan. They must match the
 * column defaults in prisma/schema/subscription.prisma.
 */
export const SUBSCRIPTION_PLAN_DEFAULTS = {
  planEnabled: true,
  /** $19.00 */
  monthlyPriceUsdCents: 1_900,
  /** $190.00 */
  yearlyPriceUsdCents: 19_000,
  trialEnabled: true,
  trialDays: 7,
} as const;

/** Request validation bounds. */
export const SUBSCRIPTION_PLAN_LIMITS = {
  /** $0.01 */
  PRICE_USD_CENTS_MIN: 1,
  /** $9,999.99; an upper bound guards against unit mistakes (dollars vs cents). */
  PRICE_USD_CENTS_MAX: 999_999,
  /** A trial is switched off with `trialEnabled`, not a zero length. */
  TRIAL_DAYS_MIN: 1,
  TRIAL_DAYS_MAX: 365,
} as const;

export const SUBSCRIPTION_PLAN_CURRENCY = 'USD';
