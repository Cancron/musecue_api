import { BillingInterval, type UserSubscription } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { ActivityLogService } from '../common/services/activity-log.service';
import { PrismaService } from '../common/services/prisma.service';
import type { SubscriptionPlanView } from './interfaces/subscription-plan.interface';
import { SubscriptionPlanService } from './subscription-plan.service';
import { SubscriptionTrialService } from './subscription-trial.service';

describe('SubscriptionTrialService', () => {
  const prisma = mockDeep<PrismaService>();
  const plans = mock<SubscriptionPlanService>();
  const activityLog = mock<ActivityLogService>();
  const service = new SubscriptionTrialService(prisma, plans, activityLog);
  const now = new Date('2026-03-01T09:30:00.000Z');
  const meta = { ip: '127.0.0.1', userAgent: 'jest' };

  const plan = (overrides: Partial<SubscriptionPlanView> = {}) => ({
    code: 'PRO' as const,
    currency: 'USD' as const,
    planEnabled: true,
    monthlyPriceUsdCents: 1900,
    yearlyPriceUsdCents: 19000,
    trialEnabled: true,
    trialDays: 7,
    updatedAt: null,
    ...overrides,
  });

  const emptyRecord = {
    trialUsed: false,
    trialStartedAt: null,
    trialExpiresAt: null,
    billingInterval: null,
    proStartedAt: null,
    proExpiresAt: null,
    proCanceledAt: null,
    paymentProvider: null,
    providerSubscriptionId: null,
  };

  const writes = () => [
    ...prisma.userSubscription.createMany.mock.calls,
    ...prisma.userSubscription.updateMany.mock.calls,
  ];

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(((
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => callback(prisma)) as never);
    prisma.authUser.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      verified: true,
      deletedAt: null,
    } as never);
    plans.getProPlan.mockResolvedValue(plan());
    prisma.userSubscription.findUnique.mockResolvedValue(null);
    prisma.userSubscription.createMany.mockResolvedValue({ count: 1 });
    prisma.userSubscription.updateMany.mockResolvedValue({ count: 1 });
    prisma.userSubscription.findUniqueOrThrow.mockImplementation(((args: {
      where: { authId: string };
    }) =>
      Promise.resolve({
        id: 'sub-1',
        authId: args.where.authId,
        status: 'TRIAL',
        ...emptyRecord,
        trialUsed: true,
        trialStartedAt: now,
        trialExpiresAt: new Date(now.getTime() + 7 * 86_400_000),
        createdAt: now,
        updatedAt: now,
      } satisfies UserSubscription)) as never);
  });

  describe('successful activation', () => {
    it('saves the start date and an expiry of start + trial days, then audits it', async () => {
      await expect(service.activateTrial('user-1', meta, now)).resolves.toEqual(
        {
          status: 'TRIAL',
          hasProAccess: true,
          accessSource: 'TRIAL',
          accessExpiresAt: '2026-03-08T09:30:00.000Z',
          trialStartedAt: '2026-03-01T09:30:00.000Z',
          trialExpiresAt: '2026-03-08T09:30:00.000Z',
        },
      );

      expect(prisma.userSubscription.createMany.mock.calls).toEqual([
        [{ data: [{ authId: 'user-1' }], skipDuplicates: true }],
      ]);
      expect(prisma.userSubscription.updateMany.mock.calls).toEqual([
        [
          {
            where: {
              authId: 'user-1',
              trialUsed: false,
              trialStartedAt: null,
              proStartedAt: null,
            },
            data: {
              status: 'TRIAL',
              trialUsed: true,
              trialStartedAt: now,
              trialExpiresAt: new Date('2026-03-08T09:30:00.000Z'),
            },
          },
        ],
      ]);
      expect(activityLog.logActivity.mock.calls[0]).toEqual([
        expect.objectContaining({
          tableName: 'UserSubscription',
          recordId: 'sub-1',
          action: 'create',
          metadata: { ...meta, actionedBy: 'user-1' },
        }),
        prisma,
      ]);
    });

    it('uses the configured trial length', async () => {
      plans.getProPlan.mockResolvedValue(plan({ trialDays: 30 }));

      await service.activateTrial('user-1', meta, now);

      expect(
        prisma.userSubscription.updateMany.mock.calls[0]?.[0].data,
      ).toMatchObject({ trialExpiresAt: new Date('2026-03-31T09:30:00.000Z') });
    });

    it('reads the plan inside the activation transaction', async () => {
      await service.activateTrial('user-1', meta, now);
      expect(plans.getProPlan.mock.calls).toEqual([[prisma]]);
    });
  });

  describe('eligible accounts', () => {
    it.each(['INACTIVE', 'SUSPENDED', 'DELETED', 'BLOCKED'])(
      'rejects a %s account with 403 and writes nothing',
      async (status) => {
        prisma.authUser.findUnique.mockResolvedValue({
          status,
          verified: true,
          deletedAt: null,
        } as never);
        await expect(
          service.activateTrial('user-1', meta, now),
        ).rejects.toMatchObject({ status: 403 });
        expect(writes()).toHaveLength(0);
      },
    );

    it.each([
      ['unverified', { verified: false, deletedAt: null }],
      ['soft-deleted', { verified: true, deletedAt: new Date('2026-01-01') }],
    ])(
      'rejects an ACTIVE but %s account with 403 and writes nothing',
      async (_case, account) => {
        prisma.authUser.findUnique.mockResolvedValue({
          status: 'ACTIVE',
          ...account,
        } as never);
        await expect(
          service.activateTrial('user-1', meta, now),
        ).rejects.toMatchObject({
          status: 403,
          message: 'Only active accounts can start a free trial',
        });
        expect(writes()).toHaveLength(0);
      },
    );

    it('reads status, verification and deletion for the eligibility check', async () => {
      await service.activateTrial('user-1', meta, now);
      expect(prisma.authUser.findUnique.mock.calls[0]?.[0]).toEqual({
        where: { id: 'user-1' },
        select: { status: true, verified: true, deletedAt: true },
      });
    });

    it('rejects a user that no longer exists with 401', async () => {
      prisma.authUser.findUnique.mockResolvedValue(null);
      await expect(
        service.activateTrial('user-1', meta, now),
      ).rejects.toMatchObject({ status: 401 });
      expect(writes()).toHaveLength(0);
    });
  });

  describe('disabled settings', () => {
    it.each([[{ trialEnabled: false }], [{ planEnabled: false }]])(
      'rejects activation with 403 when %p',
      async (overrides) => {
        plans.getProPlan.mockResolvedValue(plan(overrides));
        await expect(
          service.activateTrial('user-1', meta, now),
        ).rejects.toMatchObject({
          status: 403,
          message: 'The free trial is not currently available',
        });
        expect(writes()).toHaveLength(0);
      },
    );
  });

  describe('repeated trials and Pro history', () => {
    it('rejects a user whose trial is already used, without writing', async () => {
      prisma.userSubscription.findUnique.mockResolvedValue({
        ...emptyRecord,
        trialUsed: true,
        trialStartedAt: new Date('2026-02-01T00:00:00.000Z'),
        trialExpiresAt: new Date('2026-02-08T00:00:00.000Z'),
      } as never);
      await expect(
        service.activateTrial('user-1', meta, now),
      ).rejects.toMatchObject({
        status: 409,
        message: 'The free trial has already been used',
      });
      expect(writes()).toHaveLength(0);
    });

    it('rejects a user with paid Pro history, without writing', async () => {
      prisma.userSubscription.findUnique.mockResolvedValue({
        ...emptyRecord,
        billingInterval: BillingInterval.MONTHLY,
        proStartedAt: new Date('2025-12-01T00:00:00.000Z'),
        proExpiresAt: new Date('2026-01-01T00:00:00.000Z'),
      } as never);
      await expect(
        service.activateTrial('user-1', meta, now),
      ).rejects.toMatchObject({ status: 409 });
      expect(writes()).toHaveLength(0);
    });

    it('reports a conflict and skips the audit when a concurrent request claimed the trial first', async () => {
      prisma.userSubscription.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          ...emptyRecord,
          trialUsed: true,
          trialStartedAt: now,
          trialExpiresAt: new Date('2026-03-08T09:30:00.000Z'),
        } as never);
      prisma.userSubscription.createMany.mockResolvedValue({ count: 0 });
      prisma.userSubscription.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.activateTrial('user-1', meta, now),
      ).rejects.toMatchObject({ status: 409 });
      expect(activityLog.logActivity.mock.calls).toHaveLength(0);
    });
  });

  describe('failures', () => {
    it('propagates an audit failure so the transaction rolls back the trial', async () => {
      activityLog.logActivity.mockRejectedValue(new Error('audit failed'));
      await expect(service.activateTrial('user-1', meta, now)).rejects.toThrow(
        'audit failed',
      );
    });
  });
});
