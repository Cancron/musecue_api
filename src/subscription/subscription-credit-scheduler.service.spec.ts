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
    it('looks only at succeeded yearly payments that granted access, in their paid year, with an active subscription', async () => {
      await scheduler.run(NOW);

      expect(
        prisma.paymentTransaction.findMany.mock.calls[0]?.[0]?.where,
      ).toEqual({
        status: 'SUCCEEDED',
        billingInterval: 'YEARLY',
        periodStart: { lte: NOW },
        periodEnd: { gt: NOW },
        event: { type: { in: ['CREATED', 'RENEWED'] } },
        subscription: { proExpiresAt: { gt: NOW } },
      });
    });

    it('grants the due month only where it is missing', async () => {
      prisma.paymentTransaction.findMany.mockResolvedValueOnce([
        candidate('already', [0, 1, 2]),
        candidate('missing', [0, 1]),
      ] as never);
      const grant = jest
        .spyOn(scheduler, 'grantDueMonth')
        .mockResolvedValue('GRANTED');

      await expect(scheduler.run(NOW)).resolves.toEqual({
        checked: 2,
        granted: 1,
        alreadyGranted: 1,
        skipped: 0,
        failed: 0,
      });
      expect(grant.mock.calls).toEqual([['missing', NOW]]);
    });

    it('pages through every candidate', async () => {
      const page = (from: number, count: number) =>
        Array.from({ length: count }, (_, i) =>
          candidate(`pay-${String(from + i).padStart(4, '0')}`),
        );
      prisma.paymentTransaction.findMany
        .mockResolvedValueOnce(page(0, CREDIT_GRANT_BATCH_SIZE) as never)
        .mockResolvedValueOnce(page(CREDIT_GRANT_BATCH_SIZE, 3) as never);
      jest.spyOn(scheduler, 'grantDueMonth').mockResolvedValue('GRANTED');

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
        .spyOn(scheduler, 'grantDueMonth')
        .mockRejectedValueOnce(new Error('lock timeout'))
        .mockResolvedValueOnce('GRANTED');

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
      let finishFirst: (outcome: 'GRANTED') => void = () => {};
      const grant = jest
        .spyOn(scheduler, 'grantDueMonth')
        .mockReturnValueOnce(
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
        )
        .mockResolvedValue('GRANTED');

      const run = scheduler.run(NOW);
      await new Promise((resolve) => setImmediate(resolve));
      let stopped = false;
      const shutdown = scheduler.onModuleDestroy().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false); // still waiting for the first grant

      finishFirst('GRANTED');
      await shutdown;
      await expect(run).resolves.toMatchObject({ granted: 1, checked: 1 });
      expect(grant.mock.calls.map(([id]) => id)).toEqual(['first']);
      await expect(scheduler.run(NOW)).resolves.toBeNull();
    });
  });

  describe('grantDueMonth', () => {
    beforeEach(() => {
      prisma.paymentTransaction.findUnique
        .mockResolvedValueOnce({ subscriptionId: 'sub-1' } as never)
        .mockResolvedValueOnce(lockedPayment() as never);
      wallets.allocateProMonthlyCreditsInTransaction.mockResolvedValue(
        allocation(true),
      );
    });

    it('locks the subscription, re-checks, and allocates the due month in the same transaction', async () => {
      await expect(scheduler.grantDueMonth('pay-1', NOW)).resolves.toBe(
        'GRANTED',
      );

      expect(
        Array.from(
          prisma.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray,
        ).join('?'),
      ).toMatch(/"UserSubscription".*FOR UPDATE/s);
      // The eligibility re-read happens after the lock.
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.paymentTransaction.findUnique.mock.invocationCallOrder[1],
      );
      expect(wallets.allocateProMonthlyCreditsInTransaction.mock.calls).toEqual(
        [
          [
            prisma,
            {
              authId: 'user-1',
              subscriptionId: 'sub-1',
              payment: expect.objectContaining({ id: 'pay-1' }) as unknown,
              now: NOW,
            },
          ],
        ],
      );
    });

    it('reports a month that already has its allocation', async () => {
      wallets.allocateProMonthlyCreditsInTransaction.mockResolvedValue(
        allocation(false),
      );

      await expect(scheduler.grantDueMonth('pay-1', NOW)).resolves.toBe(
        'ALREADY_GRANTED',
      );
    });

    it.each([
      ['a refunded payment', { status: 'REFUNDED' }],
      ['a partially refunded payment', { status: 'PARTIALLY_REFUNDED' }],
      ['a monthly payment', { billingInterval: 'MONTHLY' }],
      ['a duplicate payment (no granting event)', { event: null }],
      ['a payment whose year has ended', { periodEnd: NOW }],
      ['a payment whose year has not started', { periodStart: YEAR_END }],
      [
        'a subscription whose paid term has ended (e.g. revoked by a refund)',
        {
          subscription: {
            id: 'sub-1',
            authId: 'user-1',
            proStartedAt: YEAR_START,
            proExpiresAt: new Date('2026-08-01T00:00:00.000Z'),
          },
        },
      ],
      ['a detached payment', { subscription: null }],
    ])('skips %s without allocating', async (_case, overrides) => {
      prisma.paymentTransaction.findUnique.mockReset();
      prisma.paymentTransaction.findUnique
        .mockResolvedValueOnce({ subscriptionId: 'sub-1' } as never)
        .mockResolvedValueOnce(lockedPayment(overrides) as never);

      await expect(scheduler.grantDueMonth('pay-1', NOW)).resolves.toBe(
        'SKIPPED',
      );
      expect(
        wallets.allocateProMonthlyCreditsInTransaction.mock.calls,
      ).toHaveLength(0);
    });
  });
});
