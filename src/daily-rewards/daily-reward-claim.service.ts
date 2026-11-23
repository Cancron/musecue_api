import { Injectable } from '@nestjs/common';
import {
  CreditSource,
  Prisma,
  userStatus,
  type DailyRewardClaim,
} from '@prisma/client';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import { CreditAccountService } from '../credits/account/credit-account.service';
import { CreditWalletService } from '../credits/credit-wallet.service';
import {
  addUtcDays,
  dateOfUtcDay,
  grantableCredits,
  isUtcDay,
  rewardForStreakDay,
  secondsUntil,
  utcDay,
  utcMonthStart,
} from './daily-reward-claim.policy';
import { DAILY_REWARD_MONTHLY_CAP_CREDITS } from './daily-reward-settings.constants';
import { DailyRewardSettingsService } from './daily-reward-settings.service';
import type {
  DailyRewardClaimView,
  DailyRewardHistoryPageView,
  DailyRewardMonthView,
  DailyRewardStatusView,
} from './interfaces/daily-reward-claim.interface';

export const DAILY_REWARD_MESSAGES = {
  ALREADY_CLAIMED: "Today's daily reward has already been claimed",
  PAST_DAY:
    'The daily reward of a past day can no longer be claimed; only the current UTC day can be claimed',
  FUTURE_DAY:
    'The daily reward of a future day cannot be claimed yet; only the current UTC day can be claimed',
  INVALID_DATE: 'claimDate must be a valid date (YYYY-MM-DD)',
  NOT_ELIGIBLE: 'Only verified, active accounts can claim daily rewards',
} as const;

const HISTORY_PAGE_SIZE = 31;
const MONTHS_PAGE_SIZE = 12;
/** Transaction lock of a user's claims (the database trigger takes it too). */
const CLAIM_LOCK = 'daily-reward:';

/**
 * Daily reward claims: one per user and UTC calendar day, granted as
 * DAILY_REWARD credits (never expiring) in the user's wallet, for verified,
 * active accounts.
 *
 * The reward follows the streak of consecutive claimed UTC days
 * (DailyRewardSettings at claim time: by default 10, 20, 30, 40, then 50 a
 * day); a missed day starts a new streak, and missed days can never be
 * claimed afterwards. A user receives at most
 * DAILY_REWARD_MONTHLY_CAP_CREDITS (600) daily reward credits per UTC
 * calendar month, counted when granted (spending them does not free the
 * cap): the claim that reaches the cap grants only the rest, and later
 * claims that month grant 0 credits but are still recorded, so they keep the
 * streak. A new month starts a new cap, not a new streak.
 *
 * A claim runs in one transaction under a lock of the user's claims, so
 * concurrent or repeated requests are applied one at a time (one claim per
 * day, unique in PostgreSQL too). PostgreSQL enforces the rules
 * independently: the month's total is capped at 600 by a CHECK constraint,
 * a claim is for the UTC day it is made and after the last claimed day, its
 * streak day follows the previous day's claim, and DAILY_REWARD credits
 * need a claim of the same amount.
 */
