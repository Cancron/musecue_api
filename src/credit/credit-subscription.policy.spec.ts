import { BillingInterval } from '@prisma/client';
import { addBillingInterval } from '../subscription/billing.validation';
import {
  addMonthsClamped,
  creditMonthAt,
  creditMonths,
} from './credit-subscription.policy';

const at = (iso: string) => new Date(iso);
const yearly = (start: string) => {
  const periodStart = at(start);
  return {
    billingInterval: BillingInterval.YEARLY,
    periodStart,
    periodEnd: addBillingInterval(periodStart, BillingInterval.YEARLY),
  };
};

describe('credit subscription policy', () => {
  describe('addMonthsClamped (same results as PostgreSQL timestamp + interval)', () => {
    it.each([
      // Values checked against PostgreSQL: '<anchor>'::timestamp + make_interval(months => n)
      ['2026-01-31T10:00:00.000Z', 1, '2026-02-28T10:00:00.000Z'],
      ['2026-01-31T10:00:00.000Z', 2, '2026-03-31T10:00:00.000Z'],
      ['2028-02-29T10:00:00.123Z', 12, '2029-02-28T10:00:00.123Z'],
      ['2028-01-30T23:59:59.999Z', 1, '2028-02-29T23:59:59.999Z'],
      ['2026-06-01T10:00:00.000Z', 7, '2027-01-01T10:00:00.000Z'],
      ['2026-12-15T00:00:00.000Z', 1, '2027-01-15T00:00:00.000Z'],
    ])('%s + %d months = %s', (anchor, months, expected) => {
      expect(addMonthsClamped(at(anchor), months).toISOString()).toBe(expected);
    });
  });

  describe('creditMonths', () => {
    it('splits a monthly payment into its one month', () => {
      const periodStart = at('2026-06-01T10:00:00.000Z');
      const periodEnd = at('2026-07-01T10:00:00.000Z');
      expect(
        creditMonths({
          billingInterval: BillingInterval.MONTHLY,
          periodStart,
          periodEnd,
        }),
      ).toEqual([{ index: 0, start: periodStart, end: periodEnd }]);
    });

    it('splits a yearly payment into twelve contiguous months ending at the period end', () => {
      const period = yearly('2026-01-31T10:00:00.000Z');
      const months = creditMonths(period);

      expect(months).toHaveLength(12);
      expect(months.map((m) => m.index)).toEqual([...Array(12).keys()]);
      expect(months[0].start).toEqual(period.periodStart);
      expect(months[11].end).toEqual(period.periodEnd);
      for (let i = 1; i < 12; i += 1) {
        expect(months[i].start).toEqual(months[i - 1].end);
      }
      // Anchored to the 31st: month ends are clamped, not drifting.
      expect(months.slice(0, 4).map((m) => m.end.toISOString())).toEqual([
        '2026-02-28T10:00:00.000Z',
        '2026-03-31T10:00:00.000Z',
        '2026-04-30T10:00:00.000Z',
        '2026-05-31T10:00:00.000Z',
      ]);
    });

    it('handles a yearly period starting on February 29', () => {
      const period = yearly('2028-02-29T10:00:00.000Z');
      const months = creditMonths(period);

      expect(months).toHaveLength(12);
      expect(months[1].start.toISOString()).toBe('2028-03-29T10:00:00.000Z');
      expect(months[11].end.toISOString()).toBe('2029-02-28T10:00:00.000Z');
    });
  });

  describe('creditMonthAt', () => {
    const period = yearly('2026-06-01T10:00:00.000Z');

    it.each([
      [
        'before the period starts (renewal paid early)',
        '2026-06-01T09:59:00.000Z',
        0,
      ],
      ['at the period start', '2026-06-01T10:00:00.000Z', 0],
      [
        'one millisecond before the first boundary',
        '2026-07-01T09:59:59.999Z',
        0,
      ],
      ['at the first boundary', '2026-07-01T10:00:00.000Z', 1],
      ['in the middle of the year', '2026-12-24T00:00:00.000Z', 6],
      ['in the last month', '2027-05-31T00:00:00.000Z', 11],
    ])('is due %s', (_case, now, index) => {
      expect(creditMonthAt(period, at(now))?.index).toBe(index);
    });

    it('is null once the paid period has ended', () => {
      expect(creditMonthAt(period, period.periodEnd)).toBeNull();
    });
  });
});
