/** Email confirmation codes (accounts without a password) expire after 10 minutes. */
export const ACCOUNT_DELETION_CODE_TTL_SECONDS = 10 * 60;
/** Wrong guesses allowed per code before it is invalidated. */
export const ACCOUNT_DELETION_CODE_MAX_ATTEMPTS = 5;

/** Confirmation codes a user can request per window. */
export const ACCOUNT_DELETION_CODE_RATE_LIMIT = {
  max: 3,
  windowMs: 15 * 60 * 1000,
} as const;

/** Deletion confirmations (password or code) a user can submit per window. */
export const ACCOUNT_DELETION_CONFIRM_RATE_LIMIT = {
  max: 5,
  windowMs: 15 * 60 * 1000,
} as const;

/** Client-facing result of a wrong password or code. */
export const IDENTITY_VERIFICATION_FAILED = 'Identity verification failed';
