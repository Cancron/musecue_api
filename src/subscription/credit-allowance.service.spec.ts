import { BillingInterval, CreditSource, Prisma } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../common/services/prisma.service';
import { CreditSettingsService } from '../credits/credit-settings.service';
import { CreditWalletService } from '../credits/credit-wallet.service';
import type { GrantCreditsResult } from '../credits/interfaces/credit-wallet.interface';
import {
  CreditAllowanceService,
  TRIAL_CREDITS_ENDED_BY_UPGRADE,
} from './credit-allowance.service';

describe('CreditAllowanceService', () => {
  const tx = mockDeep<PrismaService>();
  const wallet = mock<CreditWalletService>();
  const settings = mock<CreditSettingsService>();
  const prisma = mockDeep<PrismaService>();
  const service = new CreditAllowanceService(prisma, wallet, settings);
  const startedAt = new Date('2026-07-01T10:00:00.000Z');
  const expiresAt = new Date('2026-07-08T10:00:00.000Z');

  beforeEach(() => {
    jest.resetAllMocks();
    settings.getSettings.mockResolvedValue({
      trialCredits: 50,
      proMonthlyCredits: 1000,
      creditCostUsdMicros: 5000,
      creditCostUsd: '0.005',
      sessionOverageCredits: 5,
      deductionStepMicroCredits: 1000000,
      deductionStepCredits: '1',
      updatedAt: startedAt.toISOString(),
    });
    wallet.grant.mockResolvedValue({ replayed: false } as GrantCreditsResult);
  });

  describe('grantTrialCredits', () => {
    it("grants the administrator's trial allowance, expiring with the trial, in the caller's transaction", async () => {
      await service.grantTrialCredits(tx, 'user-1', { startedAt, expiresAt });

      expect(settings.getSettings.mock.calls).toEqual([[tx]]);
      expect(wallet.grant.mock.calls).toEqual([
        [
          {
            authId: 'user-1',
            source: CreditSource.TRIAL,
            sourceReference: 'trial:2026-07-01T10:00:00.000Z',
            amount: 50,
            expiresAt,
            description: 'Free trial credits',
          },
          { tx, at: startedAt },
        ],
      ]);
    });

    it('uses the configured amount', async () => {
      settings.getSettings.mockResolvedValue({
        trialCredits: 120,
      } as never);

      await service.grantTrialCredits(tx, 'user-1', { startedAt, expiresAt });

      expect(wallet.grant.mock.calls[0]?.[0]).toMatchObject({ amount: 120 });
    });

    it('never retries a repeated grant with other values: a second trial conflicts', async () => {
      wallet.grant.mockRejectedValue(
        new Error('Trial credits were already granted'),
      );
      await expect(
        service.grantTrialCredits(tx, 'user-1', { startedAt, expiresAt }),
      ).rejects.toThrow('already granted');
      expect(wallet.grant.mock.calls[0]?.[0]).not.toHaveProperty(
        'keepExistingGrant',
      );
    });
  });

  describe('recordPaidPeriod', () => {
    const payment = {
      id: 'pay-1',
      subscriptionId: 'sub-1',
      billingInterval: BillingInterval.MONTHLY,
      periodStart: new Date('2026-07-10T00:00:00.000Z'),
      periodEnd: new Date('2026-08-10T00:00:00.000Z'),
    };
    let allocate: jest.SpyInstance;

    beforeEach(() => {
      allocate = jest
        .spyOn(service, 'allocateScheduledMonth')
        .mockResolvedValue('ALLOCATED');
      tx.creditAllocationSchedule.findMany.mockResolvedValue([
        { id: 'month-1' },
      ] as never);
    });
    afterEach(() => allocate.mockRestore());

    it('schedules the one month of a monthly payment and allocates it in the same transaction', async () => {
      const now = new Date('2026-07-10T00:00:05.000Z');

      await expect(
        service.recordPaidPeriod(tx, 'user-1', payment, now),
      ).resolves.toBe(1);

      expect(tx.creditAllocationSchedule.createMany.mock.calls).toEqual([
        [
          {
            data: [
              {
                authId: 'user-1',
                subscriptionId: 'sub-1',
                paymentId: 'pay-1',
                periodStart: payment.periodStart,
                periodEnd: payment.periodEnd,
              },
            ],
            skipDuplicates: true,
          },
        ],
      ]);
      expect(allocate.mock.calls).toEqual([[tx, 'month-1', now]]);
    });

    it('schedules twelve months of a yearly payment but allocates only the first (and any month already begun)', async () => {
      const yearly = {
        ...payment,
        billingInterval: BillingInterval.YEARLY,
        periodEnd: new Date('2027-07-10T00:00:00.000Z'),
      };
      const now = new Date('2026-07-10T00:00:05.000Z');

      await service.recordPaidPeriod(tx, 'user-1', yearly, now);

      const rows = tx.creditAllocationSchedule.createMany.mock.calls[0]?.[0]
        ?.data as { periodStart: Date; periodEnd: Date }[];
      expect(rows).toHaveLength(12);
      expect(rows[1]).toMatchObject({
        periodStart: new Date('2026-08-10T00:00:00.000Z'),
        periodEnd: new Date('2026-09-10T00:00:00.000Z'),
      });
      expect(
        tx.creditAllocationSchedule.findMany.mock.calls[0]?.[0]?.where,
      ).toEqual({
        paymentId: 'pay-1',
        status: 'PENDING',
        OR: [
          { periodStart: yearly.periodStart },
          { periodStart: { lte: now } },
        ],
      });
      expect(allocate.mock.calls).toHaveLength(1);
    });

    it('schedules nothing for an empty period', async () => {
      await expect(
        service.recordPaidPeriod(
          tx,
          'user-1',
          { ...payment, periodEnd: payment.periodStart },
          payment.periodStart,
        ),
      ).resolves.toBe(0);
      expect(tx.creditAllocationSchedule.createMany.mock.calls).toHaveLength(0);
    });
  });

  describe('allocateScheduledMonth', () => {
    const month = {
      id: 'month-2',
      authId: 'user-1',
      subscriptionId: 'sub-1',
      paymentId: 'pay-1',
      periodStart: new Date('2026-08-10T00:00:00.000Z'),
      periodEnd: new Date('2026-09-10T00:00:00.000Z'),
      status: 'PENDING',
      payment: { status: 'SUCCEEDED' },
    };
    const term = {
      trialUsed: false,
      trialStartedAt: null,
      trialExpiresAt: null,
      billingInterval: BillingInterval.YEARLY,
      proStartedAt: new Date('2026-07-10T00:00:00.000Z'),
      proExpiresAt: new Date('2027-07-10T00:00:00.000Z'),
      proCanceledAt: null,
    };

    beforeEach(() => {
      tx.$queryRaw.mockResolvedValue([{ id: 'month-2' }] as never);
      tx.creditAllocationSchedule.findUniqueOrThrow.mockResolvedValue(
        month as never,
      );
      tx.userSubscription.findUnique.mockResolvedValue(term as never);
      settings.getSettings.mockResolvedValue({
        proMonthlyCredits: 1000,
      } as never);
      wallet.grant.mockResolvedValue({
        replayed: false,
        allocation: { id: 'alloc-2' },
      } as GrantCreditsResult);
    });

    it('lets a worker skip a month another worker holds (FOR UPDATE SKIP LOCKED), and does nothing if it is not PENDING', async () => {
      tx.$queryRaw.mockResolvedValue([] as never);

      await expect(
        service.allocateScheduledMonth(tx, 'month-2', month.periodStart, {
          skipLocked: true,
        }),
      ).resolves.toBe('NOT_PENDING');

      const [strings, id, lockMode] = tx.$queryRaw.mock.calls[0] as unknown as [
        string[],
        string,
        Prisma.Sql,
      ];
      expect(strings.join('?')).toMatch(/"status" = 'PENDING'\s+FOR UPDATE \?/);
      expect(id).toBe('month-2');
      expect(lockMode.sql).toBe('SKIP LOCKED');
      expect(wallet.grant.mock.calls).toHaveLength(0);
    });

    it("makes a user's request wait for a month being allocated (plain FOR UPDATE)", async () => {
      tx.$queryRaw.mockResolvedValue([] as never);

      await service.allocateScheduledMonth(tx, 'month-2', month.periodStart);

      const lockMode = tx.$queryRaw.mock.calls[0]?.[2] as unknown as Prisma.Sql;
      expect(lockMode.sql).toBe('');
    });

    it("allocates the month's credits, linked to its payment, and marks it ALLOCATED", async () => {
      const now = new Date('2026-08-10T00:01:00.000Z');

      await expect(
        service.allocateScheduledMonth(tx, 'month-2', now),
      ).resolves.toBe('ALLOCATED');

      expect(wallet.grant.mock.calls).toEqual([
        [
          {
            authId: 'user-1',
            source: CreditSource.SUBSCRIPTION,
            sourceReference: 'payment:pay-1:2026-08-10T00:00:00.000Z',
            amount: 1000,
            expiresAt: month.periodEnd,
            description: 'Monthly Pro credits',
            keepExistingGrant: true,
            payment: {
              subscriptionId: 'sub-1',
              paymentId: 'pay-1',
              periodStart: month.periodStart,
            },
          },
          { tx, at: now },
        ],
      ]);
      expect(tx.creditAllocationSchedule.update.mock.calls).toEqual([
        [
          {
            where: { id: 'month-2' },
            data: {
              status: 'ALLOCATED',
              allocationId: 'alloc-2',
              processedAt: now,
            },
          },
        ],
      ]);
    });

    it('allocates a month that ended while nothing ran as of its start', async () => {
      const now = new Date('2026-10-01T00:00:00.000Z');
      await service.allocateScheduledMonth(tx, 'month-2', now);
      expect(wallet.grant.mock.calls[0]?.[1]).toEqual({
        tx,
        at: month.periodStart,
      });
    });

    it.each([
      [
        'its payment is no longer SUCCEEDED (refunded)',
        () =>
          tx.creditAllocationSchedule.findUniqueOrThrow.mockResolvedValue({
            ...month,
            payment: { status: 'REFUNDED' },
          } as never),
        'PAYMENT_NOT_SUCCEEDED',
      ],
      [
        'the paid term ended before the month',
        () =>
          tx.userSubscription.findUnique.mockResolvedValue({
            ...term,
            proExpiresAt: month.periodStart,
          } as never),
        'OUTSIDE_PAID_TERM',
      ],
      [
        'there is no paid term',
        () => tx.userSubscription.findUnique.mockResolvedValue(null),
        'OUTSIDE_PAID_TERM',
      ],
    ])(
      'skips the month when %s, granting nothing',
      async (_case, given, reason) => {
        given();
        const now = new Date('2026-08-10T00:01:00.000Z');

        await expect(
          service.allocateScheduledMonth(tx, 'month-2', now),
        ).resolves.toBe('SKIPPED');

        expect(wallet.grant.mock.calls).toHaveLength(0);
        expect(tx.creditAllocationSchedule.update.mock.calls[0]?.[0]).toEqual({
          where: { id: 'month-2' },
          data: { status: 'SKIPPED', skipReason: reason, processedAt: now },
        });
      },
    );
  });

  describe('allocateDueMonths', () => {
    const now = new Date('2026-09-10T00:00:30.000Z');
    let allocate: jest.SpyInstance;

    beforeEach(() => {
      prisma.$transaction.mockImplementation(((
        callback: (client: PrismaService) => Promise<unknown>,
      ) => callback(prisma)) as never);
      allocate = jest.spyOn(service, 'allocateScheduledMonth');
      wallet.expireCredits.mockResolvedValue(1);
    });
    afterEach(() => allocate.mockRestore());

    it('allocates the months that have begun, oldest first, each in its own transaction', async () => {
      prisma.creditAllocationSchedule.findMany.mockResolvedValue([
        {
          id: 'm-1',
          authId: 'u-1',
          periodEnd: new Date('2026-09-01T00:00:00.000Z'),
        },
        {
          id: 'm-2',
          authId: 'u-2',
          periodEnd: new Date('2026-10-10T00:00:00.000Z'),
        },
        {
          id: 'm-3',
          authId: 'u-3',
          periodEnd: new Date('2026-10-10T00:00:00.000Z'),
        },
      ] as never);
      allocate
        .mockResolvedValueOnce('ALLOCATED')
        .mockResolvedValueOnce('SKIPPED')
        .mockResolvedValueOnce('NOT_PENDING');

      await expect(
        service.allocateDueMonths({ now, limit: 50, exclude: ['m-0'] }),
      ).resolves.toEqual({
        allocated: 1,
        skipped: 1,
        notPending: 1,
        failed: 0,
        processed: ['m-1', 'm-2', 'm-3'],
      });
      expect(
        prisma.creditAllocationSchedule.findMany.mock.calls[0]?.[0],
      ).toEqual({
        where: {
          status: 'PENDING',
          periodStart: { lte: now },
          id: { notIn: ['m-0'] },
        },
        orderBy: [{ periodStart: 'asc' }, { id: 'asc' }],
        take: 50,
        select: { id: true, authId: true, periodEnd: true },
      });
      expect(prisma.$transaction.mock.calls).toHaveLength(3);
      // m-1 had already ended: its expiry is recorded right away.
      expect(wallet.expireCredits.mock.calls).toEqual([['u-1']]);
    });

    it('keeps a failed month PENDING with its attempt and error, and goes on', async () => {
      prisma.creditAllocationSchedule.findMany.mockResolvedValue([
        {
          id: 'm-1',
          authId: 'u-1',
          periodEnd: new Date('2026-10-10T00:00:00.000Z'),
        },
        {
          id: 'm-2',
          authId: 'u-2',
          periodEnd: new Date('2026-10-10T00:00:00.000Z'),
        },
      ] as never);
      prisma.creditAllocationSchedule.updateMany.mockResolvedValue({
        count: 1,
      });
      allocate
        .mockRejectedValueOnce(new Error('worker stopped'))
        .mockResolvedValueOnce('ALLOCATED');

      await expect(service.allocateDueMonths({ now })).resolves.toMatchObject({
        allocated: 1,
        failed: 1,
      });
      expect(prisma.creditAllocationSchedule.updateMany.mock.calls).toEqual([
        [
          {
            where: { id: 'm-1', status: 'PENDING' },
            data: { attempts: { increment: 1 }, lastError: 'worker stopped' },
          },
        ],
      ]);
    });
  });

  describe('catchUpPaidMonths (payments recorded before months were scheduled)', () => {
    const now = new Date('2026-07-20T00:00:00.000Z');
    const term = {
      trialUsed: false,
      trialStartedAt: null,
      trialExpiresAt: null,
      billingInterval: BillingInterval.YEARLY,
      proStartedAt: new Date('2026-06-10T00:00:00.000Z'),
      proExpiresAt: new Date('2027-06-10T00:00:00.000Z'),
      proCanceledAt: null,
    };
    let due: jest.SpyInstance;

    beforeEach(() => {
      due = jest.spyOn(service, 'allocateDueMonths').mockResolvedValue({
        allocated: 1,
        skipped: 0,
        notPending: 0,
        failed: 0,
        processed: ['m-1'],
      });
    });
    afterEach(() => due.mockRestore());

    it("schedules the unfinished months of the current term's unscheduled payments, then allocates the user's due months", async () => {
      prisma.paymentTransaction.findMany.mockResolvedValue([
        {
          id: 'pay-legacy',
          subscriptionId: 'sub-1',
          billingInterval: BillingInterval.YEARLY,
          periodStart: term.proStartedAt,
          periodEnd: term.proExpiresAt,
        },
      ] as never);

      await expect(
        service.catchUpPaidMonths('user-1', term, now),
      ).resolves.toBe(1);

      expect(
        prisma.paymentTransaction.findMany.mock.calls[0]?.[0]?.where,
      ).toEqual({
        subscription: { authId: 'user-1' },
        status: 'SUCCEEDED',
        event: { is: { type: { in: ['CREATED', 'RENEWED'] } } },
        periodStart: { gte: term.proStartedAt },
        periodEnd: { lte: term.proExpiresAt, gt: now },
        creditSchedule: { none: {} },
      });
      const rows = prisma.creditAllocationSchedule.createMany.mock.calls[0]?.[0]
        ?.data as { periodStart: Date }[];
      // The first month (Jun 10 - Jul 10) is over: 11 months remain.
      expect(rows).toHaveLength(11);
      expect(rows[0].periodStart).toEqual(new Date('2026-07-10T00:00:00.000Z'));
      expect(due.mock.calls).toEqual([[{ authId: 'user-1', now }]]);
    });

    it('schedules nothing without an active paid term', async () => {
      await service.catchUpPaidMonths('user-1', null, now);
      expect(prisma.paymentTransaction.findMany.mock.calls).toHaveLength(0);
      expect(due.mock.calls).toHaveLength(1);
    });
  });

  describe('expireTrialCreditsOnUpgrade', () => {
    it("ends only TRIAL credits, now, in the caller's transaction", async () => {
      wallet.expireSourceNow.mockResolvedValue(1);

      const upgradedAt = new Date('2026-07-03T12:00:00.000Z');
      await expect(
        service.expireTrialCreditsOnUpgrade(tx, 'user-1', upgradedAt),
      ).resolves.toBe(1);

      expect(wallet.expireSourceNow.mock.calls).toEqual([
        [
          'user-1',
          CreditSource.TRIAL,
          TRIAL_CREDITS_ENDED_BY_UPGRADE,
          { tx, at: upgradedAt },
        ],
      ]);
    });
  });
});
