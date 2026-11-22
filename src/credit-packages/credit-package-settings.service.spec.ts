import type { CreditPackage } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { PrismaService } from '../common/services/prisma.service';
import { CreditPackageSettingsService } from './credit-package-settings.service';

describe('CreditPackageSettingsService', () => {
  const prisma = mockDeep<PrismaService>();
  const activityLog = mock<ActivityLogService>();
  const logger = mock<CustomLoggerService>();
  const service = new CreditPackageSettingsService(prisma, activityLog, logger);
  const actor = { actionedBy: 'admin-id', ip: '127.0.0.1', userAgent: 'jest' };
  const updatedAt = new Date('2026-11-30T12:00:00.000Z');

  const pkg = (
    code: CreditPackage['code'],
    credits: number,
    priceUsdCents: number,
    overrides: Partial<CreditPackage> = {},
  ): CreditPackage => ({
    code,
    credits,
    priceUsdCents,
    available: true,
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  });
  const defaults = () => [
    pkg('SMALL', 250, 500),
    pkg('MEDIUM', 500, 1000),
    pkg('LARGE', 1000, 2000),
  ];
  const expectedDefaultInsert = {
    data: [
      { code: 'SMALL', credits: 250, priceUsdCents: 500, available: true },
      { code: 'MEDIUM', credits: 500, priceUsdCents: 1000, available: true },
      { code: 'LARGE', credits: 1000, priceUsdCents: 2000, available: true },
    ],
    skipDuplicates: true,
  };

  const updateAppliesTo = (existing: CreditPackage) =>
    prisma.creditPackage.update.mockImplementation(((args: {
      data: Partial<CreditPackage>;
    }) => Promise.resolve({ ...existing, ...args.data })) as never);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(((
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => callback(prisma)) as never);
    prisma.creditPackage.createMany.mockResolvedValue({ count: 0 });
  });

  describe('defaults stored in PostgreSQL', () => {
    it('inserts any missing default package at startup, never overwriting stored ones', async () => {
      prisma.creditPackage.createMany.mockResolvedValue({ count: 3 });

      await service.onApplicationBootstrap();

      expect(prisma.creditPackage.createMany.mock.calls).toEqual([
        [expectedDefaultInsert],
      ]);
      expect(prisma.creditPackage.upsert.mock.calls).toHaveLength(0);
      expect(prisma.creditPackage.update.mock.calls).toHaveLength(0);
      expect(logger.log.mock.calls).toHaveLength(1);
    });

    it('logs nothing when every package is already stored', async () => {
      await service.onApplicationBootstrap();
      expect(logger.log.mock.calls).toHaveLength(0);
    });

    it('lists the stored packages in display order with dollar prices', async () => {
      prisma.creditPackage.findMany.mockResolvedValue(defaults());

      await expect(service.listPackages()).resolves.toEqual([
        {
          code: 'SMALL',
          currency: 'USD',
          credits: 250,
          priceUsdCents: 500,
          priceUsd: '5.00',
          available: true,
          updatedAt: updatedAt.toISOString(),
        },
        {
          code: 'MEDIUM',
          currency: 'USD',
          credits: 500,
          priceUsdCents: 1000,
          priceUsd: '10.00',
          available: true,
          updatedAt: updatedAt.toISOString(),
        },
        {
          code: 'LARGE',
          currency: 'USD',
          credits: 1000,
          priceUsdCents: 2000,
          priceUsd: '20.00',
          available: true,
          updatedAt: updatedAt.toISOString(),
        },
      ]);
      expect(prisma.creditPackage.findMany.mock.calls[0]?.[0]).toEqual({
        orderBy: { code: 'asc' },
      });
      expect(prisma.creditPackage.createMany.mock.calls).toHaveLength(0);
    });

    it('restores a deleted package with its defaults before listing', async () => {
      prisma.creditPackage.findMany
        .mockResolvedValueOnce(defaults().slice(0, 2))
        .mockResolvedValueOnce(defaults());

      await expect(service.listPackages()).resolves.toHaveLength(3);
      expect(prisma.creditPackage.createMany.mock.calls).toEqual([
        [expectedDefaultInsert],
      ]);
    });
  });

  describe('getPackage', () => {
    it('returns one package by code', async () => {
      prisma.creditPackage.findUnique.mockResolvedValue(
        pkg('MEDIUM', 500, 1000, { available: false }),
      );
      await expect(service.getPackage('MEDIUM')).resolves.toMatchObject({
        code: 'MEDIUM',
        available: false,
      });
    });

    it('answers 404 for an unknown code without querying', async () => {
      await expect(service.getPackage('HUGE')).rejects.toMatchObject({
        status: 404,
      });
      expect(prisma.creditPackage.findUnique.mock.calls).toHaveLength(0);
    });
  });

  describe('updatePackage', () => {
    it('locks the package row, writes only the supplied fields and audits the change', async () => {
      const before = pkg('SMALL', 250, 500);
      prisma.creditPackage.findUniqueOrThrow.mockResolvedValue(before);
      updateAppliesTo(before);

      const view = await service.updatePackage(
        'SMALL',
        { credits: 300, priceUsdCents: 599, available: false },
        actor,
      );

      expect(prisma.$queryRaw.mock.calls).toHaveLength(1);
      expect(prisma.creditPackage.update.mock.calls[0]?.[0]).toEqual({
        where: { code: 'SMALL' },
        data: { credits: 300, priceUsdCents: 599, available: false },
      });
      expect(view).toMatchObject({
        code: 'SMALL',
        credits: 300,
        priceUsdCents: 599,
        priceUsd: '5.99',
        available: false,
      });
      expect(activityLog.logActivity.mock.calls).toEqual([
        [
          {
            tableName: 'CreditPackage',
            recordId: 'SMALL',
            action: 'update',
            changes: [
              { fieldName: 'credits', oldValue: '250', newValue: '300' },
              { fieldName: 'priceUsdCents', oldValue: '500', newValue: '599' },
              { fieldName: 'available', oldValue: 'true', newValue: 'false' },
            ],
            metadata: actor,
          },
          prisma,
        ],
      ]);
    });

    it('does not record an audit event when nothing changes', async () => {
      const before = pkg('LARGE', 1000, 2000);
      prisma.creditPackage.findUniqueOrThrow.mockResolvedValue(before);
      updateAppliesTo(before);

      await service.updatePackage('LARGE', { available: true }, actor);

      expect(activityLog.logActivity.mock.calls).toHaveLength(0);
    });

    it('answers 404 for an unknown code and touches nothing', async () => {
      await expect(
        service.updatePackage('HUGE', { credits: 10 }, actor),
      ).rejects.toMatchObject({ status: 404 });
      expect(prisma.$transaction.mock.calls).toHaveLength(0);
    });

    it('rejects an update without any setting and touches nothing', async () => {
      await expect(
        service.updatePackage('SMALL', {}, actor),
      ).rejects.toMatchObject({ status: 400 });
      expect(prisma.$transaction.mock.calls).toHaveLength(0);
    });
  });
});
