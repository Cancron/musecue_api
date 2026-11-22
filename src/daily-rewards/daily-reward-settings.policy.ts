import type { DailyRewardSettingsValues } from './interfaces/daily-reward-settings.interface';

/**
 * Rules that involve more than one setting, checked on the complete
 * configuration a partial update would produce (stored values merged with
 * the request). Single-field bounds are checked by the request DTO.
 *
 * Returns the reason the configuration is invalid, or null if it is valid.
 */
export function dailyRewardSettingsViolation(
  settings: DailyRewardSettingsValues,
): string | null {
  if (settings.startingRewardCredits > settings.maxDailyRewardCredits) {
    return (
      `startingRewardCredits (${settings.startingRewardCredits}) cannot ` +
      `exceed maxDailyRewardCredits (${settings.maxDailyRewardCredits})`
    );
  }
  return null;
}
