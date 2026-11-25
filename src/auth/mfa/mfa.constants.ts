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

/** Verifying MFA (authenticator or recovery code) of an enabled account. */
export const MFA_VERIFICATION = {
  /** Incorrect codes allowed within FAILURE_WINDOW_MS ... */
  MAX_FAILED_ATTEMPTS: 5,
  FAILURE_WINDOW_MS: 15 * 60_000,
  /** ... before verification is blocked for this long. */
  BLOCK_MS: 15 * 60_000,
} as const;

export const MFA_RECOVERY_CODES = {
  /** Codes issued per set (on enabling MFA and on every regeneration). */
  COUNT: 10,
  /** Characters per code: 12 x 5 bits = 60 bits of entropy each. */
  LENGTH: 12,
  /** Displayed in groups (XXXX-XXXX-XXXX); hyphens are optional when typed. */
  GROUP_SIZE: 4,
  /** Replaced (invalidated) codes are deleted after this long. */
  INVALIDATED_RETENTION_MS: 30 * 24 * 60 * 60_000,
} as const;

/** MFA as the second step of sign-in (password or Google). */
export const MFA_LOGIN = {
  /** A sign-in challenge must be completed within 5 minutes. */
  CHALLENGE_TTL_MS: 5 * 60_000,
  /** A device trusted after MFA skips the challenge for 30 days. */
  TRUSTED_DEVICE_TTL_MS: 30 * 24 * 60 * 60_000,
  /** Request header carrying a trusted device's token at sign-in. */
  TRUSTED_DEVICE_HEADER: 'x-trusted-device-token',
  /** Used/expired challenges and ended devices are deleted after this. */
  RETENTION_MS: 30 * 24 * 60 * 60_000,
} as const;

/**
 * Required root key (>= 32 characters) of authenticator-secret encryption and
 * recovery-code hashing; independent of the JWT secrets.
 */
export const MFA_ENCRYPTION_KEY_ENV = 'MFA_ENCRYPTION_KEY';
export const MFA_ENCRYPTION_KEY_MIN_LENGTH = 32;
