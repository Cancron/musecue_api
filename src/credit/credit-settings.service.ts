import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, type CreditSettings } from '@prisma/client';
import AppError from '../common/errors/app.error';
import {
  ActivityLogService,
  type FieldChange,
} from '../common/services/activity-log.service';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { PrismaService } from '../common/services/prisma.service';
import {
  CREDIT_SETTINGS_AUDIT_TABLE,
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
 * The administrator-managed configuration of the AI credit system, stored as
 * a single PostgreSQL row. The defaults are the column defaults: the row is
 * seeded by a migration and re-created at startup if it is missing, and an
 * existing row is never overwritten except by an administrator update.
 */
@Injectable()
export class CreditSettingsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLog: ActivityLogService,
    private readonly logger: CustomLoggerService,
  ) {}

  /**
   * Makes sure the configuration row exists when the application starts.
   * Best effort: if it fails, startup continues and the row is re-created
   * with the defaults on the first read (readStored).
   */
  async onModuleInit(): Promise<void> {
    try {
      if (await this.ensureStored()) {
        this.logger.log(
          'Stored the default AI credit settings (no configuration row existed)',
          CreditSettingsService.name,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Could not check the AI credit settings at startup (${error instanceof Error ? error.name : typeof error}); they are stored on first use`,
        CreditSettingsService.name,
      );
    }
  }

  /**
   * Inserts the configuration row with the column defaults unless it already
   * exists (INSERT ... ON CONFLICT DO NOTHING), so concurrent API instances
   * and restarts never overwrite saved settings. Returns whether a row was
   * inserted.
   */
  async ensureStored(
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
    return this.toView(await this.readStored(client));
  }

  /**
   * Applies a partial update and records an audit event with the old and new
   * values. The row is locked for the transaction, so concurrent updates are
   * applied one after another with accurate old values; the settings write
   * and the audit record are committed together, and a failed write leaves
   * the stored settings unchanged.
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
      await this.ensureStored(tx);
      await tx.$queryRaw`
        SELECT "id" FROM "CreditSettings" WHERE "id" = ${CREDIT_SETTINGS_ID} FOR UPDATE`;
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
            tableName: CREDIT_SETTINGS_AUDIT_TABLE,
            recordId: CREDIT_SETTINGS_ID,
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

  /** The stored row; re-created with the column defaults if it was deleted. */
  private async readStored(
    client: Prisma.TransactionClient,
  ): Promise<CreditSettings> {
    const stored = await client.creditSettings.findUnique({
      where: { id: CREDIT_SETTINGS_ID },
    });
    if (stored) return stored;
    await this.ensureStored(client);
    return client.creditSettings.findUniqueOrThrow({
      where: { id: CREDIT_SETTINGS_ID },
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

  private toView(settings: CreditSettings): CreditSettingsView {
    return {
      trialAllowanceCredits: settings.trialAllowanceCredits,
      proMonthlyAllowanceCredits: settings.proMonthlyAllowanceCredits,
      openRouterUsdMicrosPerCredit: settings.openRouterUsdMicrosPerCredit,
      openRouterUsdPerCredit: formatUsdMicros(
        settings.openRouterUsdMicrosPerCredit,
      ),
      sessionOverageAllowanceCredits: settings.sessionOverageAllowanceCredits,
      updatedAt: settings.updatedAt.toISOString(),
    };
  }
}
