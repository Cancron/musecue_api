import { IsInt, Max, Min, ValidateIf } from 'class-validator';
import { DAILY_REWARD_SETTINGS_LIMITS as LIMITS } from '../daily-reward-settings.constants';

const isPresent = (_: object, value: unknown) => value !== undefined;

/**
 * Partial update of the daily reward settings, in whole credits. Omitted
 * fields are left unchanged; a request with any invalid field changes
 * nothing. The result must also keep startingRewardCredits <=
 * maxDailyRewardCredits (checked by the service against the stored values).
 *
 * `ValidateIf` is used instead of `IsOptional` so that an explicit `null` is
 * rejected rather than skipping validation.
 */
export class UpdateDailyRewardSettingsDto {
  /** Reward for the first day (1-600). */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.STARTING_REWARD_CREDITS_MIN)
  @Max(LIMITS.STARTING_REWARD_CREDITS_MAX)
  startingRewardCredits?: number;

  /** Added to the reward for each further consecutive day (0-600). */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.DAILY_INCREMENT_CREDITS_MIN)
  @Max(LIMITS.DAILY_INCREMENT_CREDITS_MAX)
  dailyIncrementCredits?: number;

  /** The largest reward for a single day (1-600). */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.MAX_DAILY_REWARD_CREDITS_MIN)
  @Max(LIMITS.MAX_DAILY_REWARD_CREDITS_MAX)
  maxDailyRewardCredits?: number;
}
