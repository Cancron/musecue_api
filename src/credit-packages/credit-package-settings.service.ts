import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { CreditPackage, CreditPackageCode, Prisma } from '@prisma/client';
import AppError from '../common/errors/app.error';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { PrismaService } from '../common/services/prisma.service';
import {
  changedFields,
  pickDefinedFields,
} from '../common/settings/settings-fields';
import {
  CREDIT_PACKAGE_CURRENCY,
  CREDIT_PACKAGE_DEFAULTS,
  formatUsdCents,
  parseCreditPackageCode,
} from './credit-package-settings.constants';
import type {
  CreditPackageChangeActor,
  CreditPackageValues,
  CreditPackageView,
  UpdateCreditPackageInput,
} from './interfaces/credit-package-settings.interface';

const SETTING_FIELDS: readonly (keyof CreditPackageValues)[] = [
  'credits',
  'priceUsdCents',
  'available',
];

/**
 * The administrator-managed credit packages, one PostgreSQL row per package
 * code. Migration 20261130120000_add_promotion_settings stores the defaults
 * (250 credits for $5, 500 for $10, 1,000 for $20), and the application
 * stores a missing package again at startup. Neither ever overwrites a
 * stored package, so administrator changes survive restarts. Packages are
 * withdrawn with `available: false`, never deleted.
 */
@Injectable()
export class CreditPackageSettingsService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLog: ActivityLogService,
    private readonly logger: CustomLoggerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const inserted = await this.ensureDefaults();
    if (inserted > 0) {
      this.logger.log(
        `Stored ${inserted} default credit package(s)`,
        CreditPackageSettingsService.name,
      );
    }
  }

  /**
   * Inserts every default package that is missing (INSERT ... ON CONFLICT
   * DO NOTHING). Returns how many packages were inserted.
   */
  async ensureDefaults(
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<number> {
    const { count } = await client.creditPackage.createMany({
      data: CREDIT_PACKAGE_DEFAULTS.map((pkg) => ({ ...pkg })),
      skipDuplicates: true,
    });
    return count;
  }

  /** Every package, in display order (SMALL, MEDIUM, LARGE). */
  async listPackages(
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<CreditPackageView[]> {
    let stored = await this.findAll(client);
    if (stored.length < CREDIT_PACKAGE_DEFAULTS.length) {
      // Deleted since startup: store the missing defaults again.
      await this.ensureDefaults(client);
      stored = await this.findAll(client);
    }
    return stored.map((pkg) => this.toView(pkg));
  }

  /** One package by its code (route parameter); 404 for an unknown code. */
  async getPackage(
    code: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<CreditPackageView> {
    const packageCode = this.requireCode(code);
    const stored = await client.creditPackage.findUnique({
      where: { code: packageCode },
    });
    if (stored) return this.toView(stored);
    await this.ensureDefaults(client);
    return this.toView(
      await client.creditPackage.findUniqueOrThrow({
        where: { code: packageCode },
      }),
    );
  }

  /**
   * Applies a partial update to one package and records an audit event with
   * the old and new values. The package row is locked for the update, so
   * concurrent changes are applied one at a time and each audit entry has
   * the exact old values. The write and the audit record are committed
   * together.
   */
  async updatePackage(
    code: string,
    input: UpdateCreditPackageInput,
    actor: CreditPackageChangeActor,
  ): Promise<CreditPackageView> {
    const packageCode = this.requireCode(code);
    const data = pickDefinedFields(input, SETTING_FIELDS);
    if (Object.keys(data).length === 0) {
      throw AppError.badRequest(
        `Provide at least one of ${SETTING_FIELDS.join(', ')}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await this.ensureDefaults(tx);
      await tx.$queryRaw`
        SELECT "code" FROM "CreditPackage"
        WHERE "code" = ${packageCode}::"CreditPackageCode" FOR UPDATE
      `;
      const before = await tx.creditPackage.findUniqueOrThrow({
        where: { code: packageCode },
      });
      const after = await tx.creditPackage.update({
        where: { code: packageCode },
        data,
      });

      const changes = changedFields(
        this.values(before),
        this.values(after),
        SETTING_FIELDS,
      );
      if (changes.length > 0) {
        await this.activityLog.logActivity(
          {
            tableName: 'CreditPackage',
            recordId: packageCode,
            action: 'update',
            changes,
            metadata: actor,
          },
          tx,
        );
      }
      return this.toView(after);
    });
  }

  private findAll(client: Prisma.TransactionClient) {
    // Enum columns sort in declaration order: SMALL, MEDIUM, LARGE.
    return client.creditPackage.findMany({ orderBy: { code: 'asc' } });
  }

  private requireCode(code: string): CreditPackageCode {
    const packageCode = parseCreditPackageCode(code);
    if (!packageCode) throw AppError.notFound('Credit package not found');
    return packageCode;
  }

  private values(stored: CreditPackage): CreditPackageValues {
    return {
      credits: stored.credits,
      priceUsdCents: stored.priceUsdCents,
      available: stored.available,
    };
  }

  private toView(stored: CreditPackage): CreditPackageView {
    return {
      code: stored.code,
      currency: CREDIT_PACKAGE_CURRENCY,
      ...this.values(stored),
      priceUsd: formatUsdCents(stored.priceUsdCents),
      updatedAt: stored.updatedAt.toISOString(),
    };
  }
}
