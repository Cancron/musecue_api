import { PlanCode, type SubscriptionPlan } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { ActivityLogService } from '../common/services/activity-log.service';
import { PrismaService } from '../common/services/prisma.service';
import { SubscriptionPlanService } from './subscription-plan.service';

describe('SubscriptionPlanService', () => {
  const prisma = mockDeep<PrismaService>();
  const activityLog = mock<ActivityLogService>();
  const service = new SubscriptionPlanService(prisma, activityLog);
  const actor = { actionedBy: 'admin-id', ip: '127.0.0.1', userAgent: 'jest' };
  const updatedAt = new Date('2026-09-12T12:00:00.000Z');

  const storedPlan = (
    overrides: Partial<SubscriptionPlan> = {},
  ): SubscriptionPlan => ({
    code: PlanCode.PRO,
    planEnabled: true,
    monthlyPriceUsdCents: 1900,
    yearlyPriceUsdCents: 19000,
    trialEnabled: true,
    trialDays: 7,
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  });

  /** Makes upsert behave like the database: apply `update` or `create`. */
  const upsertAppliesTo = (existing: SubscriptionPlan | null) =>
    prisma.subscriptionPlan.upsert.mockImplementation(((args: {
      create: Partial<SubscriptionPlan>;
      update: Partial<SubscriptionPlan>;
    }) =>
      Promise.resolve(
        existing
          ? { ...existing, ...args.update }
          : storedPlan({ ...args.create }),
      )) as never);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(((
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => callback(prisma)) as never);
  });

  describe('default values', () => {
    it('returns $19 monthly, $190 yearly, an enabled plan and an enabled 7-day trial before anything is saved', async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue(null);

      await expect(service.getProPlan()).resolves.toEqual({
        code: 'PRO',
        currency: 'USD',
        planEnabled: true,
        monthlyPriceUsdCents: 1900,
        yearlyPriceUsdCents: 19000,
        trialEnabled: true,
        trialDays: 7,
        updatedAt: null,
      });
    });

    it('returns the persisted configuration once saved', async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue(
        storedPlan({ monthlyPriceUsdCents: 2500, trialEnabled: false }),
      );

      await expect(service.getProPlan()).resolves.toMatchObject({
        monthlyPriceUsdCents: 2500,
        trialEnabled: false,
        updatedAt: updatedAt.toISOString(),
      });
    });
  });

  describe('partial updates', () => {
    it.each([
      [{ monthlyPriceUsdCents: 2900 }],
      [{ yearlyPriceUsdCents: 29000 }],
      [{ trialDays: 14 }],
      [{ planEnabled: false }],
      [{ trialEnabled: false }],
    ])('writes only %p and keeps the other settings', async (input) => {
      const existing = storedPlan();
      prisma.subscriptionPlan.findUnique.mockResolvedValue(existing);
      upsertAppliesTo(existing);

      const result = await service.updateProPlan(input, actor);

      expect(prisma.subscriptionPlan.upsert.mock.calls).toEqual([
        [
          {
            where: { code: PlanCode.PRO },
            create: { code: PlanCode.PRO, ...input },
            update: input,
          },
        ],
      ]);
      expect(result).toEqual({
        code: 'PRO',
        currency: 'USD',
        planEnabled: true,
        monthlyPriceUsdCents: 1900,
        yearlyPriceUsdCents: 19000,
        trialEnabled: true,
        trialDays: 7,
        ...input,
        updatedAt: updatedAt.toISOString(),
      });
    });

    it('ignores undefined fields', async () => {
      const existing = storedPlan();
      prisma.subscriptionPlan.findUnique.mockResolvedValue(existing);
      upsertAppliesTo(existing);

      await service.updateProPlan(
        { monthlyPriceUsdCents: undefined, trialDays: 10 },
        actor,
      );

      expect(prisma.subscriptionPlan.upsert.mock.calls[0]?.[0].update).toEqual({
        trialDays: 10,
      });
    });

    it('rejects an update that supplies no fields', async () => {
      await expect(service.updateProPlan({}, actor)).rejects.toMatchObject({
        status: 400,
      });
      expect(prisma.$transaction.mock.calls).toHaveLength(0);
    });
  });

  describe('enable/disable', () => {
    it('disabling the trial keeps its length so re-enabling restores it', async () => {
      const existing = storedPlan({ trialDays: 14 });
      prisma.subscriptionPlan.findUnique.mockResolvedValue(existing);
      upsertAppliesTo(existing);

      await expect(
        service.updateProPlan({ trialEnabled: false }, actor),
      ).resolves.toMatchObject({ trialEnabled: false, trialDays: 14 });
    });

    it('disabling the plan keeps its prices and trial settings', async () => {
      const existing = storedPlan({ monthlyPriceUsdCents: 2500 });
      prisma.subscriptionPlan.findUnique.mockResolvedValue(existing);
      upsertAppliesTo(existing);

      await expect(
        service.updateProPlan({ planEnabled: false }, actor),
      ).resolves.toMatchObject({
        planEnabled: false,
        monthlyPriceUsdCents: 2500,
        yearlyPriceUsdCents: 19000,
        trialEnabled: true,
        trialDays: 7,
      });
    });
  });

  describe('audit trail', () => {
    it('records the first save as a create, diffed against the defaults', async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue(null);
      upsertAppliesTo(null);

      await service.updateProPlan(
        { yearlyPriceUsdCents: 17000, trialEnabled: false },
        actor,
      );

      expect(activityLog.logActivity.mock.calls).toEqual([
        [
          {
            tableName: 'SubscriptionPlan',
            recordId: 'PRO',
            action: 'create',
            changes: [
              {
                fieldName: 'yearlyPriceUsdCents',
                oldValue: '19000',
                newValue: '17000',
              },
              {
                fieldName: 'trialEnabled',
                oldValue: 'true',
                newValue: 'false',
              },
            ],
            metadata: actor,
          },
          prisma,
        ],
      ]);
    });

    it('records later saves as updates with old and new values', async () => {
      const existing = storedPlan({ planEnabled: false });
      prisma.subscriptionPlan.findUnique.mockResolvedValue(existing);
      upsertAppliesTo(existing);

      await service.updateProPlan({ planEnabled: true }, actor);

      expect(activityLog.logActivity.mock.calls[0]?.[0]).toMatchObject({
        action: 'update',
        changes: [
          { fieldName: 'planEnabled', oldValue: 'false', newValue: 'true' },
        ],
      });
    });

    it('does not write an audit event when nothing actually changes', async () => {
      const existing = storedPlan();
      prisma.subscriptionPlan.findUnique.mockResolvedValue(existing);
      upsertAppliesTo(existing);

      await service.updateProPlan(
        { monthlyPriceUsdCents: 1900, trialEnabled: true },
        actor,
      );

      expect(activityLog.logActivity.mock.calls).toHaveLength(0);
    });

    it('propagates audit failures so the transaction rolls back the change', async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue(storedPlan());
      upsertAppliesTo(storedPlan());
      activityLog.logActivity.mockRejectedValue(new Error('audit failed'));

      await expect(
        service.updateProPlan({ monthlyPriceUsdCents: 500 }, actor),
      ).rejects.toThrow('audit failed');
    });
  });
});
