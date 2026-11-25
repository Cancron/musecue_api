import { mock, mockDeep } from 'jest-mock-extended';
import type { CustomLoggerService } from '../common/services/custom-logger.service';
import { PrismaService } from '../common/services/prisma.service';
import type { CreditWalletService } from '../credit/credit-wallet.service';
import type { AllocationResult } from '../credit/interfaces/credit-wallet.interface';
import {
  CREDIT_GRANT_BATCH_SIZE,
  SubscriptionCreditSchedulerService,
} from './subscription-credit-scheduler.service';

const YEAR_START = new Date('2026-06-01T10:00:00.000Z');
const YEAR_END = new Date('2027-06-01T10:00:00.000Z');
/** In month 2 of the paid year (Aug 1 - Sep 1). */
const NOW = new Date('2026-08-15T00:00:00.000Z');

const candidate = (id: string, grantedMonths: number[] = []) => ({
  id,
  billingInterval: 'YEARLY' as const,
  periodStart: YEAR_START,
  periodEnd: YEAR_END,
  creditAllocations: grantedMonths.map((periodIndex) => ({ periodIndex })),
});

const allocation = (created: boolean): AllocationResult =>
  ({ created, allocation: { id: 'allocation' } }) as AllocationResult;

describe('SubscriptionCreditSchedulerService', () => {
  const prisma = mockDeep<PrismaService>();
  const wallets = mock<CreditWalletService>();
  const logger = mock<CustomLoggerService>();
  const originalEnv = { ...process.env };
  let scheduler: SubscriptionCreditSchedulerService;

  /** The locked re-read of a payment inside grantDueMonth. */
  const lockedPayment = (overrides: Record<string, unknown> = {}) => ({
    id: 'pay-1',
    subscriptionId: 'sub-1',
    status: 'SUCCEEDED',
    billingInterval: 'YEARLY',
    periodStart: YEAR_START,
    periodEnd: YEAR_END,
    event: { type: 'CREATED' },
    creditAllocations: [] as { periodIndex: number }[],
    subscription: {
      id: 'sub-1',
      authId: 'user-1',
      proStartedAt: YEAR_START,
      proExpiresAt: YEAR_END,
    },
    ...overrides,
  });

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
    scheduler = new SubscriptionCreditSchedulerService(prisma, wallets, logger);
    prisma.$transaction.mockImplementation(((
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => callback(prisma)) as never);
    prisma.paymentTransaction.findMany.mockResolvedValue([]);
  });

  afterEach(async () => {
    await scheduler.onModuleDestroy();
    jest.useRealTimers();
    process.env = originalEnv;
  });

  describe('scheduling', () => {
    it('runs at startup (catching up after a stop) and then on every interval', async () => {
      process.env.NODE_ENV = 'production';
      process.env.CREDIT_ALLOCATION_INTERVAL_MS = '20000';
      jest.useFakeTimers();
      const run = jest.spyOn(scheduler, 'run');

      scheduler.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(20_000);
      expect(run).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(40_000);
      expect(run).toHaveBeenCalledTimes(4);
    });

    it('does not schedule under NODE_ENV=test', async () => {
      process.env.NODE_ENV = 'test';
      jest.useFakeTimers();
      const run = jest.spyOn(scheduler, 'run');

      scheduler.onModuleInit();
      await jest.advanceTimersByTimeAsync(600_000);

      expect(run).not.toHaveBeenCalled();
    });

    it.each([
      [undefined, 60_000],
      ['10000', 10_000],
      ['9999', 60_000],
      ['often', 60_000],
    ])('uses the interval %p as %d ms', (value, expected) => {
      if (value === undefined) delete process.env.CREDIT_ALLOCATION_INTERVAL_MS;
      else process.env.CREDIT_ALLOCATION_INTERVAL_MS = value;
      expect(scheduler.intervalMs()).toBe(expected);
    });
  });

  describe('run', () => {
    it('looks only at succeeded yearly payments that granted access and whose months are not all recorded', async () => {
      await scheduler.run(NOW);

      expect(
        prisma.paymentTransaction.findMany.mock.calls[0]?.[0]?.where,
      ).toEqual({
        status: 'SUCCEEDED',
        billingInterval: 'YEARLY',
        periodStart: { lte: NOW },
        event: { type: { in: ['CREATED', 'RENEWED'] } },
        subscription: { isNot: null },
        creditAllocations: { none: { periodIndex: 11 } },
      });
    });

    it('grants only where a started month is missing, counting missed months separately', async () => {
      prisma.paymentTransaction.findMany.mockResolvedValueOnce([
        candidate('up-to-date', [0, 1, 2]),
        candidate('missing-current', [0, 1]),
        candidate('missing-history', [0]),
      ] as never);
      const grant = jest
        .spyOn(scheduler, 'grantDueMonths')
        .mockResolvedValueOnce({ granted: 1, historical: 0 })
        .mockResolvedValueOnce({ granted: 1, historical: 1 });

      await expect(scheduler.run(NOW)).resolves.toEqual({
        checked: 3,
        granted: 2,
        historical: 1,
        alreadyGranted: 1,
        skipped: 0,
        failed: 0,
      });
      expect(grant.mock.calls).toEqual([
        ['missing-current', NOW],
        ['missing-history', NOW],
      ]);
    });

    it('pages through every candidate', async () => {
      const page = (from: number, count: number) =>
        Array.from({ length: count }, (_, i) =>
          candidate(`pay-${String(from + i).padStart(4, '0')}`),
        );
      prisma.paymentTransaction.findMany
        .mockResolvedValueOnce(page(0, CREDIT_GRANT_BATCH_SIZE) as never)
        .mockResolvedValueOnce(page(CREDIT_GRANT_BATCH_SIZE, 3) as never);
      jest
        .spyOn(scheduler, 'grantDueMonths')
        .mockResolvedValue({ granted: 1, historical: 0 });

      await expect(scheduler.run(NOW)).resolves.toMatchObject({
        checked: CREDIT_GRANT_BATCH_SIZE + 3,
        granted: CREDIT_GRANT_BATCH_SIZE + 3,
      });
      expect(
        prisma.paymentTransaction.findMany.mock.calls[1]?.[0],
      ).toMatchObject({
        cursor: {
          id: `pay-${String(CREDIT_GRANT_BATCH_SIZE - 1).padStart(4, '0')}`,
        },
        skip: 1,
      });
    });

    it('keeps going when one grant fails, and reports it for the next run', async () => {
      prisma.paymentTransaction.findMany.mockResolvedValueOnce([
        candidate('broken'),
        candidate('fine'),
      ] as never);
      jest
        .spyOn(scheduler, 'grantDueMonths')
        .mockRejectedValueOnce(new Error('lock timeout'))
        .mockResolvedValueOnce({ granted: 1, historical: 0 });

      await expect(scheduler.run(NOW)).resolves.toMatchObject({
        granted: 1,
        failed: 1,
      });
      expect(logger.warn.mock.calls).toHaveLength(1);
    });

    it('never throws and does not run twice at once in one process', async () => {
      let release: (value: never[]) => void = () => {};
      prisma.paymentTransaction.findMany.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }) as never,
      );

      const first = scheduler.run(NOW);
      await expect(scheduler.run(NOW)).resolves.toBeNull();
      release([]);
      await expect(first).resolves.toMatchObject({ checked: 0 });

      prisma.paymentTransaction.findMany.mockRejectedValueOnce(
        new Error('database down'),
      );
      await expect(scheduler.run(NOW)).resolves.toMatchObject({ checked: 0 });
    });
  });

  describe('graceful shutdown', () => {
    it('waits for the grant in progress, stops before the next one, and starts no new run', async () => {
      prisma.paymentTransaction.findMany.mockResolvedValueOnce([
        candidate('first'),
        candidate('second'),
      ] as never);
      let finishFirst: (outcome: {
        granted: number;
        historical: number;
      }) => void = () => {};
      const grant = jest
        .spyOn(scheduler, 'grantDueMonths')
        .mockReturnValueOnce(
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
        )
        .mockResolvedValue({ granted: 1, historical: 0 });

      const run = scheduler.run(NOW);
      await new Promise((resolve) => setImmediate(resolve));
      let stopped = false;
      const shutdown = scheduler.onModuleDestroy().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false); // still waiting for the first grant

      finishFirst({ granted: 1, historical: 0 });
      await shutdown;
      await expect(run).resolves.toMatchObject({ granted: 1, checked: 1 });
      expect(grant.mock.calls.map(([id]) => id)).toEqual(['first']);
      await expect(scheduler.run(NOW)).resolves.toBeNull();
    });
  });

  describe('grantDueMonths', () => {
    const givenLocked = (overrides: Record<string, unknown> = {}) => {
      prisma.paymentTransaction.findUnique.mockReset();
      prisma.paymentTransaction.findUnique
        .mockResolvedValueOnce({ subscriptionId: 'sub-1' } as never)
        .mockResolvedValueOnce(lockedPayment(overrides) as never);
    };
    const grantedMonths = () =>
      wallets.allocateProMonthCreditsInTransaction.mock.calls.map(
        ([, input]) => [
          input.month.index,
          input.month.end.getTime() <= NOW.getTime() ? 'ended' : 'current',
        ],
      );

    beforeEach(() => {
      wallets.allocateProMonthCreditsInTransaction.mockResolvedValue(
        allocation(true),
      );
    });

    it('locks the subscription, re-checks, and allocates the current month in the same transaction', async () => {
      givenLocked({
        creditAllocations: [0, 1].map((periodIndex) => ({ periodIndex })),
      });

      await expect(scheduler.grantDueMonths('pay-1', NOW)).resolves.toEqual({
        granted: 1,
        historical: 0,
      });

      expect(
        Array.from(
          prisma.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray,
        ).join('?'),
      ).toMatch(/"UserSubscription".*FOR UPDATE/s);
      // The eligibility re-read happens after the lock.
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.paymentTransaction.findUnique.mock.invocationCallOrder[1],
      );
      expect(wallets.allocateProMonthCreditsInTransaction.mock.calls).toEqual([
        [
          prisma,
          expect.objectContaining({
            authId: 'user-1',
            subscriptionId: 'sub-1',
            payment: expect.objectContaining({ id: 'pay-1' }) as unknown,
            month: expect.objectContaining({ index: 2 }) as unknown,
            now: NOW,
          }),
        ],
      ]);
    });

    it('records missed months that already ended, oldest first, before the current month', async () => {
      givenLocked({ creditAllocations: [{ periodIndex: 0 }] });

      await expect(scheduler.grantDueMonths('pay-1', NOW)).resolves.toEqual({
        granted: 1,
        historical: 1,
      });
      expect(grantedMonths()).toEqual([
        [1, 'ended'],
        [2, 'current'],
      ]);
    });

    it('records the months of an ended paid year that the term covered', async () => {
      givenLocked({
        creditAllocations: [{ periodIndex: 0 }],
        subscription: {
          id: 'sub-1',
          authId: 'user-1',
          proStartedAt: YEAR_START,
          // Revoked during month 1: months 2+ were never paid for.
          proExpiresAt: new Date('2026-07-15T00:00:00.000Z'),
        },
      });

      await expect(
        scheduler.grantDueMonths('pay-1', new Date('2027-08-01T00:00:00.000Z')),
      ).resolves.toEqual({ granted: 0, historical: 1 });
      expect(
        wallets.allocateProMonthCreditsInTransaction.mock.calls.map(
          ([, input]) => input.month.index,
        ),
      ).toEqual([1]);
    });

    it('does not count a month that already has its allocation', async () => {
      givenLocked({
        creditAllocations: [0, 1].map((periodIndex) => ({ periodIndex })),
      });
      wallets.allocateProMonthCreditsInTransaction.mockResolvedValue(
        allocation(false),
      );

      await expect(scheduler.grantDueMonths('pay-1', NOW)).resolves.toEqual({
        granted: 0,
        historical: 0,
      });
    });

    it.each([
      ['a refunded payment', { status: 'REFUNDED' }],
      ['a partially refunded payment', { status: 'PARTIALLY_REFUNDED' }],
      ['a monthly payment', { billingInterval: 'MONTHLY' }],
      ['a duplicate payment (no granting event)', { event: null }],
      ['a detached payment', { subscription: null }],
    ])('skips %s without allocating', async (_case, overrides) => {
      givenLocked({ creditAllocations: [], ...overrides });

      await expect(scheduler.grantDueMonths('pay-1', NOW)).resolves.toEqual({
        granted: 0,
        historical: 0,
      });
      expect(
        wallets.allocateProMonthCreditsInTransaction.mock.calls,
      ).toHaveLength(0);
    });

    it('does not grant the current month once the paid term has ended (e.g. revoked), but still records the covered months', async () => {
      givenLocked({
        creditAllocations: [{ periodIndex: 0 }],
        subscription: {
          id: 'sub-1',
          authId: 'user-1',
          proStartedAt: YEAR_START,
          proExpiresAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      });

      await expect(scheduler.grantDueMonths('pay-1', NOW)).resolves.toEqual({
        granted: 0,
        historical: 1,
      });
      expect(grantedMonths()).toEqual([[1, 'ended']]);
    });
  });
});