@Injectable()
export class DailyRewardClaimService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: DailyRewardSettingsService,
    private readonly wallet: CreditWalletService,
    private readonly account: CreditAccountService,
  ) {}

  async getStatus(authId: string): Promise<DailyRewardStatusView> {
    const now = new Date();
    const today = utcDay(now);
    const month = utcMonthStart(today);
    const [user, todayClaim, yesterdayClaim, monthTotal, longest, settings] =
      await Promise.all([
        this.prisma.authUser.findUnique({
          where: { id: authId },
          select: { verified: true, status: true },
        }),
        this.findClaim(this.prisma, authId, today),
        this.findClaim(this.prisma, authId, addUtcDays(today, -1)),
        this.monthTotal(this.prisma, authId, month),
        this.prisma.dailyRewardClaim.aggregate({
          where: { authId },
          _max: { streakDay: true },
        }),
        this.settings.getSettings(),
      ]);
    const balance = await this.account.getBalance(authId);
    const eligible =
      user !== null && user.verified && user.status === userStatus.ACTIVE;

    // The next claim: today, or tomorrow (possibly in a new month).
    const nextDate = todayClaim ? addUtcDays(today, 1) : today;
    const nextStreakDay = todayClaim
      ? todayClaim.streakDay + 1
      : (yesterdayClaim?.streakDay ?? 0) + 1;
    const nextMonthTotal = utcMonthStart(nextDate) === month ? monthTotal : 0;
    const nextReward = rewardForStreakDay(settings, nextStreakDay);
    const nextGranted = grantableCredits(nextReward, nextMonthTotal);
    const availableAt = dateOfUtcDay(nextDate);
    const daily = balance.sources.find(
      (source) => source.source === CreditSource.DAILY_REWARD,
    );

    return {
      today,
      month: month.slice(0, 7),
      eligible,
      canClaimNow: eligible && todayClaim === null,
      claimedToday: todayClaim !== null,
      todayClaim: todayClaim && this.toView(todayClaim),
      currentStreakDays:
        todayClaim?.streakDay ?? yesterdayClaim?.streakDay ?? 0,
      longestStreakDays: longest._max.streakDay ?? 0,
      nextClaim: {
        date: nextDate,
        availableAt: availableAt.toISOString(),
        secondsUntilAvailable: secondsUntil(availableAt, now),
        streakDay: nextStreakDay,
        rewardCredits: nextReward,
        grantedCredits: nextGranted,
      },
      nextRewardCredits: nextGranted,
      monthlyCapCredits: DAILY_REWARD_MONTHLY_CAP_CREDITS,
      claimedThisMonthCredits: monthTotal,
      remainingThisMonthCredits: Math.max(
        0,
        DAILY_REWARD_MONTHLY_CAP_CREDITS - monthTotal,
      ),
      creditBalance: {
        available: balance.available,
        usable: balance.usable,
        dailyReward: {
          granted: daily?.granted ?? '0',
          available: daily?.available ?? '0',
          used: daily?.used ?? '0',
        },
      },
    };
  }

  /**
   * Claims today's reward (UTC). 409 if today was already claimed or another
   * day is named; 403 for unverified or inactive accounts. Once the month's
   * cap is reached the claim grants 0 credits and keeps the streak.
   */
  async claim(
    authId: string,
    requestedDate?: string,
  ): Promise<DailyRewardClaimView> {
    const now = new Date();
    const today = utcDay(now);
    if (requestedDate !== undefined) {
      if (!isUtcDay(requestedDate)) {
        throw AppError.badRequest(DAILY_REWARD_MESSAGES.INVALID_DATE);
      }
      if (requestedDate < today) {
        throw AppError.conflict(DAILY_REWARD_MESSAGES.PAST_DAY);
      }
      if (requestedDate > today) {
        throw AppError.conflict(DAILY_REWARD_MESSAGES.FUTURE_DAY);
      }
    }
    const month = utcMonthStart(today);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT 1 AS locked
          FROM (SELECT pg_advisory_xact_lock(
            hashtextextended(${CLAIM_LOCK + authId}, 0)
          )) AS lock
        `;
        const user = await tx.authUser.findUnique({
          where: { id: authId },
          select: { verified: true, status: true },
        });
        if (!user || !user.verified || user.status !== userStatus.ACTIVE) {
          throw AppError.forbidden(DAILY_REWARD_MESSAGES.NOT_ELIGIBLE);
        }
        await this.lockMonth(tx, authId, month, now);

        const latest = await tx.dailyRewardClaim.findFirst({
          where: { authId },
          orderBy: { claimDate: 'desc' },
          select: { claimDate: true },
        });
        if (latest && utcDay(latest.claimDate) >= today) {
          throw AppError.conflict(DAILY_REWARD_MESSAGES.ALREADY_CLAIMED);
        }
        const yesterday = await this.findClaim(
          tx,
          authId,
          addUtcDays(today, -1),
        );
        const streakDay = (yesterday?.streakDay ?? 0) + 1;
        const settings = await this.settings.getSettings(tx);
        const rewardCredits = rewardForStreakDay(settings, streakDay);
        const grantedCredits = grantableCredits(
          rewardCredits,
          await this.monthTotal(tx, authId, month),
        );

        // Recorded even with 0 credits: the claim keeps the streak.
        const claim = await tx.dailyRewardClaim.create({
          data: {
            authId,
            claimDate: dateOfUtcDay(today),
            monthStart: dateOfUtcDay(month),
            streakDay,
            rewardCredits,
            grantedCredits,
            claimedAt: now,
          },
        });
        if (grantedCredits > 0) {
          await this.wallet.grant(
            {
              authId,
              source: CreditSource.DAILY_REWARD,
              sourceReference: `daily-reward:${today}`,
              amount: String(grantedCredits),
              description: `Daily reward (day ${streakDay} of streak)`,
            },
            { tx, at: now },
          );
        }
        return this.toView(claim);
      });
    } catch (error) {
      // A concurrent claim of the same day committed first (unique day).
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw AppError.conflict(DAILY_REWARD_MESSAGES.ALREADY_CLAIMED);
      }
      throw error;
    }
  }

  /** The caller's claims, newest first. */
  async history(
    authId: string,
    query: { limit?: number; cursor?: string; month?: string },
  ): Promise<DailyRewardHistoryPageView> {
    const limit = query.limit ?? HISTORY_PAGE_SIZE;
    if (query.cursor !== undefined && !isUtcDay(query.cursor)) {
      throw AppError.badRequest('Invalid cursor');
    }
    const where: Prisma.DailyRewardClaimWhereInput = {
      authId,
      ...(query.month ? { monthStart: dateOfUtcDay(`${query.month}-01`) } : {}),
      ...(query.cursor
        ? { claimDate: { lt: dateOfUtcDay(query.cursor) } }
        : {}),
    };
    const rows = await this.prisma.dailyRewardClaim.findMany({
      where,
      orderBy: { claimDate: 'desc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((claim) => this.toView(claim)),
      nextCursor: rows.length > limit && last ? utcDay(last.claimDate) : null,
    };
  }

  /**
   * Daily reward credits per UTC month, newest first: the current month
   * (also without claims) and earlier months with claims.
   */
  async months(
    authId: string,
    query: { limit?: number },
  ): Promise<DailyRewardMonthView[]> {
    const limit = query.limit ?? MONTHS_PAGE_SIZE;
    const current = utcMonthStart(utcDay(new Date()));
    const grouped = await this.prisma.dailyRewardClaim.groupBy({
      by: ['monthStart'],
      where: { authId },
      _sum: { grantedCredits: true },
      _count: { _all: true },
      orderBy: { monthStart: 'desc' },
    });
    const months = new Map<string, { claims: number; earned: number }>();
    months.set(current, { claims: 0, earned: 0 });
    for (const row of grouped) {
      months.set(utcDay(row.monthStart), {
        claims: row._count._all,
        earned: row._sum.grantedCredits ?? 0,
      });
    }
    return [...months.entries()]
      .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
      .slice(0, limit)
      .map(([monthStart, totals]) => ({
        month: monthStart.slice(0, 7),
        claims: totals.claims,
        earnedCredits: totals.earned,
        capCredits: DAILY_REWARD_MONTHLY_CAP_CREDITS,
        remainingCredits: Math.max(
          0,
          DAILY_REWARD_MONTHLY_CAP_CREDITS - totals.earned,
        ),
      }));
  }

  /**
   * Creates the user's row for the month if needed and locks it until the
   * transaction ends (the database trigger recomputes its total).
   */
  private async lockMonth(
    tx: Prisma.TransactionClient,
    authId: string,
    month: string,
    now: Date,
  ): Promise<void> {
    await tx.dailyRewardMonthlyTotal.createMany({
      data: [{ authId, monthStart: dateOfUtcDay(month), updatedAt: now }],
      skipDuplicates: true,
    });
    await tx.$queryRaw`
      SELECT 1 FROM "DailyRewardMonthlyTotal"
      WHERE "authId" = ${authId} AND "monthStart" = ${month}::date
      FOR UPDATE
    `;
  }

  /** Daily reward credits granted to the user in the month, from the claims. */
  private async monthTotal(
    client: Prisma.TransactionClient,
    authId: string,
    month: string,
  ): Promise<number> {
    const { _sum } = await client.dailyRewardClaim.aggregate({
      where: { authId, monthStart: dateOfUtcDay(month) },
      _sum: { grantedCredits: true },
    });
    return _sum.grantedCredits ?? 0;
  }

  private findClaim(
    client: Prisma.TransactionClient,
    authId: string,
    day: string,
  ): Promise<DailyRewardClaim | null> {
    return client.dailyRewardClaim.findUnique({
      where: { authId_claimDate: { authId, claimDate: dateOfUtcDay(day) } },
    });
  }

  private toView(claim: DailyRewardClaim): DailyRewardClaimView {
    return {
      id: claim.id,
      claimDate: utcDay(claim.claimDate),
      streakDay: claim.streakDay,
      rewardCredits: claim.rewardCredits,
      grantedCredits: claim.grantedCredits,
      limitedByMonthlyCap: claim.grantedCredits < claim.rewardCredits,
      claimedAt: claim.claimedAt.toISOString(),
    };
  }
}
