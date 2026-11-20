/**
 * Optional multi-factor authentication with an authenticator app (TOTP,
 * RFC 6238) and single-use recovery codes. Values shared by the rules, the
 * services and tests.
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

/**
 * Lockout after incorrect codes, applied separately to enrollment
 * confirmation and to MFA verification: five incorrect codes within any 15
 * minutes block for 15 minutes.
 */
export const MFA_LOCKOUT = {
  MAX_FAILED_ATTEMPTS: 5,
  FAILURE_WINDOW_MS: 15 * 60_000,
  BLOCK_DURATION_MS: 15 * 60_000,
} as const;

export const MFA_ENROLLMENT = {
  /** A started enrollment can be confirmed for 10 minutes. */
  TTL_MS: 10 * 60_000,
  ...MFA_LOCKOUT,
} as const;

export const MFA_RECOVERY_CODES = {
  /** Codes issued when MFA is enabled and on every regeneration. */
  COUNT: 10,
  /**
   * Characters of a code: no 0/O, 1/I/L, so codes are easy to copy by hand.
   * 10 characters from 31 give about 49.5 bits of entropy per code.
   */
  ALPHABET: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  LENGTH: 10,
  /** Shown as two groups of five: `ABCDE-FGHJK`. */
  GROUP_LENGTH: 5,
} as const;

/** Activity-log field names of MFA changes (never codes or secrets). */
export const MFA_AUDIT_FIELDS = {
  ENABLED: 'mfaEnabled',
  METHOD: 'mfaMethod',
  RECOVERY_CODES_REMAINING: 'mfaRecoveryCodesRemaining',
  /** The authenticator was replaced (values: null -> 'replaced'). */
  AUTHENTICATOR: 'mfaAuthenticator',
  /** Trusted devices revoked by the change (a count). */
  TRUSTED_DEVICES_REVOKED: 'mfaTrustedDevicesRevoked',
  /** How the change was approved (TOTP, RECOVERY_CODE, PASSWORD, GOOGLE). */
  STEP_UP_METHOD: 'stepUpMethod',
} as const;

/** MFA at sign-in. */
export const MFA_LOGIN = {
  /** A login challenge must be completed within 5 minutes. */
  CHALLENGE_TTL_MS: 5 * 60_000,
  /** A trusted device skips the challenge for 30 days (never extended). */
  TRUSTED_DEVICE_TTL_MS: 30 * 24 * 60 * 60_000,
  /** Active trusted devices per user; the oldest beyond it are revoked. */
  MAX_TRUSTED_DEVICES: 10,
  /** Header carrying a trusted-device token on sign-in requests. */
  TRUSTED_DEVICE_HEADER: 'x-mfa-trusted-device',
  /** Opaque token formats (prefix + 32 random bytes, base64url). */
  CHALLENGE_TOKEN_PATTERN: /^mfac_[A-Za-z0-9_-]{43}$/,
  TRUSTED_DEVICE_TOKEN_PATTERN: /^mfatd_[A-Za-z0-9_-]{43}$/,
} as const;
