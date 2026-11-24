import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CreditSettings } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { ActivityLogService } from '../common/services/activity-log.service';
import { PrismaService } from '../common/services/prisma.service';
import { CREDIT_SETTINGS_DEFAULTS } from './credit-settings.constants';
import {
  CreditSettingsService,
  formatUsdMicros,
} from './credit-settings.service';

describe('CreditSettingsService', () => {
  const prisma = mockDeep<PrismaService>();
  const activityLog = mock<ActivityLogService>();
  const service = new CreditSettingsService(prisma, activityLog);
  const actor = { actionedBy: 'admin-id', ip: '127.0.0.1', userAgent: 'jest' };
  const updatedAt = new Date('2026-11-22T12:00:00.000Z');

  const storedSettings = (
    overrides: Partial<CreditSettings> = {},
  ): CreditSettings => ({
    id: 'default',
    trialAllowanceCredits: 50,
    proMonthlyAllowanceCredits: 1000,
    openRouterUsdMicrosPerCredit: 5000,
    sessionOverageAllowanceCredits: 5,
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
    it('serves 50 trial credits, 1,000 Pro credits a month, $0.005 per credit and 5 overage credits before anything is saved', async () => {
      prisma.creditSettings.findUnique.mockResolvedValue(null);

      await expect(service.getSettings()).resolves.toEqual({
        trialAllowanceCredits: 50,
        proMonthlyAllowanceCredits: 1000,
        openRouterUsdMicrosPerCredit: 5000,
        openRouterUsdPerCredit: '0.005',
        sessionOverageAllowanceCredits: 5,
        updatedAt: null,
      });
      expect(prisma.creditSettings.upsert.mock.calls).toHaveLength(0);
    });

    it('returns the persisted settings once saved', async () => {
      prisma.creditSettings.findUnique.mockResolvedValue(
        storedSettings({
          trialAllowanceCredits: 75,
          openRouterUsdMicrosPerCredit: 2500,
        }),
      );

      await expect(service.getSettings()).resolves.toMatchObject({
        trialAllowanceCredits: 75,
        openRouterUsdMicrosPerCredit: 2500,
        openRouterUsdPerCredit: '0.0025',
        updatedAt: updatedAt.toISOString(),
      });
    });

    it('reads through a supplied transaction client', async () => {
      const tx = mockDeep<PrismaService>();
      tx.creditSettings.findUnique.mockResolvedValue(null);

      await service.getSettings(tx);

      expect(tx.creditSettings.findUnique.mock.calls).toEqual([
        [{ where: { id: 'default' } }],
      ]);
      expect(prisma.creditSettings.findUnique.mock.calls).toHaveLength(0);
    });

    it('matches the column defaults of the Prisma schema and the migration', () => {
      const root = join(__dirname, '..', '..', 'prisma');
      const schema = readFileSync(
        join(root, 'schema', 'credit.prisma'),
        'utf8',
      );
      const migration = readFileSync(
        join(
          root,
          'migrations',
          '20261122120000_add_credit_settings',
          'migration.sql',
        ),
        'utf8',
      );

      for (const [field, value] of Object.entries(CREDIT_SETTINGS_DEFAULTS)) {
        expect(schema).toMatch(
          new RegExp(`\\b${field}\\s+Int\\s+@default\\(${value}\\)`),
        );
        expect(migration).toMatch(
          new RegExp(`"${field}" INTEGER NOT NULL DEFAULT ${value},`),
        );
      }
    });
  });

  describe('partial updates', () => {
    it.each([
      [{ trialAllowanceCredits: 80 }],
      [{ proMonthlyAllowanceCredits: 2000 }],
      [{ openRouterUsdMicrosPerCredit: 4000 }],
      [{ sessionOverageAllowanceCredits: 10 }],
    ])('writes only %p and keeps the other settings', async (input) => {
      const existing = storedSettings();
      prisma.creditSettings.findUnique.mockResolvedValue(existing);
      upsertAppliesTo(existing);

      const result = await service.updateSettings(input, actor);

      expect(prisma.creditSettings.upsert.mock.calls).toEqual([
        [
          {
            where: { id: 'default' },
            create: { id: 'default', ...input },
            update: input,
          },
        ],
      ]);
      expect(result).toMatchObject({
        trialAllowanceCredits: 50,
        proMonthlyAllowanceCredits: 1000,
        openRouterUsdMicrosPerCredit: 5000,
        sessionOverageAllowanceCredits: 5,
        ...input,
        updatedAt: updatedAt.toISOString(),
      });
    });

    it('ignores undefined fields', async () => {
      const existing = storedSettings();
      prisma.creditSettings.findUnique.mockResolvedValue(existing);
      upsertAppliesTo(existing);

      await service.updateSettings(
        { trialAllowanceCredits: undefined, sessionOverageAllowanceCredits: 0 },
        actor,
      );

      expect(prisma.creditSettings.upsert.mock.calls[0]?.[0].update).toEqual({
        sessionOverageAllowanceCredits: 0,
      });
    });

    it('rejects an update that supplies no fields without opening a transaction', async () => {
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
        {
          proMonthlyAllowanceCredits: 1500,
          openRouterUsdMicrosPerCredit: 4000,
        },
        actor,
      );

      expect(activityLog.logActivity.mock.calls).toEqual([
        [
          {
            tableName: 'CreditSettings',
            recordId: 'default',
            action: 'create',
            changes: [
              {
                fieldName: 'proMonthlyAllowanceCredits',
                oldValue: '1000',
                newValue: '1500',
              },
              {
                fieldName: 'openRouterUsdMicrosPerCredit',
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
      const existing = storedSettings({ trialAllowanceCredits: 60 });
      prisma.creditSettings.findUnique.mockResolvedValue(existing);
      upsertAppliesTo(existing);

      await service.updateSettings({ trialAllowanceCredits: 40 }, actor);

      expect(activityLog.logActivity.mock.calls[0]?.[0]).toMatchObject({
        action: 'update',
        changes: [
          {
            fieldName: 'trialAllowanceCredits',
            oldValue: '60',
            newValue: '40',
          },
        ],
      });
    });

    it('does not write an audit event when nothing actually changes', async () => {
      const existing = storedSettings();
      prisma.creditSettings.findUnique.mockResolvedValue(existing);
      upsertAppliesTo(existing);

      await service.updateSettings({ trialAllowanceCredits: 50 }, actor);

      expect(activityLog.logActivity.mock.calls).toHaveLength(0);
    });

    it('propagates audit failures so the transaction rolls back the change', async () => {
      prisma.creditSettings.findUnique.mockResolvedValue(storedSettings());
      upsertAppliesTo(storedSettings());
      activityLog.logActivity.mockRejectedValue(new Error('audit failed'));

      await expect(
        service.updateSettings({ trialAllowanceCredits: 10 }, actor),
      ).rejects.toThrow('audit failed');
    });
  });

  describe('formatUsdMicros', () => {
    it.each([
      [5000, '0.005'],
      [1, '0.000001'],
      [2500, '0.0025'],
      [10_000, '0.01'],
      [1_000_000, '1'],
      [1_234_500, '1.2345'],
    ])('renders %d micro-dollars as $%s', (micros, dollars) => {
      expect(formatUsdMicros(micros)).toBe(dollars);
    });
  });
});
