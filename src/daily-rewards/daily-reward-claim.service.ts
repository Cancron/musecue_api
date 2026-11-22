import { Injectable } from '@nestjs/common';
import { CreditSource, Prisma, type DailyRewardClaim } from '@prisma/client';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import { CreditWalletService } from '../credits/credit-wallet.service';
import {
  addUtcDays,
  dateOfUtcDay,
  grantableCredits,
  rewardForStreakDay,
  utcDay,
  utcMonthStart,
} from './daily-reward-claim.policy';
import { DAILY_REWARD_MONTHLY_CAP_CREDITS } from './daily-reward-settings.constants';
import { DailyRewardSettingsService } from './daily-reward-settings.service';
import type {
  DailyRewardClaimView,
  DailyRewardStatusView,
} from './interfaces/daily-reward-claim.interface';

export const DAILY_REWARD_MESSAGES = {
  ALREADY_CLAIMED: "Today's daily reward has already been claimed",
  MONTHLY_CAP_REACHED: `The monthly limit of ${DAILY_REWARD_MONTHLY_CAP_CREDITS} daily reward credits has been reached`,
} as const;

/**
 * Daily reward claims: one per user and UTC calendar day, granted as
 * DAILY_REWARD credits (never expiring) in the user's wallet.
 *
 * A user receives at most DAILY_REWARD_MONTHLY_CAP_CREDITS (600) daily
 * reward credits per UTC calendar month. A claim runs in one transaction
 * that first locks the user's DailyRewardMonthlyTotal row for the month, so
 * a user's concurrent claims are applied one at a time; the claim that
 * reaches the cap grants only the rest, and later claims that month are
 * refused. PostgreSQL enforces the same cap independently (a trigger sets
 * the month's total from its claims, and a CHECK constraint refuses a total
 * above 600), and the claim, its month total and the wallet credits commit
 * together or not at all.
 */
@Injectable()
export class DailyRewardClaimService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: DailyRewardSettingsService,
    private readonly wallet: CreditWalletService,
  ) {}

  async getStatus(authId: string): Promise<DailyRewardStatusView> {
    const now = new Date();
    const today = utcDay(now);
    const month = utcMonthStart(today);
    const [todayClaim, yesterdayClaim, monthTotal, settings] =
      await Promise.all([
        this.findClaim(this.prisma, authId, today),
        this.findClaim(this.prisma, authId, addUtcDays(today, -1)),
        this.monthTotal(this.prisma, authId, month),
        this.settings.getSettings(),
      ]);

    let nextReward: number;
    if (todayClaim) {
      // The next claim is tomorrow, possibly in a new month.
      const tomorrow = addUtcDays(today, 1);
      const tomorrowTotal = utcMonthStart(tomorrow) === month ? monthTotal : 0;
      nextReward = grantableCredits(
        rewardForStreakDay(settings, todayClaim.streakDay + 1),
        tomorrowTotal,
      );
    } else {
      nextReward = grantableCredits(
        rewardForStreakDay(settings, (yesterdayClaim?.streakDay ?? 0) + 1),
        monthTotal,
      );
    }

    return {
      today,
      month: month.slice(0, 7),
      claimedToday: todayClaim !== null,
      todayClaim: todayClaim && this.toView(todayClaim),
      currentStreakDays:
        todayClaim?.streakDay ?? yesterdayClaim?.streakDay ?? 0,
      nextRewardCredits: nextReward,
      monthlyCapCredits: DAILY_REWARD_MONTHLY_CAP_CREDITS,
      claimedThisMonthCredits: monthTotal,
      remainingThisMonthCredits: Math.max(
        0,
        DAILY_REWARD_MONTHLY_CAP_CREDITS - monthTotal,
      ),
    };
  }

  /**
   * Claims today's reward. 409 if today was already claimed or the month's
   * cap is reached (nothing is written in either case).
   */
  async claim(authId: string): Promise<DailyRewardClaimView> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const today = utcDay(now);
        const month = utcMonthStart(today);
        await this.lockMonth(tx, authId, month, now);

        if (await this.findClaim(tx, authId, today)) {
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
        if (grantedCredits === 0) {
          throw AppError.conflict(DAILY_REWARD_MESSAGES.MONTHLY_CAP_REACHED);
        }

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

  /**
   * Creates the user's row for the month if needed and locks it until the
   * transaction ends: the serialization point of the user's claims.
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
      claimedAt: claim.claimedAt.toISOString(),
    };
  }
}
