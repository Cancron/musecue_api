import type { DailyRewardSettings } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { PrismaService } from '../common/services/prisma.service';
import { DailyRewardSettingsService } from './daily-reward-settings.service';

describe('DailyRewardSettingsService', () => {
  const prisma = mockDeep<PrismaService>();
  const activityLog = mock<ActivityLogService>();
  const logger = mock<CustomLoggerService>();
  const service = new DailyRewardSettingsService(prisma, activityLog, logger);
  const actor = { actionedBy: 'admin-id', ip: '127.0.0.1', userAgent: 'jest' };
  const updatedAt = new Date('2026-11-30T12:00:00.000Z');

  /** The row as the database creates it from its column defaults. */
  const storedSettings = (
    overrides: Partial<DailyRewardSettings> = {},
  ): DailyRewardSettings => ({
    id: 1,
    startingRewardCredits: 10,
    dailyIncrementCredits: 10,
    maxDailyRewardCredits: 50,
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  });

  const updateAppliesTo = (existing: DailyRewardSettings) =>
    prisma.dailyRewardSettings.update.mockImplementation(((args: {
      data: Partial<DailyRewardSettings>;
    }) => Promise.resolve({ ...existing, ...args.data })) as never);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(((
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => callback(prisma)) as never);
    prisma.dailyRewardSettings.createMany.mockResolvedValue({ count: 0 });
  });

  describe('defaults stored in PostgreSQL', () => {
    it('inserts the default row at startup from the column defaults, never overwriting', async () => {
      prisma.dailyRewardSettings.createMany.mockResolvedValue({ count: 1 });

      await service.onApplicationBootstrap();

      expect(prisma.dailyRewardSettings.createMany.mock.calls).toEqual([
        [{ data: [{ id: 1 }], skipDuplicates: true }],
      ]);
      expect(prisma.dailyRewardSettings.upsert.mock.calls).toHaveLength(0);
      expect(prisma.dailyRewardSettings.update.mock.calls).toHaveLength(0);
      expect(logger.log.mock.calls).toHaveLength(1);
    });

    it('serves the defaults with the fixed 600-credit monthly cap', async () => {
      prisma.dailyRewardSettings.findUnique.mockResolvedValue(storedSettings());

      await expect(service.getSettings()).resolves.toEqual({
        startingRewardCredits: 10,
        dailyIncrementCredits: 10,
        maxDailyRewardCredits: 50,
        monthlyCapCredits: 600,
        updatedAt: updatedAt.toISOString(),
      });
    });

    it('stores the defaults again if the row was deleted', async () => {
      prisma.dailyRewardSettings.findUnique.mockResolvedValue(null);
      prisma.dailyRewardSettings.findUniqueOrThrow.mockResolvedValue(
        storedSettings(),
      );

      await expect(service.getSettings()).resolves.toMatchObject({
        startingRewardCredits: 10,
      });
      expect(prisma.dailyRewardSettings.createMany.mock.calls).toHaveLength(1);
    });
  });

  describe('updateSettings', () => {
    it('locks the row, writes only the supplied fields and audits the change', async () => {
      const before = storedSettings();
      prisma.dailyRewardSettings.findUniqueOrThrow.mockResolvedValue(before);
      updateAppliesTo(before);

      const view = await service.updateSettings(
        { startingRewardCredits: 5, maxDailyRewardCredits: 100 },
        actor,
      );

      expect(prisma.$queryRaw.mock.calls).toHaveLength(1);
      expect(prisma.dailyRewardSettings.update.mock.calls[0]?.[0]).toEqual({
        where: { id: 1 },
        data: { startingRewardCredits: 5, maxDailyRewardCredits: 100 },
      });
      expect(view).toMatchObject({
        startingRewardCredits: 5,
        dailyIncrementCredits: 10,
        maxDailyRewardCredits: 100,
        monthlyCapCredits: 600,
      });
      expect(activityLog.logActivity.mock.calls[0]?.[0]).toEqual({
        tableName: 'DailyRewardSettings',
        recordId: '1',
        action: 'update',
        changes: [
          { fieldName: 'startingRewardCredits', oldValue: '10', newValue: '5' },
          {
            fieldName: 'maxDailyRewardCredits',
            oldValue: '50',
            newValue: '100',
          },
        ],
        metadata: actor,
      });
    });

    it.each([
      [
        'a starting reward above the stored maximum',
        { startingRewardCredits: 60 },
        'startingRewardCredits (60) cannot exceed maxDailyRewardCredits (50)',
      ],
      [
        'a maximum below the stored starting reward',
        { maxDailyRewardCredits: 5 },
        'startingRewardCredits (10) cannot exceed maxDailyRewardCredits (5)',
      ],
      [
        'a starting reward above the maximum in the same request',
        { startingRewardCredits: 100, maxDailyRewardCredits: 80 },
        'startingRewardCredits (100) cannot exceed maxDailyRewardCredits (80)',
      ],
    ])(
      'rejects %s against the locked stored values and writes nothing',
      async (_case, input, message) => {
        prisma.dailyRewardSettings.findUniqueOrThrow.mockResolvedValue(
          storedSettings(),
        );

        await expect(
          service.updateSettings(input, actor),
        ).rejects.toMatchObject({ status: 400, message });
        expect(prisma.$queryRaw.mock.calls).toHaveLength(1);
        expect(prisma.dailyRewardSettings.update.mock.calls).toHaveLength(0);
        expect(activityLog.logActivity.mock.calls).toHaveLength(0);
      },
    );

    it('accepts a starting reward above the old maximum when the maximum rises in the same request', async () => {
      const before = storedSettings();
      prisma.dailyRewardSettings.findUniqueOrThrow.mockResolvedValue(before);
      updateAppliesTo(before);

      await expect(
        service.updateSettings(
          { startingRewardCredits: 80, maxDailyRewardCredits: 120 },
          actor,
        ),
      ).resolves.toMatchObject({
        startingRewardCredits: 80,
        maxDailyRewardCredits: 120,
      });
    });

    it('does not record an audit event when nothing changes', async () => {
      const before = storedSettings();
      prisma.dailyRewardSettings.findUniqueOrThrow.mockResolvedValue(before);
      updateAppliesTo(before);

      await service.updateSettings({ dailyIncrementCredits: 10 }, actor);

      expect(activityLog.logActivity.mock.calls).toHaveLength(0);
    });

    it('rejects an update without any setting and touches nothing', async () => {
      await expect(service.updateSettings({}, actor)).rejects.toMatchObject({
        status: 400,
      });
      expect(prisma.$transaction.mock.calls).toHaveLength(0);
    });
  });
});
