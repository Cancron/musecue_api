/**
 * Optional multi-factor authentication with an authenticator app (TOTP,
 * RFC 6238).
 */
export const MFA_TOTP = {
  /** Shown as the account's issuer in authenticator apps. */
  ISSUER: 'MuseCue',
  /** HMAC algorithm of the codes (SHA1 is what authenticator apps support). */
  ALGORITHM: 'SHA1',
  DIGITS: 6,
  /** A code is valid for one 30-second time step. */
  PERIOD_SECONDS: 30,
  /**
   * Neighbouring time steps also accepted (clock drift). 0: only the current
   * step, so a code is accepted at most 30 seconds and never after its step.
   */
  ALLOWED_DRIFT_STEPS: 0,
  /** 160-bit secrets, as recommended by RFC 4226. */
  SECRET_BYTES: 20,
} as const;

export const MFA_ENROLLMENT = {
  /** A started enrollment can be confirmed for 10 minutes. */
  TTL_MS: 10 * 60_000,
  /** Incorrect codes allowed within FAILURE_WINDOW_MS ... */
  MAX_FAILED_ATTEMPTS: 5,
  FAILURE_WINDOW_MS: 15 * 60_000,
  /** ... before enrollment is blocked for this long. */
  BLOCK_MS: 15 * 60_000,
} as const;

/** Optional dedicated root key for authenticator secrets (>= 32 characters). */
export const MFA_ENCRYPTION_KEY_ENV = 'MFA_ENCRYPTION_KEY';
export const MFA_ENCRYPTION_KEY_MIN_LENGTH = 32;
