import { mock } from 'jest-mock-extended';
import type { CustomLoggerService } from '../common/services/custom-logger.service';
import {
  CREDIT_EXPIRY_BATCH_SIZE,
  CREDIT_EXPIRY_MAX_BATCHES,
  CreditExpirySweepService,
} from './credit-expiry-sweep.service';
import type { CreditWalletService } from './credit-wallet.service';

const batch = (wallets: number, expiredAllocations = wallets, failed = 0) => ({
  wallets,
  expiredAllocations,
  failedWallets: failed,
});

describe('CreditExpirySweepService', () => {
  const wallets = mock<CreditWalletService>();
  const logger = mock<CustomLoggerService>();
  const originalEnv = { ...process.env };
  let sweeper: CreditExpirySweepService;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
    sweeper = new CreditExpirySweepService(wallets, logger);
  });

  afterEach(async () => {
    await sweeper.onModuleDestroy();
    jest.useRealTimers();
    process.env = originalEnv;
  });

  describe('scheduling', () => {
    it('sweeps at startup and then on every interval, so idle wallets are expired too', async () => {
      process.env.NODE_ENV = 'production';
      process.env.CREDIT_EXPIRY_SWEEP_INTERVAL_MS = '15000';
      jest.useFakeTimers();
      wallets.expireAllDueCredits.mockResolvedValue(batch(0));

      sweeper.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      expect(wallets.expireAllDueCredits.mock.calls).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(15_000);
      expect(wallets.expireAllDueCredits.mock.calls).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(wallets.expireAllDueCredits.mock.calls).toHaveLength(4);
    });

    it('does not schedule under NODE_ENV=test', async () => {
      process.env.NODE_ENV = 'test';
      jest.useFakeTimers();

      sweeper.onModuleInit();
      await jest.advanceTimersByTimeAsync(600_000);

      expect(wallets.expireAllDueCredits.mock.calls).toHaveLength(0);
    });

    it.each([
      [undefined, 60_000],
      ['10000', 10_000],
      ['120000', 120_000],
      ['9999', 60_000],
      ['abc', 60_000],
      ['1.5e4', 15_000],
      ['15000.5', 60_000],
    ])('uses the interval %p as %d ms', (value, expected) => {
      if (value === undefined)
        delete process.env.CREDIT_EXPIRY_SWEEP_INTERVAL_MS;
      else process.env.CREDIT_EXPIRY_SWEEP_INTERVAL_MS = value;

      expect(sweeper.sweepIntervalMs()).toBe(expected);
    });
  });

  describe('sweep', () => {
    const now = new Date('2026-11-25T12:00:00.000Z');

    it('drains the backlog batch by batch at one point in time', async () => {
      wallets.expireAllDueCredits
        .mockResolvedValueOnce(batch(CREDIT_EXPIRY_BATCH_SIZE))
        .mockResolvedValueOnce(batch(CREDIT_EXPIRY_BATCH_SIZE))
        .mockResolvedValueOnce(batch(7));

      await expect(sweeper.sweep(now)).resolves.toEqual({
        wallets: 2 * CREDIT_EXPIRY_BATCH_SIZE + 7,
        expiredAllocations: 2 * CREDIT_EXPIRY_BATCH_SIZE + 7,
        failedWallets: 0,
      });
      expect(wallets.expireAllDueCredits.mock.calls).toEqual(
        Array(3).fill([{ now, batchSize: CREDIT_EXPIRY_BATCH_SIZE }]),
      );
      expect(logger.log.mock.calls).toHaveLength(1);
    });

    it('stops when a full batch makes no progress (only failing wallets left)', async () => {
      wallets.expireAllDueCredits.mockResolvedValue(
        batch(CREDIT_EXPIRY_BATCH_SIZE, 0, CREDIT_EXPIRY_BATCH_SIZE),
      );

      await expect(sweeper.sweep(now)).resolves.toMatchObject({
        failedWallets: CREDIT_EXPIRY_BATCH_SIZE,
      });
      expect(wallets.expireAllDueCredits.mock.calls).toHaveLength(1);
    });

    it('caps the number of batches per sweep', async () => {
      wallets.expireAllDueCredits.mockResolvedValue(
        batch(CREDIT_EXPIRY_BATCH_SIZE),
      );

      await sweeper.sweep(now);

      expect(wallets.expireAllDueCredits.mock.calls).toHaveLength(
        CREDIT_EXPIRY_MAX_BATCHES,
      );
    });

    it('never throws, logs the failure and retries on the next sweep', async () => {
      wallets.expireAllDueCredits.mockRejectedValueOnce(new Error('down'));

      await expect(sweeper.sweep(now)).resolves.toEqual(batch(0));
      expect(logger.warn.mock.calls).toHaveLength(1);

      wallets.expireAllDueCredits.mockResolvedValueOnce(batch(1));
      await expect(sweeper.sweep(now)).resolves.toEqual(batch(1));
    });

    it('does not run two sweeps at once in one process', async () => {
      let release: (value: ReturnType<typeof batch>) => void = () => {};
      wallets.expireAllDueCredits.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      );

      const first = sweeper.sweep(now);
      await expect(sweeper.sweep(now)).resolves.toBeNull();
      release(batch(0));
      await expect(first).resolves.toEqual(batch(0));
    });

    it('shutdown waits for the batch in progress, then stops sweeping', async () => {
      let release: (value: ReturnType<typeof batch>) => void = () => {};
      wallets.expireAllDueCredits
        .mockReturnValueOnce(
          new Promise((resolve) => {
            release = resolve;
          }),
        )
        .mockResolvedValue(batch(CREDIT_EXPIRY_BATCH_SIZE));

      const sweep = sweeper.sweep(now);
      let stopped = false;
      const shutdown = sweeper.onModuleDestroy().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);

      release(batch(CREDIT_EXPIRY_BATCH_SIZE));
      await shutdown;
      await expect(sweep).resolves.toMatchObject({
        wallets: CREDIT_EXPIRY_BATCH_SIZE,
      });
      expect(wallets.expireAllDueCredits.mock.calls).toHaveLength(1);
      await expect(sweeper.sweep(now)).resolves.toBeNull();
    });

    it('stays quiet when nothing was due', async () => {
      wallets.expireAllDueCredits.mockResolvedValue(batch(0));

      await sweeper.sweep(now);

      expect(logger.log.mock.calls).toHaveLength(0);
      expect(logger.warn.mock.calls).toHaveLength(0);
    });
  });
});
