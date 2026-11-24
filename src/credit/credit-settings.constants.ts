/**
 * Values used before an administrator has saved the credit settings. They
 * must match the column defaults in prisma/schema/credit.prisma.
 */
export const CREDIT_SETTINGS_DEFAULTS = {
  /** Credits granted once with the free trial. */
  trialAllowanceCredits: 50,
  /** Credits granted for each monthly Pro period. */
  proMonthlyAllowanceCredits: 1_000,
  /** $0.005 of OpenRouter cost per credit, in millionths of a US dollar. */
  openRouterUsdMicrosPerCredit: 5_000,
  /** Credits a session may use beyond the remaining balance. */
  sessionOverageAllowanceCredits: 5,
} as const;

/**
 * Request validation bounds. Zero is a valid allowance (no credits); the cost
 * per credit must be positive because credit conversion divides by it. Upper
 * bounds guard against unit mistakes (e.g. dollars vs micro-dollars).
 */
export const CREDIT_SETTINGS_LIMITS = {
  ALLOWANCE_CREDITS_MIN: 0,
  ALLOWANCE_CREDITS_MAX: 1_000_000,
  /** $0.000001 */
  USD_MICROS_PER_CREDIT_MIN: 1,
  /** $1.00 */
  USD_MICROS_PER_CREDIT_MAX: 1_000_000,
  SESSION_OVERAGE_CREDITS_MIN: 0,
  SESSION_OVERAGE_CREDITS_MAX: 10_000,
} as const;

/** Primary key of the single configuration row. */
export const CREDIT_SETTINGS_ID = 'default';

/** Audit-log table name for credit setting changes. */
export const CREDIT_SETTINGS_AUDIT_TABLE = 'CreditSettings';

export const USD_MICROS_PER_USD = 1_000_000;
