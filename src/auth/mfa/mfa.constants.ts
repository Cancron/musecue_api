/**
 * Optional multi-factor authentication with an authenticator app (TOTP,
 * RFC 6238). Values shared by the enrollment rules, the service and tests.
 */
export const MFA_TOTP = {
  /** Issuer shown by authenticator apps. */
  ISSUER: 'MuseCue',
  /** Algorithm of the HMAC, as named in otpauth:// URIs. */
  ALGORITHM: 'SHA1',
  DIGITS: 6,
  /** A code belongs to one 30-second time step and is accepted only then. */
  PERIOD_SECONDS: 30,
  /** 160-bit secrets, as recommended by RFC 4226. */
  SECRET_BYTES: 20,
} as const;

export const MFA_ENROLLMENT = {
  /** A started enrollment can be confirmed for 10 minutes. */
  TTL_MS: 10 * 60_000,
  /** Incorrect confirmation codes allowed within FAILURE_WINDOW_MS... */
  MAX_FAILED_ATTEMPTS: 5,
  FAILURE_WINDOW_MS: 15 * 60_000,
  /** ...before enrollment (start and confirm) is blocked for this long. */
  BLOCK_DURATION_MS: 15 * 60_000,
} as const;

/** Activity-log field names of an MFA change. */
export const MFA_AUDIT_FIELDS = {
  ENABLED: 'mfaEnabled',
  METHOD: 'mfaMethod',
} as const;
