import { backoffDelay } from './job.types';

describe('backoffDelay (BullMQ semantics)', () => {
  it('doubles an exponential delay per failed attempt', () => {
    const email = { type: 'exponential' as const, delayMs: 2_000 };
    expect([1, 2, 3].map((attempt) => backoffDelay(email, attempt))).toEqual([
      2_000, 4_000, 8_000,
    ]);
  });

  it('keeps a fixed delay', () => {
    expect(backoffDelay({ type: 'fixed', delayMs: 500 }, 3)).toBe(500);
  });

  it('applies jitter within [delay * (1 - jitter), delay]', () => {
    const exports = {
      type: 'exponential' as const,
      delayMs: 15_000,
      jitter: 0.5,
    };
    expect(backoffDelay(exports, 1, () => 0)).toBe(7_500);
    expect(backoffDelay(exports, 1, () => 0.999999)).toBe(14_999);
    expect(backoffDelay(exports, 2, () => 0)).toBe(15_000);
  });

  it('retries at once without a backoff', () => {
    expect(backoffDelay(undefined, 2)).toBe(0);
  });
});
