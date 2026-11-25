import { EMPTY_ENROLLMENT } from './mfa-enrollment.repository';
import type { MfaEnrollmentState } from './mfa-enrollment.repository';
import {
  countedFailures,
  enrollmentStatus,
  isBlocked,
  isExpired,
  recordFailure,
  remainingAttempts,
  startedEnrollment,
} from './mfa-enrollment.policy';

const T0 = new Date('2026-11-22T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;

const fail = (state: MfaEnrollmentState, times: number, now = T0) => {
  let current = state;
  let blocked = false;
  for (let i = 0; i < times; i += 1) {
    ({ state: current, blocked } = recordFailure(current, now));
  }
  return { state: current, blocked };
};

describe('MFA enrollment policy (mfa)', () => {
  const pending = startedEnrollment({ ...EMPTY_ENROLLMENT }, 'v1.a.b.c', T0);

  it('starts a pending enrollment that expires after exactly 10 minutes', () => {
    expect(pending).toMatchObject({
      secret: 'v1.a.b.c',
      expiresAt: at(10 * MIN),
      failedAttempts: 0,
      blockedUntil: null,
    });
    expect(enrollmentStatus(pending, at(10 * MIN - 1))).toBe('PENDING');
    expect(isExpired(pending, at(10 * MIN - 1))).toBe(false);
    expect(isExpired(pending, at(10 * MIN))).toBe(true);
    expect(enrollmentStatus(pending, at(10 * MIN))).toBe('EXPIRED');
    expect(enrollmentStatus({ ...EMPTY_ENROLLMENT }, T0)).toBe('NONE');
  });

  it('counts incorrect codes and blocks on the 5th within 15 minutes', () => {
    const four = fail(pending, 4);
    expect(four.blocked).toBe(false);
    expect(four.state.failedAttempts).toBe(4);
    expect(remainingAttempts(four.state, T0)).toBe(1);
    expect(four.state.secret).toBe('v1.a.b.c');

    const fifth = recordFailure(four.state, at(14 * MIN));
    expect(fifth.blocked).toBe(true);
    expect(fifth.state).toEqual({
      // The pending secret is discarded: a new enrollment is needed.
      secret: null,
      expiresAt: null,
      failedAttempts: 0,
      failureWindowStartedAt: null,
      blockedUntil: at(29 * MIN),
    });
    expect(isBlocked(fifth.state, at(29 * MIN - 1))).toBe(true);
    expect(enrollmentStatus(fifth.state, at(29 * MIN - 1))).toBe('BLOCKED');
    expect(remainingAttempts(fifth.state, at(20 * MIN))).toBe(0);
    expect(isBlocked(fifth.state, at(29 * MIN))).toBe(false);
    expect(enrollmentStatus(fifth.state, at(29 * MIN))).toBe('NONE');
    expect(remainingAttempts(fifth.state, at(29 * MIN))).toBe(5);
  });

  it('starts a new window when 15 minutes passed since its first failure', () => {
    const four = fail(pending, 4);
    const late = recordFailure(four.state, at(15 * MIN));
    expect(late.blocked).toBe(false);
    expect(late.state.failedAttempts).toBe(1);
    expect(late.state.failureWindowStartedAt).toEqual(at(15 * MIN));
    expect(countedFailures(four.state, at(15 * MIN))).toBe(0);
    expect(countedFailures(four.state, at(15 * MIN - 1))).toBe(4);
  });

  it('keeps the counters when an enrollment is restarted', () => {
    const three = fail(pending, 3);
    const restarted = startedEnrollment(three.state, 'v1.d.e.f', at(MIN));
    expect(restarted).toMatchObject({
      secret: 'v1.d.e.f',
      expiresAt: at(11 * MIN),
      failedAttempts: 3,
      failureWindowStartedAt: T0,
    });
    expect(fail(restarted, 2, at(2 * MIN)).blocked).toBe(true);
  });

  it('forgets counters of an ended window on restart, and clears an ended block', () => {
    const blocked = fail(pending, 5).state;
    const afterBlock = startedEnrollment(blocked, 'v1.g.h.i', at(15 * MIN));
    expect(afterBlock).toMatchObject({
      failedAttempts: 0,
      failureWindowStartedAt: null,
      blockedUntil: null,
    });
    const stale = startedEnrollment(
      fail(pending, 2).state,
      'v1.j.k.l',
      at(16 * MIN),
    );
    expect(stale.failedAttempts).toBe(0);
  });
});
