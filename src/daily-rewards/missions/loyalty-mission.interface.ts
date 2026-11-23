import type { LoyaltyMissionRecurrence } from '@prisma/client';

/** A mission as administrators see it. */
export interface LoyaltyMissionAdminView {
  id: string;
  title: string;
  description: string | null;
  recurrence: LoyaltyMissionRecurrence;
  requiredCompletions: number;
  rewardCredits: number;
  active: boolean;
  /** Completions before this time never count. */
  startsAt: string;
  /** Rewards granted so far (all users and periods). */
  awards: number;
  createdAt: string;
  updatedAt: string;
}

/** An active mission with the caller's progress in its current period. */
export interface LoyaltyMissionProgressView {
  id: string;
  title: string;
  description: string | null;
  recurrence: LoyaltyMissionRecurrence;
  requiredCompletions: number;
  rewardCredits: number;
  period: {
    key: string;
    startsAt: string;
    /** null for ONCE missions. */
    endsAt: string | null;
  };
  /** Verified completions counted in the period (not before the mission). */
  completions: number;
  remainingCompletions: number;
  /** Rewarded for this period (for ONCE: ever). */
  completed: boolean;
  award: { id: string; credits: number; awardedAt: string } | null;
}

export interface LoyaltyMissionOverviewView {
  /** The caller's verified makeup completions. */
  verifiedCompletions: { total: number; thisWeek: number; thisMonth: number };
  missions: LoyaltyMissionProgressView[];
  /** MISSION_REWARD credits received in total. */
  totalEarnedCredits: number;
}

/** One mission reward the caller received. */
export interface LoyaltyMissionAwardView {
  id: string;
  missionId: string;
  title: string;
  recurrence: LoyaltyMissionRecurrence;
  periodKey: string;
  periodStart: string;
  periodEnd: string | null;
  requiredCompletions: number;
  credits: number;
  awardedAt: string;
}
