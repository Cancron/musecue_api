import { Injectable } from '@nestjs/common';
import { ReferralStatus, type Referral } from '@prisma/client';
import AppError from '../common/errors/app.error';
import {
  ActivityLogService,
  type ActivityLogMetadata,
} from '../common/services/activity-log.service';
import { PrismaService } from '../common/services/prisma.service';
import { ReferralMilestoneService } from './referral-milestone.service';
import { ReferralRewardService } from './referral-reward.service';

/** Payment and credit work can wait for row locks under load. */
const REVIEW_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

export interface ReferralReviewView {
  id: string;
  status: ReferralStatus;
  referrer: { id: string; username: string } | null;
  referred: { id: string; username: string };
  holdReason: string | null;
  heldAt: string | null;
  /** The reward that waits for the decision (null: none due). */
  rewardCredits: number | null;
  qualifiedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  signedUpAt: string;
}

export const REVIEW_MESSAGES = {
  NOT_FOUND: 'Referral not found',
  ALREADY_REVIEWED: 'This referral is not waiting for review',
} as const;

/**
 * Administrator review of suspicious (HELD) referrals. Approving grants the
 * held reward (REWARDED, with credits and the "earned" notification) or, if
 * none was due, qualifies it; either way it then counts for the referrer's
 * milestones. Rejecting grants nothing. The decision is a conditional
 * update from HELD, so concurrent or repeated approvals and rejections
 * decide once (the others answer 409) and never grant twice.
 */
@Injectable()
export class ReferralReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rewards: ReferralRewardService,
    private readonly milestones: ReferralMilestoneService,
    private readonly activityLog: ActivityLogService,
  ) {}

  async list(status: ReferralStatus = ReferralStatus.HELD) {
    const referrals = await this.prisma.referral.findMany({
      where: { status },
      orderBy: [{ heldAt: 'asc' }, { createdAt: 'asc' }],
      take: 200,
      include: {
        authUser: { select: { id: true, username: true } },
        referrer: { select: { id: true, username: true } },
      },
    });
    return referrals.map((r) => this.toView(r, r.authUser, r.referrer));
  }

  approve(id: string, actor: ActivityLogMetadata & { actionedBy: string }) {
    return this.decide(id, 'approve', actor);
  }

  reject(id: string, actor: ActivityLogMetadata & { actionedBy: string }) {
    return this.decide(id, 'reject', actor);
  }

  private async decide(
    id: string,
    decision: 'approve' | 'reject',
    actor: ActivityLogMetadata & { actionedBy: string },
  ): Promise<ReferralReviewView> {
    const now = new Date();
    const referral = await this.prisma.$transaction(async (tx) => {
      const held = await tx.referral.findUnique({ where: { id } });
      if (!held) throw AppError.notFound(REVIEW_MESSAGES.NOT_FOUND);
      const credits = held.rewardCredits;
      const grant =
        decision === 'approve' &&
        held.referrerAuthId !== null &&
        credits !== null;
      const status =
        decision === 'reject'
          ? ReferralStatus.REJECTED
          : grant
            ? ReferralStatus.REWARDED
            : ReferralStatus.QUALIFIED;
      // Decided once: only a HELD referral changes.
      const { count } = await tx.referral.updateMany({
        where: { id, status: ReferralStatus.HELD },
        data: {
          status,
          reviewedAt: now,
          reviewedBy: actor.actionedBy,
          ...(grant ? { rewardedAt: now } : {}),
        },
      });
      if (count === 0)
        throw AppError.conflict(REVIEW_MESSAGES.ALREADY_REVIEWED);

      if (grant && held.referrerAuthId && credits !== null) {
        await this.rewards.grantReward(
          tx,
          held.id,
          held.referrerAuthId,
          credits,
          now,
        );
      }
      if (decision === 'approve' && held.referrerAuthId) {
        await this.milestones.evaluate(tx, held.referrerAuthId, now);
      }
      await this.activityLog.logActivity(
        {
          tableName: 'Referral',
          recordId: id,
          action: 'update',
          changes: [
            { fieldName: 'status', oldValue: 'HELD', newValue: status },
          ],
          metadata: actor,
        },
        tx,
      );
      return tx.referral.findUniqueOrThrow({
        where: { id },
        include: {
          authUser: { select: { id: true, username: true } },
          referrer: { select: { id: true, username: true } },
        },
      });
    }, REVIEW_TRANSACTION_OPTIONS);
    return this.toView(referral, referral.authUser, referral.referrer);
  }

  private toView(
    referral: Referral,
    referred: { id: string; username: string },
    referrer: { id: string; username: string } | null,
  ): ReferralReviewView {
    return {
      id: referral.id,
      status: referral.status,
      referrer,
      referred,
      holdReason: referral.holdReason,
      heldAt: referral.heldAt?.toISOString() ?? null,
      rewardCredits: referral.rewardCredits,
      qualifiedAt: referral.qualifiedAt?.toISOString() ?? null,
      reviewedAt: referral.reviewedAt?.toISOString() ?? null,
      reviewedBy: referral.reviewedBy,
      signedUpAt: referral.createdAt.toISOString(),
    };
  }
}
