import { DAILY_REWARD_MONTHLY_CAP_CREDITS } from './daily-reward-settings.constants';
import type { DailyRewardSettingsValues } from './interfaces/daily-reward-settings.interface';

/**
 * Pure rules of daily reward claims (no database access). Days and months
 * are UTC calendar days and months, written as `YYYY-MM-DD`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC calendar day of `at`, e.g. "2027-01-31". */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The first day of the UTC calendar month of `day`, e.g. "2027-01-01". */
export function utcMonthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** The UTC day `offset` days after `day` (negative for earlier days). */
export function addUtcDays(day: string, offset: number): string {
  return utcDay(new Date(dateOfUtcDay(day).getTime() + offset * DAY_MS));
}

/** Midnight UTC of `day`, as stored in DATE columns. */
export function dateOfUtcDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * The configured reward for the `streakDay`-th consecutive claimed day:
 * min(starting + (streakDay - 1) * increment, max).
 */
export function rewardForStreakDay(
  settings: DailyRewardSettingsValues,
  streakDay: number,
): number {
  if (!Number.isSafeInteger(streakDay) || streakDay < 1) {
    throw new RangeError(`Invalid streak day: ${streakDay}`);
  }
  const {
    startingRewardCredits,
    dailyIncrementCredits,
    maxDailyRewardCredits,
  } = settings;
  if (startingRewardCredits >= maxDailyRewardCredits) {
    return maxDailyRewardCredits;
  }
  // Days needed to reach the maximum; beyond them the reward stays at it
  // (also avoids overflow for very long streaks).
  const stepsToMax =
    dailyIncrementCredits === 0
      ? Infinity
      : Math.ceil(
          (maxDailyRewardCredits - startingRewardCredits) /
            dailyIncrementCredits,
        );
  if (streakDay - 1 >= stepsToMax) return maxDailyRewardCredits;
  return startingRewardCredits + (streakDay - 1) * dailyIncrementCredits;
}

/**
 * The credits a claim may grant: the day's reward, reduced so the month's
 * daily reward credits never exceed the monthly cap. 0 when the cap is
 * reached (the claim is refused).
 */
export function grantableCredits(
  rewardCredits: number,
  monthTotalCredits: number,
  monthlyCap: number = DAILY_REWARD_MONTHLY_CAP_CREDITS,
): number {
  return Math.max(0, Math.min(rewardCredits, monthlyCap - monthTotalCredits));
}
