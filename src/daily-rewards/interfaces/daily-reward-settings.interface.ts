import type { ActivityLogMetadata } from '../../common/services/activity-log.service';

/**
 * The editable daily reward settings, in whole credits. The reward for the
 * n-th consecutive day is min(starting + (n - 1) * increment, max).
 */
export interface DailyRewardSettingsValues {
  /** Reward for the first day. */
  startingRewardCredits: number;
  /** Added to the reward for each further consecutive day. */
  dailyIncrementCredits: number;
  /** The largest reward for a single day. */
  maxDailyRewardCredits: number;
}

export interface DailyRewardSettingsView extends DailyRewardSettingsValues {
  /**
   * Read-only: the most daily reward credits one user can receive per UTC
   * calendar month (a fixed product rule).
   */
  monthlyCapCredits: number;
  /** When the stored settings were last written. */
  updatedAt: string;
}

export type UpdateDailyRewardSettingsInput = Partial<DailyRewardSettingsValues>;

export interface DailyRewardSettingsChangeActor extends ActivityLogMetadata {
  actionedBy: string;
}
