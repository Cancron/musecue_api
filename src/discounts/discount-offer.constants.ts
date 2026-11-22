/** Request validation bounds of discount codes and campaigns. */
export const DISCOUNT_OFFER_LIMITS = {
  /** 3-32 characters: letters, digits, "_" and "-", starting with a letter or digit. */
  CODE_PATTERN: /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/,
  NAME_MAX_LENGTH: 100,
  PERCENT_MIN: 0,
  PERCENT_MAX: 100,
  MAX_REDEMPTIONS_PER_USER_MIN: 1,
  MAX_REDEMPTIONS_PER_USER_MAX: 1_000,
  MAX_TOTAL_REDEMPTIONS_MIN: 1,
  MAX_TOTAL_REDEMPTIONS_MAX: 10_000_000,
  TARGET_USERS_MAX: 1_000,
  USER_ID_MAX_LENGTH: 64,
  /** Longest code a user may submit (longer input is rejected with 400). */
  REDEEM_CODE_MAX_LENGTH: 64,
  IDEMPOTENCY_KEY_MAX_LENGTH: 200,
} as const;

/**
 * ISO 8601 date (UTC midnight) or date-time with an explicit time zone
 * (`Z` or an offset). A date-time without a zone would depend on the server's
 * time zone and is rejected.
 */
export const ZONED_ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

/** Response messages of rejected redemptions (stable; clients may match them). */
export const DISCOUNT_MESSAGES = {
  CODE_NOT_FOUND: 'Discount code not found',
  CAMPAIGN_NOT_FOUND: 'Discount campaign not found',
  INACTIVE: 'This discount is not active',
  NOT_STARTED: 'This discount has not started yet',
  EXPIRED: 'This discount has expired',
  NOT_ELIGIBLE: 'This discount is not available for your account',
  USER_LIMIT_REACHED:
    'You have already redeemed this discount the maximum number of times',
  DEPLETED: 'This discount has no redemptions left',
  PACKAGE_UNAVAILABLE: 'This credit package is not available',
  IDEMPOTENCY_KEY_REUSED:
    'The idempotency key was already used for another redemption',
  IDEMPOTENCY_KEY_REQUIRED:
    'An Idempotency-Key header of 1-200 characters is required',
  CODE_TAKEN: 'A discount code with this code already exists',
} as const;
