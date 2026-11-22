import type { DiscountSettings } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { PrismaService } from '../common/services/prisma.service';
import { DiscountSettingsService } from './discount-settings.service';

describe('DiscountSettingsService', () => {
  const prisma = mockDeep<PrismaService>();
  const activityLog = mock<ActivityLogService>();
  const logger = mock<CustomLoggerService>();
  const service = new DiscountSettingsService(prisma, activityLog, logger);
  const actor = { actionedBy: 'admin-id', ip: '127.0.0.1', userAgent: 'jest' };
  const updatedAt = new Date('2026-11-30T12:00:00.000Z');

  /** The row as the database creates it from its column defaults. */
  const storedSettings = (
    overrides: Partial<DiscountSettings> = {},
  ): DiscountSettings => ({
    id: 1,
    firstPurchaseDiscountPercent: 0,
    referralDiscountPercent: 0,
    referrerRewardCredits: 0,
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  });

  /** Makes update behave like the database: apply `data` to the row. */
  const updateAppliesTo = (existing: DiscountSettings) =>
    prisma.discountSettings.update.mockImplementation(((args: {
      data: Partial<DiscountSettings>;
    }) => Promise.resolve({ ...existing, ...args.data })) as never);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(((
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => callback(prisma)) as never);
    prisma.discountSettings.createMany.mockResolvedValue({ count: 0 });
  });

  describe('defaults stored in PostgreSQL', () => {
    it('inserts the default row at startup without supplying any values, so the column defaults (0) apply', async () => {
      prisma.discountSettings.createMany.mockResolvedValue({ count: 1 });

      await service.onApplicationBootstrap();

      expect(prisma.discountSettings.createMany.mock.calls).toEqual([
        [{ data: [{ id: 1 }], skipDuplicates: true }],
      ]);
      expect(logger.log.mock.calls).toHaveLength(1);
    });

    it('never overwrites a stored row at startup (insert-or-nothing, no update)', async () => {
      await service.onApplicationBootstrap();

      expect(prisma.discountSettings.upsert.mock.calls).toHaveLength(0);
      expect(prisma.discountSettings.update.mock.calls).toHaveLength(0);
      expect(prisma.discountSettings.updateMany.mock.calls).toHaveLength(0);
      expect(logger.log.mock.calls).toHaveLength(0);
    });

    it('fails startup when the defaults cannot be stored', async () => {
      prisma.discountSettings.createMany.mockRejectedValue(
        new Error('relation "DiscountSettings" does not exist'),
      );
      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        'does not exist',
      );
    });

    it('serves the defaults as every offer switched off', async () => {
      prisma.discountSettings.findUnique.mockResolvedValue(storedSettings());

      await expect(service.getSettings()).resolves.toEqual({
        firstPurchaseDiscountPercent: 0,
        firstPurchaseDiscountActive: false,
        referralDiscountPercent: 0,
        referralDiscountActive: false,
        referrerRewardCredits: 0,
        referrerRewardActive: false,
        updatedAt: updatedAt.toISOString(),
      });
      expect(prisma.discountSettings.createMany.mock.calls).toHaveLength(0);
    });

    it('stores the defaults again if the row was deleted, instead of falling back to values in code', async () => {
      prisma.discountSettings.findUnique.mockResolvedValue(null);
      prisma.discountSettings.findUniqueOrThrow.mockResolvedValue(
        storedSettings(),
      );

      await expect(service.getSettings()).resolves.toMatchObject({
        firstPurchaseDiscountPercent: 0,
      });
      expect(prisma.discountSettings.createMany.mock.calls).toEqual([
        [{ data: [{ id: 1 }], skipDuplicates: true }],
      ]);
    });
  });

  describe('active flags', () => {
    it.each([
      [{ firstPurchaseDiscountPercent: 15 }, [true, false, false]],
      [{ referralDiscountPercent: 100 }, [false, true, false]],
      [{ referrerRewardCredits: 1 }, [false, false, true]],
    ] as const)(
      'marks only offers with a value above 0 as active (%o)',
      async (overrides, [first, referral, reward]) => {
        prisma.discountSettings.findUnique.mockResolvedValue(
          storedSettings(overrides),
        );
        await expect(service.getSettings()).resolves.toMatchObject({
          firstPurchaseDiscountActive: first,
          referralDiscountActive: referral,
          referrerRewardActive: reward,
        });
      },
    );
  });

  describe('updateSettings', () => {
    it('locks the row, writes only the supplied fields and audits old and new values in the same transaction', async () => {
      const before = storedSettings();
      prisma.discountSettings.findUniqueOrThrow.mockResolvedValue(before);
      updateAppliesTo(before);

      const view = await service.updateSettings(
        { firstPurchaseDiscountPercent: 20, referrerRewardCredits: 100 },
        actor,
      );

      expect(prisma.$transaction.mock.calls).toHaveLength(1);
      expect(prisma.$queryRaw.mock.calls).toHaveLength(1);
      expect(prisma.discountSettings.update.mock.calls[0]?.[0]).toEqual({
        where: { id: 1 },
        data: { firstPurchaseDiscountPercent: 20, referrerRewardCredits: 100 },
      });
      expect(view).toMatchObject({
        firstPurchaseDiscountPercent: 20,
        firstPurchaseDiscountActive: true,
        referralDiscountPercent: 0,
        referralDiscountActive: false,
        referrerRewardCredits: 100,
        referrerRewardActive: true,
      });
      expect(activityLog.logActivity.mock.calls).toEqual([
        [
          {
            tableName: 'DiscountSettings',
            recordId: '1',
            action: 'update',
            changes: [
              {
                fieldName: 'firstPurchaseDiscountPercent',
                oldValue: '0',
                newValue: '20',
              },
              {
                fieldName: 'referrerRewardCredits',
                oldValue: '0',
                newValue: '100',
              },
            ],
            metadata: actor,
          },
          prisma,
        ],
      ]);
    });

    it('switches an offer off again with 0', async () => {
      const before = storedSettings({ referralDiscountPercent: 10 });
      prisma.discountSettings.findUniqueOrThrow.mockResolvedValue(before);
      updateAppliesTo(before);

      await expect(
        service.updateSettings({ referralDiscountPercent: 0 }, actor),
      ).resolves.toMatchObject({
        referralDiscountPercent: 0,
        referralDiscountActive: false,
      });
    });

    it('does not record an audit event when nothing changes', async () => {
      const before = storedSettings({ referralDiscountPercent: 10 });
      prisma.discountSettings.findUniqueOrThrow.mockResolvedValue(before);
      updateAppliesTo(before);

      await service.updateSettings({ referralDiscountPercent: 10 }, actor);

      expect(activityLog.logActivity.mock.calls).toHaveLength(0);
    });

    it('ignores fields that are not settings', async () => {
      const before = storedSettings();
      prisma.discountSettings.findUniqueOrThrow.mockResolvedValue(before);
      updateAppliesTo(before);

      await service.updateSettings(
        { referralDiscountPercent: 5, id: 2 } as never,
        actor,
      );

      expect(prisma.discountSettings.update.mock.calls[0]?.[0].data).toEqual({
        referralDiscountPercent: 5,
      });
    });

    it('rejects an update without any setting and touches nothing', async () => {
      await expect(service.updateSettings({}, actor)).rejects.toMatchObject({
        status: 400,
      });
      expect(prisma.$transaction.mock.calls).toHaveLength(0);
      expect(prisma.discountSettings.update.mock.calls).toHaveLength(0);
    });

    it('writes nothing when the audit record cannot be stored (same transaction)', async () => {
      const before = storedSettings();
      prisma.discountSettings.findUniqueOrThrow.mockResolvedValue(before);
      updateAppliesTo(before);
      activityLog.logActivity.mockRejectedValue(new Error('audit failed'));

      await expect(
        service.updateSettings({ firstPurchaseDiscountPercent: 5 }, actor),
      ).rejects.toThrow('audit failed');
    });
  });
});
