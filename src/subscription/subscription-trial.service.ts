import { Injectable } from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '@prisma/client';
import AppError from '../common/errors/app.error';
import {
  ActivityLogService,
  type ActivityLogMetadata,
} from '../common/services/activity-log.service';
import { PrismaService } from '../common/services/prisma.service';
import {
  getTrialIneligibility,
  isTrialAccountEligible,
  resolveSubscriptionAccess,
  TRIAL_ACCOUNT_SELECT,
  type SubscriptionAccess,
  type TrialIneligibilityReason,
} from './subscription-access.policy';
import { SubscriptionPlanService } from './subscription-plan.service';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrialActivationView {
  status: SubscriptionAccess['status'];
  hasProAccess: boolean;
  accessSource: SubscriptionAccess['accessSource'];
  accessExpiresAt: string | null;
  trialStartedAt: string;
  trialExpiresAt: string;
}

const INELIGIBLE: Record<TrialIneligibilityReason, () => AppError> = {
  PLAN_DISABLED: () =>
    AppError.forbidden('The free trial is not currently available'),
  TRIAL_DISABLED: () =>
    AppError.forbidden('The free trial is not currently available'),
  TRIAL_ALREADY_USED: () =>
    AppError.conflict('The free trial has already been used'),
  HAS_PRO_HISTORY: () =>
    AppError.conflict(
      'The free trial is only available to accounts that have never subscribed to Pro',
    ),
};

@Injectable()
export class SubscriptionTrialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: SubscriptionPlanService,
    private readonly activityLog: ActivityLogService,
  ) {}

  /**
   * Starts the one-time free trial for an active user.
   *
   * Everything runs in one transaction: account check, plan settings,
   * eligibility, the trial write and its audit record. Any failure rolls the
   * whole activation back, so a failed attempt never consumes the trial.
   * The trial is claimed with a conditional update, so concurrent or repeated
   * requests cannot create a second trial or move the expiry date.
   */
  async activateTrial(
    authId: string,
    metadata: ActivityLogMetadata,
    now: Date = new Date(),
  ): Promise<TrialActivationView> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.authUser.findUnique({
        where: { id: authId },
        select: TRIAL_ACCOUNT_SELECT,
      });
      if (!user) throw AppError.unauthorized('User not found');
      if (!isTrialAccountEligible(user)) {
        throw AppError.forbidden('Only active accounts can start a free trial');
      }

      const plan = await this.plans.getProPlan(tx);
      const existing = await this.findRecord(tx, authId);
      const reason = getTrialIneligibility(existing, plan);
      if (reason) throw INELIGIBLE[reason]();

      const trialStartedAt = now;
      const trialExpiresAt = new Date(now.getTime() + plan.trialDays * DAY_MS);

      // Make sure the user's single record exists (no-op if it already does).
      const created = await tx.userSubscription.createMany({
        data: [{ authId }],
        skipDuplicates: true,
      });
      // Claim the trial only if it is still unused and there is no Pro
      // history. A concurrent activation waits on the row lock and then
      // matches zero rows.
      const claimed = await tx.userSubscription.updateMany({
        where: {
          authId,
          trialUsed: false,
          trialStartedAt: null,
          proStartedAt: null,
        },
        data: {
          status: SubscriptionStatus.TRIAL,
          trialUsed: true,
          trialStartedAt,
          trialExpiresAt,
        },
      });
      if (claimed.count !== 1) {
        const current = await this.findRecord(tx, authId);
        throw INELIGIBLE[
          getTrialIneligibility(current, plan) ?? 'TRIAL_ALREADY_USED'
        ]();
      }

      const record = await tx.userSubscription.findUniqueOrThrow({
        where: { authId },
      });
      await this.activityLog.logActivity(
        {
          tableName: 'UserSubscription',
          recordId: record.id,
          action: created.count === 1 ? 'create' : 'update',
          changes: [
            {
              fieldName: 'status',
              oldValue: existing ? SubscriptionStatus.FREE : null,
              newValue: SubscriptionStatus.TRIAL,
            },
            { fieldName: 'trialUsed', oldValue: 'false', newValue: 'true' },
            {
              fieldName: 'trialStartedAt',
              oldValue: null,
              newValue: trialStartedAt.toISOString(),
            },
            {
              fieldName: 'trialExpiresAt',
              oldValue: null,
              newValue: trialExpiresAt.toISOString(),
            },
          ],
          metadata: { ...metadata, actionedBy: authId },
        },
        tx,
      );

      const access = resolveSubscriptionAccess(record, now);
      return {
        status: access.status,
        hasProAccess: access.hasProAccess,
        accessSource: access.accessSource,
        accessExpiresAt: access.accessExpiresAt?.toISOString() ?? null,
        trialStartedAt: trialStartedAt.toISOString(),
        trialExpiresAt: trialExpiresAt.toISOString(),
      };
    });
  }

  private findRecord(tx: Prisma.TransactionClient, authId: string) {
    return tx.userSubscription.findUnique({
      where: { authId },
      select: {
        trialUsed: true,
        trialStartedAt: true,
        trialExpiresAt: true,
        billingInterval: true,
        proStartedAt: true,
        proExpiresAt: true,
        proCanceledAt: true,
      },
    });
  }
}
