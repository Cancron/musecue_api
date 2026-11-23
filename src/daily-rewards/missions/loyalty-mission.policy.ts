import { LoyaltyMissionRecurrence } from '@prisma/client';

/**
 * Pure rules of loyalty missions (no database access). Weeks are UTC weeks
 * from Monday 00:00 to the next Monday (as PostgreSQL's date_trunc('week')),
 * months are UTC calendar months.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const LOYALTY_MISSION_LIMITS = {
  TITLE_MAX: 100,
  DESCRIPTION_MAX: 500,
  REQUIRED_COMPLETIONS_MIN: 1,
  REQUIRED_COMPLETIONS_MAX: 100,
  REWARD_CREDITS_MIN: 1,
  REWARD_CREDITS_MAX: 100_000,
} as const;

/** The credit reference of a mission award's MISSION_REWARD credits. */
export const missionRewardReference = (awardId: string) =>
  `loyalty-mission:${awardId}`;

/** One period in which a mission can be completed once. */
export interface MissionPeriod {
  /** "once", or the first UTC day of the week or month (YYYY-MM-DD). */
  key: string;
  start: Date;
  /** Exclusive; null for ONCE (never ends). */
  end: Date | null;
}

/** The period of a mission that contains `at`. */
export function missionPeriod(
  recurrence: LoyaltyMissionRecurrence,
  at: Date,
  startsAt: Date,
): MissionPeriod {
  switch (recurrence) {
    case LoyaltyMissionRecurrence.ONCE:
      return { key: 'once', start: startsAt, end: null };
    case LoyaltyMissionRecurrence.WEEKLY: {
      const sinceMonday = (at.getUTCDay() + 6) % 7;
      const start = new Date(
        Date.UTC(
          at.getUTCFullYear(),
          at.getUTCMonth(),
          at.getUTCDate() - sinceMonday,
        ),
      );
      return {
        key: start.toISOString().slice(0, 10),
        start,
        end: new Date(start.getTime() + 7 * DAY_MS),
      };
    }
    case LoyaltyMissionRecurrence.MONTHLY: {
      const start = new Date(
        Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1),
      );
      return {
        key: start.toISOString().slice(0, 10),
        start,
        end: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)),
      };
    }
  }
}

/**
 * The completions that count for a mission in a period: those in the period
 * and not before the mission started.
 */
export function countingWindow(
  period: MissionPeriod,
  startsAt: Date,
): { from: Date; to: Date | null } {
  return {
    from:
      period.start.getTime() >= startsAt.getTime() ? period.start : startsAt,
    to: period.end,
  };
}
