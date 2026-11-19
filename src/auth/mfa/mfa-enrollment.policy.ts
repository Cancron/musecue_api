import { MFA_ENROLLMENT } from './mfa.constants';

/**
 * Rules of the enrollment lockout: five incorrect confirmation codes within
 * any 15 minutes (a sliding window) block enrollment for 15 minutes. Pure
 * functions over the stored failure times; the caller supplies the time.
 */

/** The failures that still count at `now` (the last 15 minutes). */
export function recentFailures(failures: readonly Date[], now: Date): Date[] {
  const windowStart = now.getTime() - MFA_ENROLLMENT.FAILURE_WINDOW_MS;
  return failures
    .filter((at) => at.getTime() > windowStart && at.getTime() <= now.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
}

/** Incorrect codes the user may still enter before the block. */
export function remainingAttempts(
  failures: readonly Date[],
  now: Date,
): number {
  return Math.max(
    0,
    MFA_ENROLLMENT.MAX_FAILED_ATTEMPTS - recentFailures(failures, now).length,
  );
}

/** The end of a block that is still active at `now`, otherwise null. */
export function activeBlock(
  blockedUntil: Date | null | undefined,
  now: Date,
): Date | null {
  return blockedUntil && blockedUntil.getTime() > now.getTime()
    ? blockedUntil
    : null;
}

export interface FailureOutcome {
  /** The failure history to store (at most MAX_FAILED_ATTEMPTS entries). */
  failedAttemptsAt: Date[];
  /** Set when this failure starts a block. */
  blockedUntil: Date | null;
  remainingAttempts: number;
}

/**
 * Records an incorrect code at `now`. The failure that makes five within the
 * window starts the block; the history is then cleared, so the block itself
 * is what stops further attempts, and a fresh window starts after it.
 */
export function registerFailure(
  failures: readonly Date[],
  now: Date,
): FailureOutcome {
  const counted = [...recentFailures(failures, now), now];
  if (counted.length >= MFA_ENROLLMENT.MAX_FAILED_ATTEMPTS) {
    return {
      failedAttemptsAt: [],
      blockedUntil: new Date(now.getTime() + MFA_ENROLLMENT.BLOCK_DURATION_MS),
      remainingAttempts: 0,
    };
  }
  return {
    failedAttemptsAt: counted,
    blockedUntil: null,
    remainingAttempts: MFA_ENROLLMENT.MAX_FAILED_ATTEMPTS - counted.length,
  };
}
