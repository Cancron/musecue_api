import { Injectable } from '@nestjs/common';
import { Prisma, type CreditSettings } from '@prisma/client';
import AppError from '../common/errors/app.error';
import {
  ActivityLogService,
  type FieldChange,
} from '../common/services/activity-log.service';
import { PrismaService } from '../common/services/prisma.service';
import {
  CREDIT_SETTINGS_DEFAULTS,
  CREDIT_SETTINGS_ID,
  formatUsdMicros,
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
];

/**
 * The administrator-managed AI credit configuration. Configuration only:
 * nothing grants, deducts or enforces credits yet. Future credit features
 * should read the settings through `getSettings`.
 */
@Injectable()
export class CreditSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLog: ActivityLogService,
  ) {}

  /** Pass a transaction client to read the settings inside that transaction. */
  async getSettings(
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<CreditSettingsView> {
    const stored = await client.creditSettings.findUnique({
      where: { id: CREDIT_SETTINGS_ID },
    });
    return this.toView(stored);
  }

  /**
   * Applies a partial update and records an audit event with the old and new
   * values. The settings write and the audit record are committed together,
   * so a change is never persisted without its audit trail.
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
      const before = await tx.creditSettings.findUnique({
        where: { id: CREDIT_SETTINGS_ID },
      });
      const after = await tx.creditSettings.upsert({
        where: { id: CREDIT_SETTINGS_ID },
        create: { id: CREDIT_SETTINGS_ID, ...data },
        update: data,
      });

      const changes = this.diff(before ?? CREDIT_SETTINGS_DEFAULTS, after);
      if (changes.length > 0) {
        await this.activityLog.logActivity(
          {
            tableName: 'CreditSettings',
            recordId: String(CREDIT_SETTINGS_ID),
            action: before ? 'update' : 'create',
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

  private toView(stored: CreditSettings | null): CreditSettingsView {
    const settings = stored ?? CREDIT_SETTINGS_DEFAULTS;
    return {
      trialCredits: settings.trialCredits,
      proMonthlyCredits: settings.proMonthlyCredits,
      creditCostUsdMicros: settings.creditCostUsdMicros,
      creditCostUsd: formatUsdMicros(settings.creditCostUsdMicros),
      sessionOverageCredits: settings.sessionOverageCredits,
      updatedAt: stored ? stored.updatedAt.toISOString() : null,
    };
  }
}
