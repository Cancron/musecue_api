import { mock } from 'jest-mock-extended';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import {
  CREDIT_ALLOCATION_BATCH_SIZE,
  CREDIT_ALLOCATION_MAX_BATCHES,
  CreditAllocationScheduler,
  DEFAULT_CREDIT_ALLOCATION_INTERVAL_MS,
  readCreditAllocationIntervalMs,
} from './credit-allocation.scheduler';
import {
  CreditAllowanceService,
  type DueMonthsResult,
} from './credit-allowance.service';

describe('CreditAllocationScheduler', () => {
  const allowances = mock<CreditAllowanceService>();
  const logger = mock<CustomLoggerService>();
  let scheduler: CreditAllocationScheduler;
  const originalEnv = { ...process.env };
  const ids = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
  const batch = (
    processed: string[],
    counts: Partial<DueMonthsResult> = {},
  ) => ({
    allocated: processed.length,
    skipped: 0,
    notPending: 0,
    failed: 0,
    ...counts,
    processed,
  });

  beforeEach(() => {
    jest.resetAllMocks();
    scheduler = new CreditAllocationScheduler(allowances, logger);
  });

  afterEach(() => {
    scheduler.onModuleDestroy();
    process.env = { ...originalEnv };
    jest.useRealTimers();
  });

  describe('run', () => {
    it('allocates due months in batches, never retrying a month in the same run', async () => {
      const first = ids('a', CREDIT_ALLOCATION_BATCH_SIZE);
      allowances.allocateDueMonths
        .mockResolvedValueOnce(batch(first, { failed: 2, allocated: 98 }))
        .mockResolvedValueOnce(batch(['b-1', 'b-2']));
      const now = new Date('2027-03-01T00:00:10.000Z');

      await expect(scheduler.run(now)).resolves.toEqual({
        allocated: 100,
        skipped: 0,
        notPending: 0,
        failed: 2,
      });
      expect(allowances.allocateDueMonths.mock.calls).toHaveLength(2);
      expect(allowances.allocateDueMonths.mock.calls[0]?.[0]).toMatchObject({
        now,
        limit: CREDIT_ALLOCATION_BATCH_SIZE,
        // Workers leave months another worker holds to it.
        skipLocked: true,
      });
      // The second batch excludes everything the first one processed.
      expect(allowances.allocateDueMonths.mock.calls[1]?.[0]?.exclude).toEqual(
        first,
      );
      expect(logger.log.mock.calls).toHaveLength(1);
    });

    it('bounds the work of one run', async () => {
      let n = 0;
      allowances.allocateDueMonths.mockImplementation(() =>
        Promise.resolve(
          batch(ids(`r${(n += 1)}`, CREDIT_ALLOCATION_BATCH_SIZE)),
        ),
      );
      await scheduler.run();
      expect(allowances.allocateDueMonths.mock.calls).toHaveLength(
        CREDIT_ALLOCATION_MAX_BATCHES,
      );
    });

    it('does not log when nothing was due', async () => {
      allowances.allocateDueMonths.mockResolvedValue(batch([]));
      await scheduler.run();
      expect(logger.log.mock.calls).toHaveLength(0);
    });

    it('never runs twice at once on one instance', async () => {
      let release!: () => void;
      allowances.allocateDueMonths.mockReturnValue(
        new Promise((resolve) => {
          release = () => resolve(batch(['m-1']));
        }),
      );

      const first = scheduler.run();
      await expect(scheduler.run()).resolves.toBeNull();
      release();
      await expect(first).resolves.toMatchObject({ allocated: 1 });
    });

    it('survives a failure and runs again next time', async () => {
      allowances.allocateDueMonths.mockRejectedValueOnce(new Error('db down'));
      await expect(scheduler.run()).resolves.toMatchObject({ allocated: 0 });
      expect(logger.error.mock.calls[0]?.[0]).toContain('db down');

      allowances.allocateDueMonths.mockResolvedValue(batch(['m-1']));
      await expect(scheduler.run()).resolves.toMatchObject({ allocated: 1 });
    });
  });

  describe('scheduling', () => {
    it('does not start under NODE_ENV=test', () => {
      process.env.NODE_ENV = 'test';
      scheduler.onModuleInit();
      expect(allowances.allocateDueMonths.mock.calls).toHaveLength(0);
    });

    it('catches up at startup and then runs on every interval', async () => {
      jest.useFakeTimers();
      process.env.NODE_ENV = 'production';
      process.env.CREDIT_ALLOCATION_INTERVAL_MS = '20000';
      allowances.allocateDueMonths.mockResolvedValue(batch([]));

      scheduler.onModuleInit();
      await Promise.resolve();
      expect(allowances.allocateDueMonths.mock.calls).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(20_000);
      expect(allowances.allocateDueMonths.mock.calls).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(20_000);
      expect(allowances.allocateDueMonths.mock.calls).toHaveLength(3);

      scheduler.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(allowances.allocateDueMonths.mock.calls).toHaveLength(3);
    });

    it.each([
      [undefined, DEFAULT_CREDIT_ALLOCATION_INTERVAL_MS],
      ['x', DEFAULT_CREDIT_ALLOCATION_INTERVAL_MS],
      ['9999', DEFAULT_CREDIT_ALLOCATION_INTERVAL_MS],
      ['10000', 10_000],
      ['300000', 300_000],
    ])('reads interval %p as %i ms', (value, expected) => {
      expect(
        readCreditAllocationIntervalMs({
          CREDIT_ALLOCATION_INTERVAL_MS: value,
        }),
      ).toBe(expected);
    });
  });
});
