import {
  addUtcDays,
  grantableCredits,
  rewardForStreakDay,
  utcDay,
  utcMonthStart,
} from './daily-reward-claim.policy';

const DEFAULTS = {
  startingRewardCredits: 10,
  dailyIncrementCredits: 10,
  maxDailyRewardCredits: 50,
};

describe('daily reward claim policy', () => {
  describe('UTC calendar days and months', () => {
    it.each([
      ['2027-01-31T23:59:59.999Z', '2027-01-31', '2027-01-01'],
      ['2027-02-01T00:00:00.000Z', '2027-02-01', '2027-02-01'],
      // A time zone offset never moves the day: only UTC counts.
      ['2027-03-01T01:30:00.000+02:00', '2027-02-28', '2027-02-01'],
    ])('%s is UTC day %s of the month starting %s', (at, day, month) => {
      expect(utcDay(new Date(at))).toBe(day);
      expect(utcMonthStart(utcDay(new Date(at)))).toBe(month);
    });

    it.each([
      ['2027-01-31', 1, '2027-02-01'],
      ['2027-03-01', -1, '2027-02-28'],
      ['2028-03-01', -1, '2028-02-29'],
      ['2027-12-31', 1, '2028-01-01'],
    ])('%s %+d day(s) is %s', (day, offset, expected) => {
      expect(addUtcDays(day, offset)).toBe(expected);
    });
  });

  describe('rewardForStreakDay', () => {
    it('rises by the increment from the starting reward up to the maximum (defaults: 10, 20, 30, 40, 50, 50)', () => {
      expect(
        [1, 2, 3, 4, 5, 6, 30].map((day) => rewardForStreakDay(DEFAULTS, day)),
      ).toEqual([10, 20, 30, 40, 50, 50, 50]);
    });

    it('never overshoots the maximum when the increment does not divide the gap', () => {
      const settings = {
        startingRewardCredits: 10,
        dailyIncrementCredits: 15,
        maxDailyRewardCredits: 50,
      };
      expect(
        [1, 2, 3, 4, 5].map((day) => rewardForStreakDay(settings, day)),
      ).toEqual([10, 25, 40, 50, 50]);
    });

    it('keeps a flat reward with a zero increment, and handles very long streaks', () => {
      const flat = { ...DEFAULTS, dailyIncrementCredits: 0 };
      expect(rewardForStreakDay(flat, 1)).toBe(10);
      expect(rewardForStreakDay(flat, 1_000_000)).toBe(10);
      expect(rewardForStreakDay(DEFAULTS, Number.MAX_SAFE_INTEGER)).toBe(50);
    });

    it('starts at the maximum when the starting reward equals it', () => {
      const settings = { ...DEFAULTS, startingRewardCredits: 50 };
      expect(rewardForStreakDay(settings, 1)).toBe(50);
      expect(rewardForStreakDay(settings, 2)).toBe(50);
    });

    it.each([0, -1, 1.5, Number.NaN])('rejects streak day %p', (day) => {
      expect(() => rewardForStreakDay(DEFAULTS, day)).toThrow(RangeError);
    });
  });

  describe('grantableCredits (600 per UTC month)', () => {
    it.each([
      [50, 0, 50],
      [50, 550, 50],
      [50, 580, 20],
      [50, 599, 1],
      [50, 600, 0],
      [600, 0, 600],
      [10, 600, 0],
    ])(
      'a reward of %i with %i already granted this month grants %i',
      (reward, total, expected) => {
        expect(grantableCredits(reward, total)).toBe(expected);
      },
    );

    it('never grants more than the cap even from an inconsistent total', () => {
      expect(grantableCredits(50, 700)).toBe(0);
    });
  });
});
