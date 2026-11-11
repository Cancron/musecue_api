/**
 * Freezes `Date` at `now` while leaving timers, ticks and I/O real, so Nest,
 * supertest and pg keep working. Undo with `jest.useRealTimers()`.
 */
export const freezeTime = (now: Date) =>
  jest.useFakeTimers({
    now,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
