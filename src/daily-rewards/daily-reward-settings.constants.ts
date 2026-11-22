/** Primary key of the single DailyRewardSettings row (CHECK constraint). */
export const DAILY_REWARD_SETTINGS_ID = 1;

/**
 * The most daily reward credits one user can receive per UTC calendar
 * month. A fixed product rule, not an administrator setting; the database
 * also refuses a maximum daily reward above it.
 */
export const DAILY_REWARD_MONTHLY_CAP_CREDITS = 600;

/** Request validation bounds (whole credits). */
export const DAILY_REWARD_SETTINGS_LIMITS = {
  /** A daily reward always grants credits. */
  STARTING_REWARD_CREDITS_MIN: 1,
  STARTING_REWARD_CREDITS_MAX: DAILY_REWARD_MONTHLY_CAP_CREDITS,
  /** 0 = the same reward every day. */
  DAILY_INCREMENT_CREDITS_MIN: 0,
  DAILY_INCREMENT_CREDITS_MAX: DAILY_REWARD_MONTHLY_CAP_CREDITS,
  MAX_DAILY_REWARD_CREDITS_MIN: 1,
  /** One day's reward can never exceed what a whole month may grant. */
  MAX_DAILY_REWARD_CREDITS_MAX: DAILY_REWARD_MONTHLY_CAP_CREDITS,
} as const;
