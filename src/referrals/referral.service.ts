import { Injectable } from '@nestjs/common';
import { CreditSource, Prisma, type ReferralStatus } from '@prisma/client';
import { randomInt } from 'node:crypto';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import { DISCOUNT_SETTINGS_ID } from '../discounts/discount-settings.constants';
import { hasPaidPurchase } from '../discounts/paid-purchase';
import type {
  ReferralInviteeView,
  ReferralOverviewView,
  ReferralRewardView,
} from './interfaces/referral.interface';
import { PAID_REFERRAL_STATUSES } from './referral-milestone.service';
import {
  maskDisplayName,
  REFERRAL_MILESTONE_PREFIX,
  REFERRAL_REWARD_PREFIX,
} from './referral.policy';

/** Unambiguous characters (no 0/O, 1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/**
 * The signed-in user's own referral data: their code, the people they
 * invited and the rewards they earned. Every query is scoped to the caller;
 * invitees are shown by a masked name, never by email or user id.
 */
@Injectable()
export class ReferralService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(authId: string): Promise<ReferralOverviewView> {
    const code = await this.ensureCode(authId);
    const [own, settings, counts, earned, awards, milestones] =
      await Promise.all([
        this.prisma.referral.findUnique({ where: { authId } }),
        this.prisma.discountSettings.findUnique({
          where: { id: DISCOUNT_SETTINGS_ID },
        }),
        this.prisma.referral.groupBy({
          by: ['status'],
          where: { referrerAuthId: authId },
          _count: { _all: true },
        }),
        this.prisma.creditAllocation.aggregate({
          where: this.rewardAllocations(authId),
          _sum: { amount: true },
        }),
        this.prisma.referralMilestoneAward.findMany({
          where: { authId },
          orderBy: { referralCount: 'asc' },
        }),
        this.prisma.referralMilestone.findMany({
          where: { active: true },
          orderBy: { referralCount: 'asc' },
        }),
      ]);
    const count = (status: ReferralStatus) =>
      counts.find((group) => group.status === status)?._count._all ?? 0;
    const referralPercent = settings?.referralDiscountPercent ?? 0;
    const discountAvailable =
      own !== null &&
      referralPercent > 0 &&
      !(await hasPaidPurchase(this.prisma, authId));
    return {
      code,
      referred: own !== null,
      referralDiscountPercent: discountAvailable ? referralPercent : 0,
      rewardCreditsPerReferral: settings?.referrerRewardCredits ?? 0,
      referrals: {
        total: counts.reduce((sum, group) => sum + group._count._all, 0),
        pending: count('PENDING'),
        rewarded: count('REWARDED'),
        qualified: count('QUALIFIED'),
        underReview: count('HELD'),
        rejected: count('REJECTED'),
      },
      milestones: this.milestoneProgress(
        PAID_REFERRAL_STATUSES.reduce((sum, status) => sum + count(status), 0),
        awards,
        milestones,
      ),
      totalEarnedCredits: (
        earned._sum.amount ?? new Prisma.Decimal(0)
      ).toFixed(),
    };
  }

  /** The people the caller invited, newest first. */
  async listInvitees(
    authId: string,
    status?: ReferralStatus,
  ): Promise<ReferralInviteeView[]> {
    const referrals = await this.prisma.referral.findMany({
      where: { referrerAuthId: authId, ...(status ? { status } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      include: { authUser: { select: { username: true } } },
    });
    return referrals.map((referral) => ({
      id: referral.id,
      displayName: maskDisplayName(referral.authUser.username),
      status: referral.status,
      signedUpAt: referral.createdAt.toISOString(),
      qualifiedAt: referral.qualifiedAt?.toISOString() ?? null,
      rewardCredits: referral.rewardCredits,
      rewardedAt: referral.rewardedAt?.toISOString() ?? null,
    }));
  }

  /**
   * The referral and milestone rewards the caller received, newest first.
   * Read from the caller's own credit allocations, so earnings stay listed
   * after an invitee's account is deleted.
   */
  async listRewards(authId: string): Promise<ReferralRewardView[]> {
    const allocations = await this.prisma.creditAllocation.findMany({
      where: this.rewardAllocations(authId),
      orderBy: [{ grantedAt: 'desc' }, { id: 'asc' }],
    });
    const referenced = (prefix: string) =>
      allocations
        .filter((a) => a.sourceReference.startsWith(prefix))
        .map((a) => a.sourceReference.slice(prefix.length));
    const [referrals, milestones] = await Promise.all([
      this.prisma.referral.findMany({
        where: {
          id: { in: referenced(REFERRAL_REWARD_PREFIX) },
          referrerAuthId: authId,
        },
        include: { authUser: { select: { username: true } } },
      }),
      this.prisma.referralMilestone.findMany({
        where: { id: { in: referenced(REFERRAL_MILESTONE_PREFIX) } },
      }),
    ]);
    const names = new Map(
      referrals.map((referral) => [
        referral.id,
        maskDisplayName(referral.authUser.username),
      ]),
    );
    const thresholds = new Map(milestones.map((m) => [m.id, m.referralCount]));
    return allocations.map((allocation) => {
      const milestone = allocation.sourceReference.startsWith(
        REFERRAL_MILESTONE_PREFIX,
      );
      const ref = allocation.sourceReference.slice(
        (milestone ? REFERRAL_MILESTONE_PREFIX : REFERRAL_REWARD_PREFIX).length,
      );
      return {
        id: allocation.id,
        kind: milestone ? ('MILESTONE' as const) : ('REFERRAL' as const),
        referralId: milestone ? null : ref,
        milestoneReferralCount: milestone
          ? (thresholds.get(ref) ?? null)
          : null,
        displayName: milestone ? null : (names.get(ref) ?? null),
        credits: allocation.amount.toFixed(),
        remainingCredits: allocation.remaining.toFixed(),
        grantedAt: allocation.grantedAt.toISOString(),
        expiresAt: null,
      };
    });
  }

  private milestoneProgress(
    paidReferrals: number,
    awards: Array<{
      referralCount: number;
      rewardCredits: number;
      awardedAt: Date;
    }>,
    active: Array<{ referralCount: number; rewardCredits: number }>,
  ): ReferralOverviewView['milestones'] {
    const reachedCounts = new Set(awards.map((a) => a.referralCount));
    const next = active.find(
      (m) =>
        m.referralCount > paidReferrals && !reachedCounts.has(m.referralCount),
    );
    return {
      paidReferrals,
      reached: awards.map((a) => ({
        referralCount: a.referralCount,
        rewardCredits: a.rewardCredits,
        awardedAt: a.awardedAt.toISOString(),
      })),
      next: next
        ? {
            referralCount: next.referralCount,
            rewardCredits: next.rewardCredits,
            remaining: next.referralCount - paidReferrals,
          }
        : null,
    };
  }

  private rewardAllocations(authId: string): Prisma.CreditAllocationWhereInput {
    return {
      authId,
      source: CreditSource.REFERRAL,
      OR: [
        { sourceReference: { startsWith: REFERRAL_REWARD_PREFIX } },
        { sourceReference: { startsWith: REFERRAL_MILESTONE_PREFIX } },
      ],
    };
  }

  /** The user's code, created on first use (unique; retried on collision). */
  private async ensureCode(authId: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = await this.prisma.referralCode.findUnique({
        where: { authId },
      });
      if (existing) return existing.code;
      await this.prisma.referralCode.createMany({
        data: [{ authId, code: randomCode() }],
        skipDuplicates: true,
      });
    }
    const stored = await this.prisma.referralCode.findUnique({
      where: { authId },
    });
    if (!stored) throw AppError.internalServerError();
    return stored.code;
  }
}

function randomCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}
