/** One claimed day. */
export interface DailyRewardClaimView {
  id: string;
  /** The UTC calendar day claimed (YYYY-MM-DD). */
  claimDate: string;
  /** Position in the streak of consecutive claimed days (1 = first day). */
  streakDay: number;
  /** The configured reward for that streak day. */
  rewardCredits: number;
  /**
   * Credits actually granted: the reward, reduced only by the claim that
   * reaches the monthly cap.
   */
  grantedCredits: number;
  claimedAt: string;
}

/** The caller's daily reward state at the current UTC day. */
export interface DailyRewardStatusView {
  /** The current UTC calendar day (YYYY-MM-DD) and month (YYYY-MM). */
  today: string;
  month: string;
  claimedToday: boolean;
  todayClaim: DailyRewardClaimView | null;
  /** The current streak: today's or yesterday's streak day, else 0. */
  currentStreakDays: number;
  /**
   * Credits the next claim would grant (today's if not claimed yet,
   * otherwise tomorrow's), after the monthly cap; 0 if the cap is reached.
   */
  nextRewardCredits: number;
  monthlyCapCredits: number;
  /** Daily reward credits granted in the current UTC month. */
  claimedThisMonthCredits: number;
  remainingThisMonthCredits: number;
}
