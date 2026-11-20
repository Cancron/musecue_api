import { StepUpAction } from '@prisma/client';

/**
 * Step-up authentication: a fresh re-verification before a sensitive action.
 * An approval lasts ten minutes and authorizes one action for one user in
 * one sign-in session. Trusted devices never replace it.
 */
export const STEP_UP = {
  /** How long an approval (and a Google reauthentication) is valid. */
  TTL_MS: 10 * 60_000,
  /** Header carrying the approval token on a protected request. */
  HEADER: 'x-step-up-token',
  /** Approval tokens: prefix + 32 random bytes, base64url. */
  TOKEN_PATTERN: /^stup_[A-Za-z0-9_-]{43}$/,
  /** OAuthState.provider of Google reauthentication challenges. */
  GOOGLE_STATE_PROVIDER: 'google-step-up',
  /** Accepted clock skew for Google's auth_time. */
  GOOGLE_AUTH_TIME_SKEW_MS: 60_000,
} as const;

/** Route metadata key: the action a route requires a step-up for. */
export const STEP_UP_ACTION_KEY = 'musecue:step-up-action';

export const STEP_UP_ACTIONS = Object.values(StepUpAction);

/** How the current user re-verifies (decided by the account). */
export type StepUpRequirement = 'mfa' | 'password' | 'google';
