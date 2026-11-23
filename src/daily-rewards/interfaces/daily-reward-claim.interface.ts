/** One claimed day. */
export interface DailyRewardClaimView {
  id: string;
  /** The UTC calendar day claimed (YYYY-MM-DD). */
  claimDate: string;
  /** Position in the streak of consecutive claimed days (1 = first day). */
  streakDay: number;
  /** The configured reward for that streak day (settings at claim time). */
  rewardCredits: number;
  /**
   * Credits actually granted: the reward, reduced by the monthly cap (0 once
   * the month's 600 credits were granted; the claim still keeps the streak).
   */
  grantedCredits: number;
  /** Whether the monthly cap reduced this claim's credits. */
  limitedByMonthlyCap: boolean;
  claimedAt: string;
}

/** The next claim the caller can make. */
export interface DailyRewardNextClaimView {
  /** The UTC day of the next claim: today if not claimed yet, else tomorrow. */
  date: string;
  /** When it can be claimed (the start of that UTC day). */
  availableAt: string;
  /** 0 when it can be claimed now. */
  secondsUntilAvailable: number;
  /** Its streak day if claimed on `date`. */
  streakDay: number;
  /** The reward with the current settings. */
  rewardCredits: number;
  /** What it would grant after the monthly cap of its month. */
  grantedCredits: number;
}

/** The caller's daily reward state at the current UTC day. */
export interface DailyRewardStatusView {
  /** The current UTC calendar day (YYYY-MM-DD) and month (YYYY-MM). */
  today: string;
  month: string;
  /** Verified and active accounts can claim. */
  eligible: boolean;
  /** Whether POST /v1/daily-rewards/claim would grant today's reward now. */
  canClaimNow: boolean;
  claimedToday: boolean;
  todayClaim: DailyRewardClaimView | null;
  /** The current streak: today's or yesterday's streak day, else 0. */
  currentStreakDays: number;
  /** The longest streak the caller ever had. */
  longestStreakDays: number;
  nextClaim: DailyRewardNextClaimView;
  /** Same as nextClaim.grantedCredits. */
  nextRewardCredits: number;
  monthlyCapCredits: number;
  /**
   * Daily reward credits granted in the current UTC month (whether spent or
   * not) and what is left of the cap.
   */
  claimedThisMonthCredits: number;
  remainingThisMonthCredits: number;
  /** The caller's credits (all sources) and their daily reward credits. */
  creditBalance: {
    available: string;
    usable: string;
    dailyReward: { granted: string; available: string; used: string };
  };
}

/** GET /v1/daily-rewards/history: claims, newest first. */
export interface DailyRewardHistoryPageView {
  items: DailyRewardClaimView[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

/** Daily reward credits of one UTC month. */
export interface DailyRewardMonthView {
  /** YYYY-MM */
  month: string;
  claims: number;
  /** Credits granted (counted towards the cap even once spent). */
  earnedCredits: number;
  capCredits: number;
  remainingCredits: number;
}
