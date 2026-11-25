import { MFA_ENROLLMENT } from './mfa.constants';
import type { MfaEnrollmentState } from './mfa-enrollment.repository';

/**
 * MFA rules as pure functions of the stored state and the time:
 * - a started enrollment is pending for 10 minutes (expired at `expiresAt`);
 * - incorrect codes are counted in a 15-minute window that starts with the
 *   first failure; the 5th failure within it blocks for 15 minutes. For
 *   enrollment the block also discards the pending secret, and restarting an
 *   enrollment keeps the counters. MFA verification (authenticator or
 *   recovery code) has its own counter with the same limits.
 */

export type MfaEnrollmentStatus = 'NONE' | 'PENDING' | 'EXPIRED' | 'BLOCKED';

/** A failed-code counter with a fixed window and a block. */
export interface FailureCounter {
  failedAttempts: number;
  failureWindowStartedAt: Date | null;
  blockedUntil: Date | null;
}

export interface FailureLimits {
  MAX_FAILED_ATTEMPTS: number;
  FAILURE_WINDOW_MS: number;
  BLOCK_MS: number;
}

export const NO_FAILURES: Readonly<FailureCounter> = Object.freeze({
  failedAttempts: 0,
  failureWindowStartedAt: null,
  blockedUntil: null,
});

export function isBlocked(counter: FailureCounter, now: Date): boolean {
  return (
    counter.blockedUntil !== null &&
    counter.blockedUntil.getTime() > now.getTime()
  );
}

export function isExpired(state: MfaEnrollmentState, now: Date): boolean {
  return state.expiresAt !== null && state.expiresAt.getTime() <= now.getTime();
}

function windowActive(
  counter: FailureCounter,
  now: Date,
  limits: FailureLimits,
): boolean {
  return (
    counter.failureWindowStartedAt !== null &&
    now.getTime() - counter.failureWindowStartedAt.getTime() <
      limits.FAILURE_WINDOW_MS
  );
}

/** Incorrect codes that still count at `now`. */
export function countedFailures(
  counter: FailureCounter,
  now: Date,
  limits: FailureLimits = MFA_ENROLLMENT,
): number {
  return windowActive(counter, now, limits) ? counter.failedAttempts : 0;
}

/** Incorrect codes allowed before the block (0 while blocked). */
export function remainingAttempts(
  counter: FailureCounter,
  now: Date,
  limits: FailureLimits = MFA_ENROLLMENT,
): number {
  if (isBlocked(counter, now)) return 0;
  return Math.max(
    0,
    limits.MAX_FAILED_ATTEMPTS - countedFailures(counter, now, limits),
  );
}

/** Counts one incorrect code; the last allowed one within the window starts the block. */
export function registerFailure(
  counter: FailureCounter,
  now: Date,
  limits: FailureLimits,
): { counter: FailureCounter; blocked: boolean } {
  const counting = windowActive(counter, now, limits);
  const failedAttempts = counting ? counter.failedAttempts + 1 : 1;
  if (failedAttempts >= limits.MAX_FAILED_ATTEMPTS) {
    return {
      blocked: true,
      counter: {
        failedAttempts: 0,
        failureWindowStartedAt: null,
        blockedUntil: new Date(now.getTime() + limits.BLOCK_MS),
      },
    };
  }
  return {
    blocked: false,
    counter: {
      failedAttempts,
      failureWindowStartedAt: counting ? counter.failureWindowStartedAt : now,
      blockedUntil: counter.blockedUntil,
    },
  };
}

export function enrollmentStatus(
  state: MfaEnrollmentState,
  now: Date,
): MfaEnrollmentStatus {
  if (isBlocked(state, now)) return 'BLOCKED';
  if (state.secret === null) return 'NONE';
  return isExpired(state, now) ? 'EXPIRED' : 'PENDING';
}

/** A new pending enrollment (the counters are kept; an ended block is cleared). */
export function startedEnrollment(
  state: MfaEnrollmentState,
  encryptedSecret: string,
  now: Date,
): MfaEnrollmentState {
  const counting = windowActive(state, now, MFA_ENROLLMENT);
  return {
    secret: encryptedSecret,
    expiresAt: new Date(now.getTime() + MFA_ENROLLMENT.TTL_MS),
    failedAttempts: counting ? state.failedAttempts : 0,
    failureWindowStartedAt: counting ? state.failureWindowStartedAt : null,
    blockedUntil: null,
  };
}

/**
 * Counts one incorrect enrollment code; the 5th within the window starts the
 * block and discards the pending secret.
 */
export function recordFailure(
  state: MfaEnrollmentState,
  now: Date,
): { state: MfaEnrollmentState; blocked: boolean } {
  const { counter, blocked } = registerFailure(state, now, MFA_ENROLLMENT);
  return {
    blocked,
    state: blocked
      ? { ...counter, secret: null, expiresAt: null }
      : { ...state, ...counter },
  };
}
