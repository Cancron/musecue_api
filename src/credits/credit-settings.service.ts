import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Prisma, type CreditSettings } from '@prisma/client';
import AppError from '../common/errors/app.error';
import {
  ActivityLogService,
  type FieldChange,
} from '../common/services/activity-log.service';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { PrismaService } from '../common/services/prisma.service';
import {
  CREDIT_SETTINGS_ID,
  formatUsdMicros,
  MICRO_CREDITS_PER_CREDIT,
} from './credit-settings.constants';
import type {
  CreditSettingsChangeActor,
  CreditSettingsValues,
  CreditSettingsView,
  UpdateCreditSettingsInput,
} from './interfaces/credit-settings.interface';

const SETTING_FIELDS: readonly (keyof CreditSettingsValues)[] = [
  'trialCredits',
  'proMonthlyCredits',
  'creditCostUsdMicros',
  'sessionOverageCredits',
  'deductionStepMicroCredits',
];

/**
 * The administrator-managed AI credit configuration, stored as one row in
 * PostgreSQL. The defaults are the table's column defaults: migration
 * 20261123120000_seed_credit_settings stores them, and the application
 * stores them again at startup if the row is missing. Neither ever
 * overwrites a stored row, so administrator changes survive restarts.
 */
@Injectable()
export class CreditSettingsService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLog: ActivityLogService,
    private readonly logger: CustomLoggerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (await this.ensureDefaults()) {
      this.logger.log(
        'Stored the default AI credit settings',
        CreditSettingsService.name,
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
    const { count } = await client.creditSettings.createMany({
      data: [{ id: CREDIT_SETTINGS_ID }],
      skipDuplicates: true,
    });
    return count > 0;
  }

  /** Pass a transaction client to read the settings inside that transaction. */
  async getSettings(
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<CreditSettingsView> {
    const stored = await client.creditSettings.findUnique({
      where: { id: CREDIT_SETTINGS_ID },
    });
    if (stored) return this.toView(stored);
    // Deleted since startup: store the defaults again.
    await this.ensureDefaults(client);
    return this.toView(
      await client.creditSettings.findUniqueOrThrow({
        where: { id: CREDIT_SETTINGS_ID },
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
    input: UpdateCreditSettingsInput,
    actor: CreditSettingsChangeActor,
  ): Promise<CreditSettingsView> {
    const data = this.pickDefined(input);
    if (Object.keys(data).length === 0) {
      throw AppError.badRequest(
        `Provide at least one of ${SETTING_FIELDS.join(', ')}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await this.ensureDefaults(tx);
      await tx.$queryRaw`
        SELECT "id" FROM "CreditSettings" WHERE "id" = ${CREDIT_SETTINGS_ID} FOR UPDATE
      `;
      const before = await tx.creditSettings.findUniqueOrThrow({
        where: { id: CREDIT_SETTINGS_ID },
      });
      const after = await tx.creditSettings.update({
        where: { id: CREDIT_SETTINGS_ID },
        data,
      });

      const changes = this.diff(before, after);
      if (changes.length > 0) {
        await this.activityLog.logActivity(
          {
            tableName: 'CreditSettings',
            recordId: String(CREDIT_SETTINGS_ID),
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

  private pickDefined(
    input: UpdateCreditSettingsInput,
  ): UpdateCreditSettingsInput {
    const data: UpdateCreditSettingsInput = {};
    for (const field of SETTING_FIELDS) {
      if (input[field] !== undefined) {
        data[field] = input[field];
      }
    }
    return data;
  }

  private diff(
    before: CreditSettingsValues,
    after: CreditSettingsValues,
  ): FieldChange[] {
    return SETTING_FIELDS.filter((field) => before[field] !== after[field]).map(
      (field) => ({
        fieldName: field,
        oldValue: String(before[field]),
        newValue: String(after[field]),
      }),
    );
  }

  private toView(stored: CreditSettings): CreditSettingsView {
    return {
      trialCredits: stored.trialCredits,
      proMonthlyCredits: stored.proMonthlyCredits,
      creditCostUsdMicros: stored.creditCostUsdMicros,
      creditCostUsd: formatUsdMicros(stored.creditCostUsdMicros),
      sessionOverageCredits: stored.sessionOverageCredits,
      deductionStepMicroCredits: stored.deductionStepMicroCredits,
      deductionStepCredits: new Prisma.Decimal(stored.deductionStepMicroCredits)
        .dividedBy(MICRO_CREDITS_PER_CREDIT)
        .toFixed(),
      updatedAt: stored.updatedAt.toISOString(),
    };
  }
}
