import { Injectable } from '@nestjs/common';
import { Prisma, type CreditSettings } from '@prisma/client';
import AppError from '../common/errors/app.error';
import {
  ActivityLogService,
  type FieldChange,
} from '../common/services/activity-log.service';
import { PrismaService } from '../common/services/prisma.service';
import {
  CREDIT_SETTINGS_AUDIT_TABLE,
  CREDIT_SETTINGS_DEFAULTS,
  CREDIT_SETTINGS_ID,
  USD_MICROS_PER_USD,
} from './credit-settings.constants';
import type {
  CreditSettingsChangeActor,
  CreditSettingsValues,
  CreditSettingsView,
  UpdateCreditSettingsInput,
} from './interfaces/credit-settings.interface';

const SETTING_FIELDS: readonly (keyof CreditSettingsValues)[] = [
  'trialAllowanceCredits',
  'proMonthlyAllowanceCredits',
  'openRouterUsdMicrosPerCredit',
  'sessionOverageAllowanceCredits',
];

/**
 * Renders whole micro-dollars as a decimal dollar string without
 * floating-point arithmetic, e.g. 5000 -> "0.005", 1000000 -> "1".
 */
export function formatUsdMicros(micros: number): string {
  const dollars = Math.floor(micros / USD_MICROS_PER_USD);
  const fraction = String(micros % USD_MICROS_PER_USD)
    .padStart(6, '0')
    .replace(/0+$/, '');
  return fraction ? `${dollars}.${fraction}` : String(dollars);
}

/**
 * The administrator-managed configuration of the AI credit system. Only
 * configuration lives here; balances and charging are not implemented yet and
 * should read the values through `getSettings`.
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
    const settings = await client.creditSettings.findUnique({
      where: { id: CREDIT_SETTINGS_ID },
    });
    return this.toView(settings);
  }

  /**
   * Applies a partial update and records an audit event with the old and new
   * values. The settings write and the audit record are committed together,
   * so a change is never persisted without its audit trail, and a failed
   * write leaves the stored settings unchanged.
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
            tableName: CREDIT_SETTINGS_AUDIT_TABLE,
            recordId: CREDIT_SETTINGS_ID,
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

  private toView(settings: CreditSettings | null): CreditSettingsView {
    const values = settings ?? CREDIT_SETTINGS_DEFAULTS;
    return {
      trialAllowanceCredits: values.trialAllowanceCredits,
      proMonthlyAllowanceCredits: values.proMonthlyAllowanceCredits,
      openRouterUsdMicrosPerCredit: values.openRouterUsdMicrosPerCredit,
      openRouterUsdPerCredit: formatUsdMicros(
        values.openRouterUsdMicrosPerCredit,
      ),
      sessionOverageAllowanceCredits: values.sessionOverageAllowanceCredits,
      updatedAt: settings ? settings.updatedAt.toISOString() : null,
    };
  }
}
