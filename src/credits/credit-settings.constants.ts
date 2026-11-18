/** Primary key of the single CreditSettings row (CHECK constraint). */
export const CREDIT_SETTINGS_ID = 1;

/** One US dollar in the millionths used by `creditCostUsdMicros`. */
export const USD_MICROS_PER_USD = 1_000_000;

/**
 * Values used before an administrator has saved the credit settings. They
 * must match the column defaults in prisma/schema/credit.prisma.
 */
export const CREDIT_SETTINGS_DEFAULTS = {
  trialCredits: 50,
  proMonthlyCredits: 1_000,
  /** $0.005 of OpenRouter cost per credit. */
  creditCostUsdMicros: 5_000,
  sessionOverageCredits: 5,
} as const;

/** Request validation bounds. */
export const CREDIT_SETTINGS_LIMITS = {
  /**
   * A trial always comes with credits; the trial itself is switched off with
   * the plan's `trialEnabled`, not with zero credits.
   */
  TRIAL_CREDITS_MIN: 1,
  TRIAL_CREDITS_MAX: 100_000,
  PRO_MONTHLY_CREDITS_MIN: 1,
  PRO_MONTHLY_CREDITS_MAX: 1_000_000,
  /** $0.000001: a zero cost would make cost-to-credit conversion impossible. */
  CREDIT_COST_USD_MICROS_MIN: 1,
  /** $1.00; an upper bound guards against unit mistakes (dollars vs micros). */
  CREDIT_COST_USD_MICROS_MAX: 1_000_000,
  /** Zero is valid: sessions may not go beyond the remaining balance. */
  SESSION_OVERAGE_CREDITS_MIN: 0,
  SESSION_OVERAGE_CREDITS_MAX: 1_000,
} as const;

/**
 * Formats millionths of a US dollar as an exact decimal string without
 * trailing zeros, e.g. 5000 -> "0.005". Integer arithmetic only, so no
 * floating-point rounding is involved.
 */
export function formatUsdMicros(micros: number): string {
  if (!Number.isSafeInteger(micros) || micros < 0) {
    throw new RangeError(`Invalid USD micros amount: ${micros}`);
  }
  const whole = Math.floor(micros / USD_MICROS_PER_USD);
  const fraction = String(micros % USD_MICROS_PER_USD)
    .padStart(6, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}
