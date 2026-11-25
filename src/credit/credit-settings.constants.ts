/**
 * The default settings are not defined in code: they are the column defaults
 * of "CreditSettings" (prisma/schema/credit.prisma), stored as the single
 * configuration row by migration 20261123120000_seed_credit_settings and
 * re-created with those column defaults at startup if the row is missing:
 * 50 trial credits, 1,000 Pro credits per month, 5,000 micro-dollars
 * ($0.005) per credit and 5 overage credits per session.
 */

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
