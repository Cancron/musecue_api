/**
 * Optional SMS sign-in verification, an extra method of users who enabled
 * MFA with an authenticator app. Values shared by the rules, the services
 * and tests.
 */
export const MFA_SMS = {
  /** Six random digits per code. */
  CODE_DIGITS: 6,
  /** A code is valid for 5 minutes (and at most while its challenge is). */
  CODE_TTL_MS: 5 * 60_000,
  /** At most 3 SMS codes are sent to a user within any 15 minutes. */
  MAX_DELIVERIES: 3,
  /** At most 5 SMS codes are checked for a user within any 15 minutes. */
  MAX_ATTEMPTS: 5,
  /** The sliding window of both limits. */
  WINDOW_MS: 15 * 60_000,
  /** E.164: `+`, a country code that does not start with 0, 8-15 digits. */
  E164_PATTERN: /^\+[1-9]\d{7,14}$/,
  /** What a client may send: digits with spaces, dots, dashes, parentheses. */
  INPUT_PATTERN: /^\+[\d\s().-]{8,30}$/,
} as const;
