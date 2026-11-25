/** Step-up authentication for sensitive actions. */
export const STEP_UP = {
  /** An approval is valid for 10 minutes. */
  APPROVAL_TTL_MS: 10 * 60_000,
  /** A Google re-authentication must be completed within 10 minutes. */
  CHALLENGE_TTL_MS: 10 * 60_000,
  /** Request header carrying the approval token. */
  HEADER: 'x-step-up-token',
  /** Ended approvals and challenges are deleted after this. */
  RETENTION_MS: 24 * 60 * 60_000,
} as const;
