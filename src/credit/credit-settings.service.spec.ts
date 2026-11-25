import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CreditSettings } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { PrismaService } from '../common/services/prisma.service';
import {
  CreditSettingsService,
  formatUsdMicros,
} from './credit-settings.service';

const DEFAULTS = {
  trialAllowanceCredits: 50,
  proMonthlyAllowanceCredits: 1000,
  openRouterUsdMicrosPerCredit: 5000,
  sessionOverageAllowanceCredits: 5,
};

describe('CreditSettingsService', () => {
  const prisma = mockDeep<PrismaService>();
  const activityLog = mock<ActivityLogService>();
  const logger = mock<CustomLoggerService>();
  const service = new CreditSettingsService(prisma, activityLog, logger);
  const actor = { actionedBy: 'admin-id', ip: '127.0.0.1', userAgent: 'jest' };
  const updatedAt = new Date('2026-11-22T12:00:00.000Z');

  const storedSettings = (
    overrides: Partial<CreditSettings> = {},
  ): CreditSettings => ({
    id: 'default',
    ...DEFAULTS,
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
    const root = join(__dirname, '..', '..', 'prisma');
    const read = (...path: string[]) =>
      readFileSync(join(root, ...path), 'utf8');

    it('defines 50 / 1,000 / $0.005 (5000 micro-dollars) / 5 as the column defaults in the schema and the table migration', () => {
      const schema = read('schema', 'credit.prisma');
      const migration = read(
        'migrations',
        '20261122120000_add_credit_settings',
        'migration.sql',
      );
      for (const [field, value] of Object.entries(DEFAULTS)) {
        expect(schema).toMatch(
          new RegExp(`\\b${field}\\s+Int\\s+@default\\(${value}\\)`),
        );
        expect(migration).toMatch(
          new RegExp(`"${field}" INTEGER NOT NULL DEFAULT ${value},`),
        );
      }
    });

    it('seeds the configuration row with the column defaults without overwriting an existing row', () => {
      const seed = read(
        'migrations',
        '20261123120000_seed_credit_settings',
        'migration.sql',
      );
      expect(seed).toMatch(
        /INSERT INTO "CreditSettings" \("id", "updatedAt"\)\s+VALUES \('default', CURRENT_TIMESTAMP\)\s+ON CONFLICT \("id"\) DO NOTHING;/,
      );
      expect(seed).not.toMatch(/\bUPDATE\b|DO UPDATE/);
    });

    it('re-creates a missing row at startup with INSERT ... ON CONFLICT DO NOTHING', async () => {
      prisma.creditSettings.createMany.mockResolvedValue({ count: 1 });

      await service.onModuleInit();

      expect(prisma.creditSettings.createMany.mock.calls).toEqual([
        [{ data: [{ id: 'default' }], skipDuplicates: true }],
      ]);
      expect(logger.log.mock.calls).toHaveLength(1);
    });

    it('never updates an existing row at startup, so administrator changes survive restarts', async () => {
      prisma.creditSettings.createMany.mockResolvedValue({ count: 0 });

      await service.onModuleInit();

      expect(prisma.creditSettings.update.mock.calls).toHaveLength(0);
      expect(prisma.creditSettings.upsert.mock.calls).toHaveLength(0);
      expect(logger.log.mock.calls).toHaveLength(0);
    });
  });

  describe('reading', () => {
    it('returns the stored row', async () => {
      prisma.creditSettings.findUnique.mockResolvedValue(
        storedSettings({
          trialAllowanceCredits: 75,
          openRouterUsdMicrosPerCredit: 2500,
        }),
      );

      await expect(service.getSettings()).resolves.toEqual({
        ...DEFAULTS,
        trialAllowanceCredits: 75,
        openRouterUsdMicrosPerCredit: 2500,
        openRouterUsdPerCredit: '0.0025',
        updatedAt: updatedAt.toISOString(),
      });
      expect(prisma.creditSettings.createMany.mock.calls).toHaveLength(0);
    });

    it('re-stores the defaults when the row was deleted, instead of serving values from code', async () => {
      prisma.creditSettings.findUnique.mockResolvedValue(null);
      prisma.creditSettings.findUniqueOrThrow.mockResolvedValue(
        storedSettings(),
      );

      await expect(service.getSettings()).resolves.toMatchObject(DEFAULTS);
      expect(prisma.creditSettings.createMany.mock.calls).toEqual([
        [{ data: [{ id: 'default' }], skipDuplicates: true }],
      ]);
    });

    it('reads through a supplied transaction client', async () => {
      const tx = mockDeep<PrismaService>();
      tx.creditSettings.findUnique.mockResolvedValue(storedSettings());

      await service.getSettings(tx);

      expect(tx.creditSettings.findUnique.mock.calls).toEqual([
        [{ where: { id: 'default' } }],
      ]);
      expect(prisma.creditSettings.findUnique.mock.calls).toHaveLength(0);
    });
  });

  describe('partial updates', () => {
    it.each([
      [{ trialAllowanceCredits: 80 }],
      [{ proMonthlyAllowanceCredits: 2000 }],
      [{ openRouterUsdMicrosPerCredit: 4000 }],
      [{ sessionOverageAllowanceCredits: 10 }],
    ])(
      'locks the row and writes only %p, keeping the other settings',
      async (input) => {
        const existing = storedSettings();
        prisma.creditSettings.findUniqueOrThrow.mockResolvedValue(existing);
        updateAppliesTo(existing);

        const result = await service.updateSettings(input, actor);

        expect(prisma.$queryRaw.mock.calls).toHaveLength(1);
        expect(
          Array.from(
            prisma.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray,
          ).join('?'),
        ).toMatch(/FOR UPDATE/);
        expect(prisma.creditSettings.update.mock.calls).toEqual([
          [{ where: { id: 'default' }, data: input }],
        ]);
        expect(result).toMatchObject({ ...DEFAULTS, ...input });
      },
    );

    it('ignores undefined fields', async () => {
      const existing = storedSettings();
      prisma.creditSettings.findUniqueOrThrow.mockResolvedValue(existing);
      updateAppliesTo(existing);

      await service.updateSettings(
        { trialAllowanceCredits: undefined, sessionOverageAllowanceCredits: 0 },
        actor,
      );

      expect(prisma.creditSettings.update.mock.calls[0]?.[0].data).toEqual({
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
    it('records an update with old and new values', async () => {
      const existing = storedSettings({ trialAllowanceCredits: 60 });
      prisma.creditSettings.findUniqueOrThrow.mockResolvedValue(existing);
      updateAppliesTo(existing);

      await service.updateSettings(
        { trialAllowanceCredits: 40, openRouterUsdMicrosPerCredit: 4000 },
        actor,
      );

      expect(activityLog.logActivity.mock.calls).toEqual([
        [
          {
            tableName: 'CreditSettings',
            recordId: 'default',
            action: 'update',
            changes: [
              {
                fieldName: 'trialAllowanceCredits',
                oldValue: '60',
                newValue: '40',
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

    it('does not write an audit event when nothing actually changes', async () => {
      const existing = storedSettings();
      prisma.creditSettings.findUniqueOrThrow.mockResolvedValue(existing);
      updateAppliesTo(existing);

      await service.updateSettings({ trialAllowanceCredits: 50 }, actor);

      expect(activityLog.logActivity.mock.calls).toHaveLength(0);
    });

    it('propagates audit failures so the transaction rolls back the change', async () => {
      prisma.creditSettings.findUniqueOrThrow.mockResolvedValue(
        storedSettings(),
      );
      updateAppliesTo(storedSettings());
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
