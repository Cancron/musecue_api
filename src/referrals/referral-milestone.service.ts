import { Injectable } from '@nestjs/common';
import {
  CreditSource,
  Prisma,
  type ReferralMilestone,
  ReferralStatus,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import AppError from '../common/errors/app.error';
import {
  ActivityLogService,
  type ActivityLogMetadata,
} from '../common/services/activity-log.service';
import { PrismaService } from '../common/services/prisma.service';
import { CreditWalletService } from '../credits/credit-wallet.service';
import { notificationContent } from '../notifications/notification.policy';
import { NotificationService } from '../notifications/notification.service';
import { referralMilestoneReference } from './referral.policy';

/** Referrals that count towards milestones: a verified paid first purchase. */
export const PAID_REFERRAL_STATUSES = [
  ReferralStatus.REWARDED,
  ReferralStatus.QUALIFIED,
];

export interface ReferralMilestoneView {
  id: string;
  referralCount: number;
  rewardCredits: number;
  active: boolean;
  /** Referrers who reached it. */
  awards: number;
  createdAt: string;
  updatedAt: string;
}

export const MILESTONE_LIMITS = {
  REFERRAL_COUNT_MIN: 1,
  REFERRAL_COUNT_MAX: 100_000,
  REWARD_CREDITS_MIN: 1,
  REWARD_CREDITS_MAX: 1_000_000,
} as const;

/**
 * Referral milestones: administrators configure thresholds of paid
 * referrals (invited users whose first paying purchase was verified; held
 * and rejected referrals do not count) and their credit rewards. A referrer
 * receives each milestone once, as non-expiring REFERRAL credits with a
 * notification.
 *
 * Milestones are evaluated whenever one of the referrer's referrals becomes
 * paid (a verified purchase, or an administrator approving a held one),
 * under a lock of the referrer's ReferralProgress row: concurrent
 * qualifications are counted one at a time, so no milestone is skipped or
 * awarded twice (unique award per referrer and milestone; database triggers
 * refuse awards below the threshold and credits without an award). A
 * milestone created later is awarded with the referrer's next paid
 * referral, together with any other milestone already reached.
 */
@Injectable()
export class ReferralMilestoneService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: CreditWalletService,
    private readonly notifications: NotificationService,
    private readonly activityLog: ActivityLogService,
  ) {}

  /**
   * Counts the referrer's paid referrals and awards every active milestone
   * reached and not yet awarded, in the caller's transaction. Returns the
   * ids of the milestones awarded now.
   */
  async evaluate(
    tx: Prisma.TransactionClient,
    referrerAuthId: string,
    now: Date,
  ): Promise<string[]> {
    await tx.referralProgress.createMany({
      data: [{ authId: referrerAuthId }],
      skipDuplicates: true,
    });
    await tx.$queryRaw`
      SELECT 1 FROM "ReferralProgress" WHERE "authId" = ${referrerAuthId} FOR UPDATE
    `;
    const paidReferrals = await tx.referral.count({
      where: {
        referrerAuthId,
        status: { in: PAID_REFERRAL_STATUSES },
      },
    });
    await tx.referralProgress.update({
      where: { authId: referrerAuthId },
      data: { paidReferrals, updatedAt: now },
    });
    const reached = await tx.referralMilestone.findMany({
      where: {
        active: true,
        referralCount: { lte: paidReferrals },
        awards: { none: { authId: referrerAuthId } },
      },
      orderBy: { referralCount: 'asc' },
    });
    const awarded: string[] = [];
    for (const milestone of reached) {
      const { count } = await tx.referralMilestoneAward.createMany({
        data: [
          {
            id: randomUUID(),
            milestoneId: milestone.id,
            authId: referrerAuthId,
            referralCount: milestone.referralCount,
            rewardCredits: milestone.rewardCredits,
            awardedAt: now,
          },
        ],
        skipDuplicates: true,
      });
      if (count === 0) continue;
      await this.wallet.grant(
        {
          authId: referrerAuthId,
          source: CreditSource.REFERRAL,
          sourceReference: referralMilestoneReference(milestone.id),
          amount: String(milestone.rewardCredits),
          description: `Referral milestone: ${milestone.referralCount} paid referrals`,
        },
        { tx, at: now },
      );
      await this.notifications.notify(
        tx,
        referrerAuthId,
        referralMilestoneReference(milestone.id),
        notificationContent.referralMilestoneReached(
          milestone.id,
          milestone.referralCount,
          milestone.rewardCredits,
        ),
      );
      awarded.push(milestone.id);
    }
    return awarded;
  }

  // -------------------------------------------------------------------------
  // Administration
  // -------------------------------------------------------------------------

  async create(
    input: { referralCount: number; rewardCredits: number; active?: boolean },
    actor: ActivityLogMetadata,
  ): Promise<ReferralMilestoneView> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const milestone = await tx.referralMilestone.create({
          data: {
            referralCount: input.referralCount,
            rewardCredits: input.rewardCredits,
            active: input.active ?? true,
          },
        });
        await this.activityLog.logActivity(
          {
            tableName: 'ReferralMilestone',
            recordId: milestone.id,
            action: 'create',
            changes: [
              {
                fieldName: 'referralCount',
                oldValue: null,
                newValue: String(milestone.referralCount),
              },
              {
                fieldName: 'rewardCredits',
                oldValue: null,
                newValue: String(milestone.rewardCredits),
              },
              {
                fieldName: 'active',
                oldValue: null,
                newValue: String(milestone.active),
              },
            ],
            metadata: actor,
          },
          tx,
        );
        return this.toView(milestone, 0);
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw AppError.conflict(
          'A milestone with this referral count already exists',
        );
      }
      throw error;
    }
  }

  async list(): Promise<ReferralMilestoneView[]> {
    const milestones = await this.prisma.referralMilestone.findMany({
      orderBy: { referralCount: 'asc' },
      include: { _count: { select: { awards: true } } },
    });
    return milestones.map((m) => this.toView(m, m._count.awards));
  }

  async get(id: string): Promise<ReferralMilestoneView> {
    const milestone = await this.prisma.referralMilestone.findUnique({
      where: { id },
      include: { _count: { select: { awards: true } } },
    });
    if (!milestone) throw AppError.notFound('Referral milestone not found');
    return this.toView(milestone, milestone._count.awards);
  }

  /**
   * Changes the reward (for awards made from now on) or switches the
   * milestone on or off. The threshold never changes.
   */
  async update(
    id: string,
    input: { rewardCredits?: number; active?: boolean },
    actor: ActivityLogMetadata,
  ): Promise<ReferralMilestoneView> {
    if (input.rewardCredits === undefined && input.active === undefined) {
      throw AppError.badRequest(
        'Provide at least one of rewardCredits, active',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "ReferralMilestone" WHERE "id" = ${id} FOR UPDATE
      `;
      if (locked.length === 0) {
        throw AppError.notFound('Referral milestone not found');
      }
      const before = await tx.referralMilestone.findUniqueOrThrow({
        where: { id },
      });
      const after = await tx.referralMilestone.update({
        where: { id },
        data: { rewardCredits: input.rewardCredits, active: input.active },
        include: { _count: { select: { awards: true } } },
      });
      const changes = (['rewardCredits', 'active'] as const)
        .filter((field) => before[field] !== after[field])
        .map((field) => ({
          fieldName: field,
          oldValue: String(before[field]),
          newValue: String(after[field]),
        }));
      if (changes.length > 0) {
        await this.activityLog.logActivity(
          {
            tableName: 'ReferralMilestone',
            recordId: id,
            action: 'update',
            changes,
            metadata: actor,
          },
          tx,
        );
      }
      return this.toView(after, after._count.awards);
    });
  }

  private toView(
    milestone: ReferralMilestone,
    awards: number,
  ): ReferralMilestoneView {
    return {
      id: milestone.id,
      referralCount: milestone.referralCount,
      rewardCredits: milestone.rewardCredits,
      active: milestone.active,
      awards,
      createdAt: milestone.createdAt.toISOString(),
      updatedAt: milestone.updatedAt.toISOString(),
    };
  }
}
