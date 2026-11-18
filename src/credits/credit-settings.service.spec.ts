import type { CreditSettings } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { ActivityLogService } from '../common/services/activity-log.service';
import { PrismaService } from '../common/services/prisma.service';
import {
  CREDIT_SETTINGS_DEFAULTS,
  formatUsdMicros,
} from './credit-settings.constants';
import { CreditSettingsService } from './credit-settings.service';

describe('CreditSettingsService', () => {
  const prisma = mockDeep<PrismaService>();
  const activityLog = mock<ActivityLogService>();
  const service = new CreditSettingsService(prisma, activityLog);
  const actor = { actionedBy: 'admin-id', ip: '127.0.0.1', userAgent: 'jest' };
  const updatedAt = new Date('2026-11-22T12:00:00.000Z');

  const storedSettings = (
    overrides: Partial<CreditSettings> = {},
  ): CreditSettings => ({
    id: 1,
    trialCredits: 50,
    proMonthlyCredits: 1000,
    creditCostUsdMicros: 5000,
    sessionOverageCredits: 5,
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  });

  /** Makes upsert behave like the database: apply `update` or `create`. */
  const upsertAppliesTo = (existing: CreditSettings | null) =>
    prisma.creditSettings.upsert.mockImplementation(((args: {
      create: Partial<CreditSettings>;
      update: Partial<CreditSettings>;
    }) =>
      Promise.resolve(
        existing
          ? { ...existing, ...args.update }
          : storedSettings({ ...args.create }),
      )) as never);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(((
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => callback(prisma)) as never);
  });

  describe('default values', () => {
    it('returns 50 trial credits, 1,000 Pro credits a month, $0.005 per credit and 5 overage credits before anything is saved', async () => {
      prisma.creditSettings.findUnique.mockResolvedValue(null);

      await expect(service.getSettings()).resolves.toEqual({
        trialCredits: 50,
        proMonthlyCredits: 1000,
        creditCostUsdMicros: 5000,
        creditCostUsd: '0.005',
        sessionOverageCredits: 5,
        updatedAt: null,
      });
      expect(prisma.creditSettings.findUnique.mock.calls).toEqual([
        [{ where: { id: 1 } }],
      ]);
    });

    it('returns the persisted configuration once saved', async () => {
      prisma.creditSettings.findUnique.mockResolvedValue(
        storedSettings({ trialCredits: 75, creditCostUsdMicros: 2500 }),
      );

      await expect(service.getSettings()).resolves.toMatchObject({
        trialCredits: 75,
        creditCostUsdMicros: 2500,
        creditCostUsd: '0.0025',
        updatedAt: updatedAt.toISOString(),
      });
    });

    it('reads through a supplied transaction client', async () => {
      const tx = mockDeep<PrismaService>();
      tx.creditSettings.findUnique.mockResolvedValue(null);

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
      prisma.creditSettings.findUnique.mockResolvedValue(existing);
      upsertAppliesTo(existing);

      const result = await service.updateSettings(input, actor);

      expect(prisma.creditSettings.upsert.mock.calls).toEqual([
        [{ where: { id: 1 }, create: { id: 1, ...input }, update: input }],
      ]);
      expect(result).toMatchObject({
        ...CREDIT_SETTINGS_DEFAULTS,
        ...input,
        updatedAt: updatedAt.toISOString(),
      });
    });

    it('ignores undefined fields', async () => {
      const existing = storedSettings();
      prisma.creditSettings.findUnique.mockResolvedValue(existing);
      upsertAppliesTo(existing);

      await service.updateSettings(
        { trialCredits: undefined, sessionOverageCredits: 3 },
        actor,
      );

      expect(prisma.creditSettings.upsert.mock.calls[0]?.[0].update).toEqual({
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
    it('records the first save as a create, diffed against the defaults', async () => {
      prisma.creditSettings.findUnique.mockResolvedValue(null);
      upsertAppliesTo(null);

      await service.updateSettings(
        { proMonthlyCredits: 2000, creditCostUsdMicros: 4000 },
        actor,
      );

      expect(activityLog.logActivity.mock.calls).toEqual([
        [
          {
            tableName: 'CreditSettings',
            recordId: '1',
            action: 'create',
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

    it('records later saves as updates with old and new values', async () => {
      const existing = storedSettings({ sessionOverageCredits: 8 });
      prisma.creditSettings.findUnique.mockResolvedValue(existing);
      upsertAppliesTo(existing);

      await service.updateSettings({ sessionOverageCredits: 2 }, actor);

      expect(activityLog.logActivity.mock.calls[0]?.[0]).toMatchObject({
        action: 'update',
        changes: [
          {
            fieldName: 'sessionOverageCredits',
            oldValue: '8',
            newValue: '2',
          },
        ],
      });
    });

    it('does not write an audit event when nothing actually changes', async () => {
      const existing = storedSettings();
      prisma.creditSettings.findUnique.mockResolvedValue(existing);
      upsertAppliesTo(existing);

      await service.updateSettings(
        { trialCredits: 50, creditCostUsdMicros: 5000 },
        actor,
      );

      expect(activityLog.logActivity.mock.calls).toHaveLength(0);
    });

    it('propagates audit failures so the transaction rolls back the change', async () => {
      prisma.creditSettings.findUnique.mockResolvedValue(storedSettings());
      upsertAppliesTo(storedSettings());
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
