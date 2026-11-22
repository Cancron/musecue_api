import { dailyRewardSettingsViolation } from './daily-reward-settings.policy';

describe('dailyRewardSettingsViolation', () => {
  it.each([
    ['the defaults', 10, 10, 50],
    ['a flat reward (no increment)', 25, 0, 25],
    ['a starting reward equal to the maximum', 50, 10, 50],
    ['the largest allowed daily reward', 1, 600, 600],
  ])('accepts %s', (_case, starting, increment, max) => {
    expect(
      dailyRewardSettingsViolation({
        startingRewardCredits: starting,
        dailyIncrementCredits: increment,
        maxDailyRewardCredits: max,
      }),
    ).toBeNull();
  });

  it('rejects a starting reward above the maximum daily reward', () => {
    expect(
      dailyRewardSettingsViolation({
        startingRewardCredits: 60,
        dailyIncrementCredits: 10,
        maxDailyRewardCredits: 50,
      }),
    ).toBe(
      'startingRewardCredits (60) cannot exceed maxDailyRewardCredits (50)',
    );
  });
});
