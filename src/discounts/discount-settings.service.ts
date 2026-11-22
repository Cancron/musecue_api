import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { DiscountSettings, Prisma } from '@prisma/client';
import AppError from '../common/errors/app.error';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { PrismaService } from '../common/services/prisma.service';
import {
  changedFields,
  pickDefinedFields,
} from '../common/settings/settings-fields';
import { DISCOUNT_SETTINGS_ID } from './discount-settings.constants';
import type {
  DiscountSettingsChangeActor,
  DiscountSettingsValues,
  DiscountSettingsView,
  UpdateDiscountSettingsInput,
} from './interfaces/discount-settings.interface';

const SETTING_FIELDS: readonly (keyof DiscountSettingsValues)[] = [
  'firstPurchaseDiscountPercent',
  'referralDiscountPercent',
  'referrerRewardCredits',
];

/**
 * The administrator-managed discount and referral configuration, stored as
 * one row in PostgreSQL. The defaults (every offer off, 0) are the table's
 * column defaults: migration 20261130120000_add_promotion_settings stores
 * them, and the application stores them again at startup if the row is
 * missing. Neither ever overwrites a stored row, so administrator changes
 * survive restarts.
 */
@Injectable()
export class DiscountSettingsService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLog: ActivityLogService,
    private readonly logger: CustomLoggerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (await this.ensureDefaults()) {
      this.logger.log(
        'Stored the default discount settings',
        DiscountSettingsService.name,
      );
    }
  }

  /**
   * Inserts the settings row with the column defaults unless it exists
   * (INSERT ... ON CONFLICT DO NOTHING). Returns whether a row was inserted.
   */
  async ensureDefaults(
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<boolean> {
    const { count } = await client.discountSettings.createMany({
      data: [{ id: DISCOUNT_SETTINGS_ID }],
      skipDuplicates: true,
    });
    return count > 0;
  }

  /** Pass a transaction client to read the settings inside that transaction. */
  async getSettings(
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<DiscountSettingsView> {
    const stored = await client.discountSettings.findUnique({
      where: { id: DISCOUNT_SETTINGS_ID },
    });
    if (stored) return this.toView(stored);
    // Deleted since startup: store the defaults again.
    await this.ensureDefaults(client);
    return this.toView(
      await client.discountSettings.findUniqueOrThrow({
        where: { id: DISCOUNT_SETTINGS_ID },
      }),
    );
  }

  /**
   * Applies a partial update and records an audit event with the old and new
   * values. The row is locked for the update, so concurrent changes are
   * applied one at a time and each audit entry has the exact old values.
   * The settings write and the audit record are committed together.
   */
  async updateSettings(
    input: UpdateDiscountSettingsInput,
    actor: DiscountSettingsChangeActor,
  ): Promise<DiscountSettingsView> {
    const data = pickDefinedFields(input, SETTING_FIELDS);
    if (Object.keys(data).length === 0) {
      throw AppError.badRequest(
        `Provide at least one of ${SETTING_FIELDS.join(', ')}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await this.ensureDefaults(tx);
      await tx.$queryRaw`
        SELECT "id" FROM "DiscountSettings" WHERE "id" = ${DISCOUNT_SETTINGS_ID} FOR UPDATE
      `;
      const before = await tx.discountSettings.findUniqueOrThrow({
        where: { id: DISCOUNT_SETTINGS_ID },
      });
      const after = await tx.discountSettings.update({
        where: { id: DISCOUNT_SETTINGS_ID },
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
            tableName: 'DiscountSettings',
            recordId: String(DISCOUNT_SETTINGS_ID),
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

  private values(stored: DiscountSettings): DiscountSettingsValues {
    return {
      firstPurchaseDiscountPercent: stored.firstPurchaseDiscountPercent,
      referralDiscountPercent: stored.referralDiscountPercent,
      referrerRewardCredits: stored.referrerRewardCredits,
    };
  }

  private toView(stored: DiscountSettings): DiscountSettingsView {
    const values = this.values(stored);
    return {
      ...values,
      firstPurchaseDiscountActive: values.firstPurchaseDiscountPercent > 0,
      referralDiscountActive: values.referralDiscountPercent > 0,
      referrerRewardActive: values.referrerRewardCredits > 0,
      updatedAt: stored.updatedAt.toISOString(),
    };
  }
}
