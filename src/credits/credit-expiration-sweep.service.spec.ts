import { mock } from 'jest-mock-extended';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import {
  CREDIT_EXPIRATION_SWEEP_BATCH_SIZE,
  CREDIT_EXPIRATION_SWEEP_MAX_BATCHES,
  CreditExpirationSweepService,
  DEFAULT_CREDIT_EXPIRATION_SWEEP_INTERVAL_MS,
  readCreditExpirationSweepIntervalMs,
} from './credit-expiration-sweep.service';
import { CreditWalletService } from './credit-wallet.service';

describe('CreditExpirationSweepService', () => {
  const wallet = mock<CreditWalletService>();
  const logger = mock<CustomLoggerService>();
  let service: CreditExpirationSweepService;
  const originalEnv = { ...process.env };
  const batch = (wallets: number, expirations = wallets, failed = 0) => ({
    wallets,
    expirations,
    failed,
  });

  beforeEach(() => {
    jest.resetAllMocks();
    service = new CreditExpirationSweepService(wallet, logger);
  });

  afterEach(() => {
    service.onModuleDestroy();
    process.env = { ...originalEnv };
    jest.useRealTimers();
  });

  describe('sweep', () => {
    it('processes batches until no wallet with expired credits is left', async () => {
      wallet.expireDueCredits
        .mockResolvedValueOnce(batch(CREDIT_EXPIRATION_SWEEP_BATCH_SIZE, 130))
        .mockResolvedValueOnce(batch(7, 9));

      await expect(service.sweep()).resolves.toEqual({
        wallets: CREDIT_EXPIRATION_SWEEP_BATCH_SIZE + 7,
        expirations: 139,
        failed: 0,
      });
      expect(wallet.expireDueCredits.mock.calls).toEqual([
        [{ limit: CREDIT_EXPIRATION_SWEEP_BATCH_SIZE }],
        [{ limit: CREDIT_EXPIRATION_SWEEP_BATCH_SIZE }],
      ]);
      expect(logger.log.mock.calls).toHaveLength(1);
    });

    it('stops when only failing wallets are left, leaving them for the next sweep', async () => {
      wallet.expireDueCredits.mockResolvedValue(
        batch(
          CREDIT_EXPIRATION_SWEEP_BATCH_SIZE,
          0,
          CREDIT_EXPIRATION_SWEEP_BATCH_SIZE,
        ),
      );

      await expect(service.sweep()).resolves.toMatchObject({
        failed: CREDIT_EXPIRATION_SWEEP_BATCH_SIZE,
      });
      expect(wallet.expireDueCredits.mock.calls).toHaveLength(1);
    });

    it('bounds the work of one sweep', async () => {
      wallet.expireDueCredits.mockResolvedValue(
        batch(CREDIT_EXPIRATION_SWEEP_BATCH_SIZE),
      );

      await service.sweep();

      expect(wallet.expireDueCredits.mock.calls).toHaveLength(
        CREDIT_EXPIRATION_SWEEP_MAX_BATCHES,
      );
    });

    it('does not log when there was nothing to expire', async () => {
      wallet.expireDueCredits.mockResolvedValue(batch(0));
      await service.sweep();
      expect(logger.log.mock.calls).toHaveLength(0);
    });

    it('never runs two sweeps at once on one instance', async () => {
      let release!: () => void;
      wallet.expireDueCredits.mockReturnValue(
        new Promise((resolve) => {
          release = () => resolve(batch(1));
        }),
      );

      const first = service.sweep();
      await expect(service.sweep()).resolves.toBeNull();
      release();
      await expect(first).resolves.toMatchObject({ wallets: 1 });
    });

    it('survives a failure and can run again', async () => {
      wallet.expireDueCredits.mockRejectedValueOnce(new Error('db down'));
      await expect(service.sweep()).resolves.toEqual(batch(0));
      expect(logger.error.mock.calls[0]?.[0]).toContain('db down');

      wallet.expireDueCredits.mockResolvedValue(batch(2));
      await expect(service.sweep()).resolves.toEqual(batch(2));
    });
  });

  describe('scheduling', () => {
    it('does not start under NODE_ENV=test', () => {
      process.env.NODE_ENV = 'test';
      service.onModuleInit();
      expect(wallet.expireDueCredits.mock.calls).toHaveLength(0);
    });

    it('sweeps at startup and then on every interval, without waiting for wallet activity', async () => {
      jest.useFakeTimers();
      process.env.NODE_ENV = 'production';
      process.env.CREDIT_EXPIRATION_SWEEP_INTERVAL_MS = '30000';
      wallet.expireDueCredits.mockResolvedValue(batch(0));

      service.onModuleInit();
      await Promise.resolve();
      expect(wallet.expireDueCredits.mock.calls).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(30_000);
      expect(wallet.expireDueCredits.mock.calls).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(wallet.expireDueCredits.mock.calls).toHaveLength(3);

      service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(wallet.expireDueCredits.mock.calls).toHaveLength(3);
    });

    it.each([
      [undefined, DEFAULT_CREDIT_EXPIRATION_SWEEP_INTERVAL_MS],
      ['abc', DEFAULT_CREDIT_EXPIRATION_SWEEP_INTERVAL_MS],
      ['9999', DEFAULT_CREDIT_EXPIRATION_SWEEP_INTERVAL_MS],
      ['10000.5', DEFAULT_CREDIT_EXPIRATION_SWEEP_INTERVAL_MS],
      ['10000', 10_000],
      ['3600000', 3_600_000],
    ])('reads interval %p as %i ms', (value, expected) => {
      expect(
        readCreditExpirationSweepIntervalMs({
          CREDIT_EXPIRATION_SWEEP_INTERVAL_MS: value,
        }),
      ).toBe(expected);
    });
  });
});
