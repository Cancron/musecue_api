import type { CreditSettings } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { PrismaService } from '../common/services/prisma.service';
import { formatUsdMicros } from './credit-settings.constants';
import { CreditSettingsService } from './credit-settings.service';

describe('CreditSettingsService', () => {
  const prisma = mockDeep<PrismaService>();
  const activityLog = mock<ActivityLogService>();
  const logger = mock<CustomLoggerService>();
  const service = new CreditSettingsService(prisma, activityLog, logger);
  const actor = { actionedBy: 'admin-id', ip: '127.0.0.1', userAgent: 'jest' };
  const updatedAt = new Date('2026-11-22T12:00:00.000Z');

  /** The row as the database creates it from its column defaults. */
  const storedSettings = (
    overrides: Partial<CreditSettings> = {},
  ): CreditSettings => ({
    id: 1,
    trialCredits: 50,
    proMonthlyCredits: 1000,
    creditCostUsdMicros: 5000,
    sessionOverageCredits: 5,
    deductionStepMicroCredits: 1000000,
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  });

  /** Makes update behave like the database: apply `data` to the row. */
  const updateAppliesTo = (existing: CreditSettings) =>
    prisma.creditSettings.update.mockImplementation(((args: {
      data: Partial<CreditSettings>;
    }) => Promise.resolve({ ...existing, ...args.data })) as never);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(((
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => callback(prisma)) as never);
    prisma.creditSettings.createMany.mockResolvedValue({ count: 0 });
  });

  describe('defaults stored in PostgreSQL', () => {
    it('inserts the default row at startup without supplying any values, so the column defaults apply', async () => {
      prisma.creditSettings.createMany.mockResolvedValue({ count: 1 });

      await service.onApplicationBootstrap();

      expect(prisma.creditSettings.createMany.mock.calls).toEqual([
        [{ data: [{ id: 1 }], skipDuplicates: true }],
      ]);
      expect(logger.log.mock.calls).toHaveLength(1);
    });

    it('never overwrites a stored row at startup (insert-or-nothing, no update)', async () => {
      prisma.creditSettings.createMany.mockResolvedValue({ count: 0 });

      await service.onApplicationBootstrap();

      expect(prisma.creditSettings.createMany.mock.calls[0]?.[0]).toEqual({
        data: [{ id: 1 }],
        skipDuplicates: true,
      });
      expect(prisma.creditSettings.upsert.mock.calls).toHaveLength(0);
      expect(prisma.creditSettings.update.mock.calls).toHaveLength(0);
      expect(prisma.creditSettings.updateMany.mock.calls).toHaveLength(0);
      expect(logger.log.mock.calls).toHaveLength(0);
    });

    it('fails startup when the defaults cannot be stored', async () => {
      prisma.creditSettings.createMany.mockRejectedValue(
        new Error('relation "CreditSettings" does not exist'),
      );

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        'does not exist',
      );
    });
  });

  describe('reading', () => {
    it('returns the stored row', async () => {
      prisma.creditSettings.findUnique.mockResolvedValue(
        storedSettings({ trialCredits: 75, creditCostUsdMicros: 2500 }),
      );

      await expect(service.getSettings()).resolves.toEqual({
        trialCredits: 75,
        proMonthlyCredits: 1000,
        creditCostUsdMicros: 2500,
        creditCostUsd: '0.0025',
        sessionOverageCredits: 5,
        deductionStepMicroCredits: 1000000,
        deductionStepCredits: '1',
        updatedAt: updatedAt.toISOString(),
      });
      expect(prisma.creditSettings.createMany.mock.calls).toHaveLength(0);
    });

    it('stores the defaults again when the row has been deleted, instead of serving values from code', async () => {
      prisma.creditSettings.findUnique.mockResolvedValue(null);
      prisma.creditSettings.createMany.mockResolvedValue({ count: 1 });
      prisma.creditSettings.findUniqueOrThrow.mockResolvedValue(
        storedSettings(),
      );

      await expect(service.getSettings()).resolves.toMatchObject({
        trialCredits: 50,
        proMonthlyCredits: 1000,
        creditCostUsdMicros: 5000,
        creditCostUsd: '0.005',
        sessionOverageCredits: 5,
        deductionStepMicroCredits: 1000000,
        deductionStepCredits: '1',
      });
      expect(prisma.creditSettings.createMany.mock.calls).toHaveLength(1);
    });

    it('reads through a supplied transaction client', async () => {
      const tx = mockDeep<PrismaService>();
      tx.creditSettings.findUnique.mockResolvedValue(storedSettings());

      await service.getSettings(tx);

      expect(tx.creditSettings.findUnique.mock.calls).toHaveLength(1);
      expect(prisma.creditSettings.findUnique.mock.calls).toHaveLength(0);
    });
  });

  describe('partial updates', () => {
    it.each([
      [{ trialCredits: 60 }],
      [{ proMonthlyCredits: 1500 }],
      [{ creditCostUsdMicros: 4000 }],
      [{ sessionOverageCredits: 0 }],
    ])('writes only %p and keeps the other settings', async (input) => {
      const existing = storedSettings();
      prisma.creditSettings.findUniqueOrThrow.mockResolvedValue(existing);
      updateAppliesTo(existing);

      const result = await service.updateSettings(input, actor);

      expect(prisma.creditSettings.update.mock.calls).toEqual([
        [{ where: { id: 1 }, data: input }],
      ]);
      expect(result).toMatchObject({
        trialCredits: 50,
        proMonthlyCredits: 1000,
        creditCostUsdMicros: 5000,
        sessionOverageCredits: 5,
        deductionStepMicroCredits: 1000000,
        ...input,
      });
    });

    it('makes sure the row exists and locks it before reading the old values', async () => {
      const existing = storedSettings();
      const order: string[] = [];
      prisma.creditSettings.createMany.mockImplementation((() => {
        order.push('ensure');
        return Promise.resolve({ count: 0 });
      }) as never);
      prisma.$queryRaw.mockImplementation((() => {
        order.push('lock');
        return Promise.resolve([]);
      }) as never);
      prisma.creditSettings.findUniqueOrThrow.mockImplementation((() => {
        order.push('read');
        return Promise.resolve(existing);
      }) as never);
      updateAppliesTo(existing);

      await service.updateSettings({ trialCredits: 60 }, actor);

      expect(order).toEqual(['ensure', 'lock', 'read']);
      const lockSql = (
        prisma.$queryRaw.mock.calls[0]?.[0] as unknown as string[]
      ).join('?');
      expect(lockSql).toContain('FOR UPDATE');
    });

    it('ignores undefined fields', async () => {
      const existing = storedSettings();
      prisma.creditSettings.findUniqueOrThrow.mockResolvedValue(existing);
      updateAppliesTo(existing);

      await service.updateSettings(
        { trialCredits: undefined, sessionOverageCredits: 3 },
        actor,
      );

      expect(prisma.creditSettings.update.mock.calls[0]?.[0].data).toEqual({
        sessionOverageCredits: 3,
      });
    });

    it('rejects an update that supplies no fields without touching the database', async () => {
      await expect(service.updateSettings({}, actor)).rejects.toMatchObject({
        status: 400,
      });
      expect(prisma.$transaction.mock.calls).toHaveLength(0);
    });
  });

  describe('audit trail', () => {
    it('records a change to the stored defaults with old and new values', async () => {
      const existing = storedSettings();
      prisma.creditSettings.findUniqueOrThrow.mockResolvedValue(existing);
      updateAppliesTo(existing);

      await service.updateSettings(
        { proMonthlyCredits: 2000, creditCostUsdMicros: 4000 },
        actor,
      );

      expect(activityLog.logActivity.mock.calls).toEqual([
        [
          {
            tableName: 'CreditSettings',
            recordId: '1',
            action: 'update',
            changes: [
              {
                fieldName: 'proMonthlyCredits',
                oldValue: '1000',
                newValue: '2000',
              },
              {
                fieldName: 'creditCostUsdMicros',
                oldValue: '5000',
                newValue: '4000',
              },
            ],
            metadata: actor,
          },
          prisma,
        ],
      ]);
    });

    it('does not write an audit event when nothing actually changes', async () => {
      const existing = storedSettings();
      prisma.creditSettings.findUniqueOrThrow.mockResolvedValue(existing);
      updateAppliesTo(existing);

      await service.updateSettings(
        { trialCredits: 50, creditCostUsdMicros: 5000 },
        actor,
      );

      expect(activityLog.logActivity.mock.calls).toHaveLength(0);
    });

    it('propagates audit failures so the transaction rolls back the change', async () => {
      prisma.creditSettings.findUniqueOrThrow.mockResolvedValue(
        storedSettings(),
      );
      updateAppliesTo(storedSettings());
      activityLog.logActivity.mockRejectedValue(new Error('audit failed'));

      await expect(
        service.updateSettings({ trialCredits: 10 }, actor),
      ).rejects.toThrow('audit failed');
    });
  });
});

describe('formatUsdMicros', () => {
  it.each([
    [5000, '0.005'],
    [2500, '0.0025'],
    [1, '0.000001'],
    [10_000, '0.01'],
    [1_000_000, '1'],
    [1_250_000, '1.25'],
    [0, '0'],
  ])('formats %i micros as $%s', (micros, expected) => {
    expect(formatUsdMicros(micros)).toBe(expected);
  });

  it.each([-1, 0.5, Number.NaN])('rejects %p', (micros) => {
    expect(() => formatUsdMicros(micros)).toThrow(RangeError);
  });
});
