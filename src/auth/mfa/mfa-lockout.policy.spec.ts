import {
  activeBlock,
  recentFailures,
  registerFailure,
  remainingAttempts,
} from './mfa-lockout.policy';

const T0 = new Date('2026-11-22T12:00:00.000Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;

/** Replays incorrect codes at the given offsets and returns every outcome. */
function failAt(offsets: number[]) {
  let failures: Date[] = [];
  return offsets.map((offset) => {
    const outcome = registerFailure(failures, plus(offset));
    failures = outcome.failedAttemptsAt;
    return outcome;
  });
}

describe('MFA lockout policy', () => {
  it('allows four incorrect codes and blocks on the fifth within 15 minutes', () => {
    const outcomes = failAt([0, 1 * MIN, 2 * MIN, 3 * MIN, 4 * MIN]);

    expect(outcomes.map((o) => o.remainingAttempts)).toEqual([4, 3, 2, 1, 0]);
    expect(outcomes.slice(0, 4).every((o) => o.blockedUntil === null)).toBe(
      true,
    );
    // The block lasts 15 minutes from the fifth failure; the history is
    // cleared so a fresh window starts after it.
    expect(outcomes[4]).toEqual({
      failedAttemptsAt: [],
      blockedUntil: plus(4 * MIN + 15 * MIN),
      remainingAttempts: 0,
    });
  });

  it('blocks five failures spread over just under 15 minutes', () => {
    const outcomes = failAt([0, 5 * MIN, 10 * MIN, 14 * MIN, 15 * MIN - 1]);
    expect(outcomes[4].blockedUntil).toEqual(plus(15 * MIN - 1 + 15 * MIN));
  });

  it('does not count failures older than 15 minutes', () => {
    const outcomes = failAt([0, 1 * MIN, 2 * MIN, 3 * MIN, 15 * MIN]);
    // At 15:00 the first failure (00:00) has left the window.
    expect(outcomes[4].blockedUntil).toBeNull();
    expect(outcomes[4].remainingAttempts).toBe(1);
    expect(outcomes[4].failedAttemptsAt).toEqual([
      plus(1 * MIN),
      plus(2 * MIN),
      plus(3 * MIN),
      plus(15 * MIN),
    ]);
  });

  it('uses a sliding window: any five failures within 15 minutes block', () => {
    // A fixed window starting at 00:00 would reset at 15:00 and miss the
    // five failures between 14:00 and 15:40.
    const outcomes = failAt([
      0,
      14 * MIN,
      14.5 * MIN,
      14.8 * MIN,
      15.2 * MIN,
      15.3 * MIN,
    ]);
    expect(outcomes[4].blockedUntil).toBeNull();
    expect(outcomes[5].blockedUntil).toEqual(plus(15.3 * MIN + 15 * MIN));
  });

  it('never stores more than five failures', () => {
    const many = Array.from({ length: 20 }, (_, i) => plus(i * 1000));
    const outcome = registerFailure(many, plus(30_000));
    expect(outcome.failedAttemptsAt.length).toBeLessThanOrEqual(5);
    expect(outcome.blockedUntil).not.toBeNull();
  });

  it('ignores failures dated in the future (clock changes)', () => {
    expect(recentFailures([plus(MIN)], T0)).toEqual([]);
  });

  it('reports remaining attempts from the current window only', () => {
    const failures = [plus(0), plus(MIN), plus(2 * MIN)];
    expect(remainingAttempts(failures, plus(3 * MIN))).toBe(2);
    // At 16:30 only the failure of 02:00 is inside the window.
    expect(remainingAttempts(failures, plus(16 * MIN + 30_000))).toBe(4);
    expect(remainingAttempts(failures, plus(30 * MIN))).toBe(5);
    expect(remainingAttempts([], T0)).toBe(5);
  });

  it('treats a block as active until, but not at, its end', () => {
    const until = plus(15 * MIN);
    expect(activeBlock(until, plus(15 * MIN - 1))).toEqual(until);
    expect(activeBlock(until, until)).toBeNull();
    expect(activeBlock(null, T0)).toBeNull();
    expect(activeBlock(undefined, T0)).toBeNull();
  });
});
