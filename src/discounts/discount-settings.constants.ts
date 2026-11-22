/** Primary key of the single DiscountSettings row (CHECK constraint). */
export const DISCOUNT_SETTINGS_ID = 1;

/**
 * Request validation bounds. Every setting accepts 0, which switches the
 * corresponding offer off (the default).
 */
export const DISCOUNT_SETTINGS_LIMITS = {
  PERCENT_MIN: 0,
  PERCENT_MAX: 100,
  REFERRER_REWARD_CREDITS_MIN: 0,
  /** Same ceiling as the trial allowance; guards against typing mistakes. */
  REFERRER_REWARD_CREDITS_MAX: 100_000,
} as const;
