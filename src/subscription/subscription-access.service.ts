import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import type { SubscriptionStatusView } from './interfaces/subscription-status.interface';
import {
  getTrialIneligibility,
  isProActive,
  isTrialAccountEligible,
  isTrialActive,
  resolveSubscriptionAccess,
  type SubscriptionAccess,
  type SubscriptionRecord,
  TRIAL_ACCOUNT_SELECT,
} from './subscription-access.policy';
import { SubscriptionPlanService } from './subscription-plan.service';

const RECORD_SELECT = {
  trialUsed: true,
  trialStartedAt: true,
  trialExpiresAt: true,
  billingInterval: true,
  proStartedAt: true,
  proExpiresAt: true,
  proCanceledAt: true,
} as const satisfies Record<keyof SubscriptionRecord, true>;

/**
 * Loads a user's subscription and answers access questions through
 * subscription-access.policy. Other modules should use this service rather
 * than reading UserSubscription directly.
 */
@Injectable()
export class SubscriptionAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: SubscriptionPlanService,
  ) {}

  async getAccess(
    authId: string,
    now: Date = new Date(),
  ): Promise<SubscriptionAccess> {
    return resolveSubscriptionAccess(await this.findRecord(authId), now);
  }

  async hasProAccess(authId: string, now: Date = new Date()): Promise<boolean> {
    return (await this.getAccess(authId, now)).hasProAccess;
  }

  /**
   * Whether the user could start the free trial now. Uses the same rules as
   * trial activation and GET /v1/subscription (account, plan and history).
   */
  async canStartTrial(authId: string): Promise<boolean> {
    return (await this.getStatus(authId)).trial.eligible;
  }

  /**
   * The user's own subscription as seen at `now`. Read-only: the stored
   * record (including trial history) is never rewritten, and an expiry takes
   * effect purely from the dates. Trial eligibility applies the same rules as
   * activation: an active account plus the policy's eligibility checks.
   */
  async getStatus(
    authId: string,
    now: Date = new Date(),
  ): Promise<SubscriptionStatusView> {
    const [record, plan, user] = await Promise.all([
      this.findRecord(authId),
      this.plans.getProPlan(),
      this.prisma.authUser.findUnique({
        where: { id: authId },
        select: TRIAL_ACCOUNT_SELECT,
      }),
    ]);

    const access = resolveSubscriptionAccess(record, now);
    const ineligibleReason = isTrialAccountEligible(user)
      ? getTrialIneligibility(record, plan)
      : 'ACCOUNT_INACTIVE';
    const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;

    return {
      status: access.status,
      hasProAccess: access.hasProAccess,
      accessSource: access.accessSource,
      accessExpiresAt: iso(access.accessExpiresAt),
      trial: {
        eligible: ineligibleReason === null,
        ineligibleReason,
        used: record?.trialUsed ?? false,
        active: isTrialActive(record, now),
        startedAt: iso(record?.trialStartedAt),
        expiresAt: iso(record?.trialExpiresAt),
      },
      pro: {
        active: isProActive(record, now),
        billingInterval: record?.billingInterval ?? null,
        startedAt: iso(record?.proStartedAt),
        expiresAt: iso(record?.proExpiresAt),
        canceledAt: iso(record?.proCanceledAt),
      },
    };
  }

  private findRecord(authId: string): Promise<SubscriptionRecord | null> {
    return this.prisma.userSubscription.findUnique({
      where: { authId },
      select: RECORD_SELECT,
    });
  }
}
