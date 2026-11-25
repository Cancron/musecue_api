import { MFA_ENROLLMENT } from './mfa.constants';
import type { MfaEnrollmentState } from './mfa-enrollment.repository';

/**
 * Enrollment rules as pure functions of the stored state and the time:
 * - a started enrollment is pending for 10 minutes (expired at `expiresAt`);
 * - incorrect codes are counted in a 15-minute window that starts with the
 *   first failure; the 5th failure within it blocks enrollment (start and
 *   confirm) for 15 minutes and discards the pending secret;
 * - restarting an enrollment keeps the counters.
 */

export type MfaEnrollmentStatus = 'NONE' | 'PENDING' | 'EXPIRED' | 'BLOCKED';

export function isBlocked(state: MfaEnrollmentState, now: Date): boolean {
  return (
    state.blockedUntil !== null && state.blockedUntil.getTime() > now.getTime()
  );
}

export function isExpired(state: MfaEnrollmentState, now: Date): boolean {
  return state.expiresAt !== null && state.expiresAt.getTime() <= now.getTime();
}

function windowActive(state: MfaEnrollmentState, now: Date): boolean {
  return (
    state.failureWindowStartedAt !== null &&
    now.getTime() - state.failureWindowStartedAt.getTime() <
      MFA_ENROLLMENT.FAILURE_WINDOW_MS
  );
}

/** Incorrect codes that still count at `now`. */
export function countedFailures(state: MfaEnrollmentState, now: Date): number {
  return windowActive(state, now) ? state.failedAttempts : 0;
}

/** Incorrect codes allowed before the block (0 while blocked). */
export function remainingAttempts(
  state: MfaEnrollmentState,
  now: Date,
): number {
  if (isBlocked(state, now)) return 0;
  return Math.max(
    0,
    MFA_ENROLLMENT.MAX_FAILED_ATTEMPTS - countedFailures(state, now),
  );
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
  const counting = windowActive(state, now);
  return {
    secret: encryptedSecret,
    expiresAt: new Date(now.getTime() + MFA_ENROLLMENT.TTL_MS),
    failedAttempts: counting ? state.failedAttempts : 0,
    failureWindowStartedAt: counting ? state.failureWindowStartedAt : null,
    blockedUntil: null,
  };
}

/** Counts one incorrect code; the 5th within the window starts the block. */
export function recordFailure(
  state: MfaEnrollmentState,
  now: Date,
): { state: MfaEnrollmentState; blocked: boolean } {
  const counting = windowActive(state, now);
  const failedAttempts = counting ? state.failedAttempts + 1 : 1;
  if (failedAttempts >= MFA_ENROLLMENT.MAX_FAILED_ATTEMPTS) {
    return {
      blocked: true,
      state: {
        secret: null,
        expiresAt: null,
        failedAttempts: 0,
        failureWindowStartedAt: null,
        blockedUntil: new Date(now.getTime() + MFA_ENROLLMENT.BLOCK_MS),
      },
    };
  }
  return {
    blocked: false,
    state: {
      ...state,
      failedAttempts,
      failureWindowStartedAt: counting ? state.failureWindowStartedAt : now,
    },
  };
}
