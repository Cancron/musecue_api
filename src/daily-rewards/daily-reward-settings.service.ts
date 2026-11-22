import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { DailyRewardSettings, Prisma } from '@prisma/client';
import AppError from '../common/errors/app.error';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { PrismaService } from '../common/services/prisma.service';
import {
  changedFields,
  pickDefinedFields,
} from '../common/settings/settings-fields';
import {
  DAILY_REWARD_MONTHLY_CAP_CREDITS,
  DAILY_REWARD_SETTINGS_ID,
} from './daily-reward-settings.constants';
import { dailyRewardSettingsViolation } from './daily-reward-settings.policy';
import type {
  DailyRewardSettingsChangeActor,
  DailyRewardSettingsValues,
  DailyRewardSettingsView,
  UpdateDailyRewardSettingsInput,
} from './interfaces/daily-reward-settings.interface';

const SETTING_FIELDS: readonly (keyof DailyRewardSettingsValues)[] = [
  'startingRewardCredits',
  'dailyIncrementCredits',
  'maxDailyRewardCredits',
];

/**
 * The administrator-managed daily reward configuration, stored as one row in
 * PostgreSQL. The defaults (10 credits, +10 per day, at most 50) are the
 * table's column defaults: migration 20261130120000_add_promotion_settings
 * stores them, and the application stores them again at startup if the row
 * is missing. Neither ever overwrites a stored row, so administrator changes
 * survive restarts. The 600-credit monthly cap is a fixed product rule.
 */
@Injectable()
export class DailyRewardSettingsService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLog: ActivityLogService,
    private readonly logger: CustomLoggerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (await this.ensureDefaults()) {
      this.logger.log(
        'Stored the default daily reward settings',
        DailyRewardSettingsService.name,
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
    const { count } = await client.dailyRewardSettings.createMany({
      data: [{ id: DAILY_REWARD_SETTINGS_ID }],
      skipDuplicates: true,
    });
    return count > 0;
  }

  /** Pass a transaction client to read the settings inside that transaction. */
  async getSettings(
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<DailyRewardSettingsView> {
    const stored = await client.dailyRewardSettings.findUnique({
      where: { id: DAILY_REWARD_SETTINGS_ID },
    });
    if (stored) return this.toView(stored);
    // Deleted since startup: store the defaults again.
    await this.ensureDefaults(client);
    return this.toView(
      await client.dailyRewardSettings.findUniqueOrThrow({
        where: { id: DAILY_REWARD_SETTINGS_ID },
      }),
    );
  }

  /**
   * Applies a partial update and records an audit event with the old and new
   * values. The row is locked, so concurrent changes are applied one at a
   * time: the combined result (stored values plus the request) is validated
   * against the values it actually replaces, and each audit entry has the
   * exact old values. An invalid combination changes nothing. The settings
   * write and the audit record are committed together.
   */
  async updateSettings(
    input: UpdateDailyRewardSettingsInput,
    actor: DailyRewardSettingsChangeActor,
  ): Promise<DailyRewardSettingsView> {
    const data = pickDefinedFields(input, SETTING_FIELDS);
    if (Object.keys(data).length === 0) {
      throw AppError.badRequest(
        `Provide at least one of ${SETTING_FIELDS.join(', ')}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await this.ensureDefaults(tx);
      await tx.$queryRaw`
        SELECT "id" FROM "DailyRewardSettings" WHERE "id" = ${DAILY_REWARD_SETTINGS_ID} FOR UPDATE
      `;
      const before = await tx.dailyRewardSettings.findUniqueOrThrow({
        where: { id: DAILY_REWARD_SETTINGS_ID },
      });
      const violation = dailyRewardSettingsViolation({
        ...this.values(before),
        ...data,
      });
      if (violation) throw AppError.badRequest(violation);

      const after = await tx.dailyRewardSettings.update({
        where: { id: DAILY_REWARD_SETTINGS_ID },
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
            tableName: 'DailyRewardSettings',
            recordId: String(DAILY_REWARD_SETTINGS_ID),
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

  private values(stored: DailyRewardSettings): DailyRewardSettingsValues {
    return {
      startingRewardCredits: stored.startingRewardCredits,
      dailyIncrementCredits: stored.dailyIncrementCredits,
      maxDailyRewardCredits: stored.maxDailyRewardCredits,
    };
  }

  private toView(stored: DailyRewardSettings): DailyRewardSettingsView {
    return {
      ...this.values(stored),
      monthlyCapCredits: DAILY_REWARD_MONTHLY_CAP_CREDITS,
      updatedAt: stored.updatedAt.toISOString(),
    };
  }
}
