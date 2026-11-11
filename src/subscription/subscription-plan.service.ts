import { Injectable } from '@nestjs/common';
import { PlanCode, Prisma, type SubscriptionPlan } from '@prisma/client';
import AppError from '../common/errors/app.error';
import {
  ActivityLogService,
  type FieldChange,
} from '../common/services/activity-log.service';
import { PrismaService } from '../common/services/prisma.service';
import type {
  PlanChangeActor,
  SubscriptionPlanSettings,
  SubscriptionPlanView,
  UpdateSubscriptionPlanInput,
} from './interfaces/subscription-plan.interface';
import {
  SUBSCRIPTION_PLAN_CURRENCY,
  SUBSCRIPTION_PLAN_DEFAULTS,
} from './subscription-plan.constants';

const SETTING_FIELDS: readonly (keyof SubscriptionPlanSettings)[] = [
  'planEnabled',
  'monthlyPriceUsdCents',
  'yearlyPriceUsdCents',
  'trialEnabled',
  'trialDays',
];

@Injectable()
export class SubscriptionPlanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLog: ActivityLogService,
  ) {}

  /** Pass a transaction client to read the plan inside that transaction. */
  async getProPlan(
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<SubscriptionPlanView> {
    const plan = await client.subscriptionPlan.findUnique({
      where: { code: PlanCode.PRO },
    });
    return this.toView(plan);
  }

  /**
   * Applies a partial update to the Pro plan and records an audit event with
   * the old and new values. The plan write and the audit record are committed
   * together, so a change is never persisted without its audit trail.
   */
  async updateProPlan(
    input: UpdateSubscriptionPlanInput,
    actor: PlanChangeActor,
  ): Promise<SubscriptionPlanView> {
    const data = this.pickDefined(input);
    if (Object.keys(data).length === 0) {
      throw AppError.badRequest(
        `Provide at least one of ${SETTING_FIELDS.join(', ')}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const before = await tx.subscriptionPlan.findUnique({
        where: { code: PlanCode.PRO },
      });
      const after = await tx.subscriptionPlan.upsert({
        where: { code: PlanCode.PRO },
        create: { code: PlanCode.PRO, ...data },
        update: data,
      });

      const changes = this.diff(before ?? SUBSCRIPTION_PLAN_DEFAULTS, after);
      if (changes.length > 0) {
        await this.activityLog.logActivity(
          {
            tableName: 'SubscriptionPlan',
            recordId: PlanCode.PRO,
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
    input: UpdateSubscriptionPlanInput,
  ): UpdateSubscriptionPlanInput {
    const data: UpdateSubscriptionPlanInput = {};
    for (const field of SETTING_FIELDS) {
      if (input[field] !== undefined) {
        Object.assign(data, { [field]: input[field] });
      }
    }
    return data;
  }

  private diff(
    before: SubscriptionPlanSettings,
    after: SubscriptionPlanSettings,
  ): FieldChange[] {
    return SETTING_FIELDS.filter((field) => before[field] !== after[field]).map(
      (field) => ({
        fieldName: field,
        oldValue: String(before[field]),
        newValue: String(after[field]),
      }),
    );
  }

  private toView(plan: SubscriptionPlan | null): SubscriptionPlanView {
    const settings = plan ?? SUBSCRIPTION_PLAN_DEFAULTS;
    return {
      code: PlanCode.PRO,
      currency: SUBSCRIPTION_PLAN_CURRENCY,
      planEnabled: settings.planEnabled,
      monthlyPriceUsdCents: settings.monthlyPriceUsdCents,
      yearlyPriceUsdCents: settings.yearlyPriceUsdCents,
      trialEnabled: settings.trialEnabled,
      trialDays: settings.trialDays,
      updatedAt: plan ? plan.updatedAt.toISOString() : null,
    };
  }
}
