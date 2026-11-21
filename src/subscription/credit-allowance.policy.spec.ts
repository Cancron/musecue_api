import { BillingInterval, CreditSource } from '@prisma/client';
import {
  addMonthsClamped,
  dueAllowances,
  isCreditSourceUsable,
  paymentAllowancePeriods,
  paymentAllowanceReference,
  scheduledAllocationTime,
} from './credit-allowance.policy';
import type { SubscriptionRecord } from './subscription-access.policy';

const iso = (value: string) => new Date(value);
const AMOUNTS = { trialCredits: 50 };

const record = (
  overrides: Partial<SubscriptionRecord> = {},
): SubscriptionRecord => ({
  trialUsed: false,
  trialStartedAt: null,
  trialExpiresAt: null,
  billingInterval: null,
  proStartedAt: null,
  proExpiresAt: null,
  proCanceledAt: null,
  ...overrides,
});
const trial = (start: string, end: string) =>
  record({
    trialUsed: true,
    trialStartedAt: iso(start),
    trialExpiresAt: iso(end),
  });
const paid = (
  start: string,
  end: string,
  billingInterval: BillingInterval = BillingInterval.MONTHLY,
) =>
  record({
    billingInterval,
    proStartedAt: iso(start),
    proExpiresAt: iso(end),
  });

describe('credit allowance policy', () => {
  describe('addMonthsClamped', () => {
    it('keeps the anchor day, clamped to shorter months (like Stripe billing)', () => {
      const anchor = iso('2026-01-31T10:00:00.000Z');
      expect(
        [0, 1, 2, 3, 12, 13].map((m) =>
          addMonthsClamped(anchor, m).toISOString(),
        ),
      ).toEqual([
        '2026-01-31T10:00:00.000Z',
        '2026-02-28T10:00:00.000Z',
        '2026-03-31T10:00:00.000Z',
        '2026-04-30T10:00:00.000Z',
        '2027-01-31T10:00:00.000Z',
        '2027-02-28T10:00:00.000Z',
      ]);
    });

    it('handles leap years', () => {
      expect(
        addMonthsClamped(iso('2028-01-29T00:00:00.000Z'), 1).toISOString(),
      ).toBe('2028-02-29T00:00:00.000Z');
    });
  });

  describe('paymentAllowancePeriods', () => {
    const payment = (
      billingInterval: BillingInterval,
      start: string,
      end: string,
    ) => ({
      billingInterval,
      periodStart: iso(start),
      periodEnd: iso(end),
    });
    const asIso = (periods: { start: Date; end: Date }[]) =>
      periods.map((p) => [p.start.toISOString(), p.end.toISOString()]);

    it('is the whole billing period for a monthly payment', () => {
      expect(
        asIso(
          paymentAllowancePeriods(
            payment(
              BillingInterval.MONTHLY,
              '2026-03-15T09:00:00.000Z',
              '2026-04-15T09:00:00.000Z',
            ),
          ),
        ),
      ).toEqual([['2026-03-15T09:00:00.000Z', '2026-04-15T09:00:00.000Z']]);
    });

    it("follows Stripe's anchored monthly periods exactly (Feb 28 -> Mar 31)", () => {
      expect(
        asIso(
          paymentAllowancePeriods(
            payment(
              BillingInterval.MONTHLY,
              '2026-02-28T10:00:00.000Z',
              '2026-03-31T10:00:00.000Z',
            ),
          ),
        ),
      ).toEqual([['2026-02-28T10:00:00.000Z', '2026-03-31T10:00:00.000Z']]);
    });

    it('splits a yearly payment into twelve months from its start, clamped', () => {
      const periods = paymentAllowancePeriods(
        payment(
          BillingInterval.YEARLY,
          '2026-01-31T00:00:00.000Z',
          '2027-01-31T00:00:00.000Z',
        ),
      );
      expect(periods).toHaveLength(12);
      expect(asIso(periods.slice(0, 3))).toEqual([
        ['2026-01-31T00:00:00.000Z', '2026-02-28T00:00:00.000Z'],
        ['2026-02-28T00:00:00.000Z', '2026-03-31T00:00:00.000Z'],
        ['2026-03-31T00:00:00.000Z', '2026-04-30T00:00:00.000Z'],
      ]);
      expect(asIso(periods.slice(-1))).toEqual([
        ['2026-12-31T00:00:00.000Z', '2027-01-31T00:00:00.000Z'],
      ]);
      // Contiguous: each month starts where the previous one ends.
      for (let i = 1; i < periods.length; i += 1) {
        expect(periods[i].start).toEqual(periods[i - 1].end);
      }
    });

    it('is nothing for an empty period', () => {
      expect(
        paymentAllowancePeriods(
          payment(
            BillingInterval.MONTHLY,
            '2026-03-15T09:00:00.000Z',
            '2026-03-15T09:00:00.000Z',
          ),
        ),
      ).toEqual([]);
    });

    it('references each month of each payment once', () => {
      expect(
        paymentAllowanceReference('pay-1', iso('2026-03-15T09:00:00.000Z')),
      ).toBe('payment:pay-1:2026-03-15T09:00:00.000Z');
    });
  });

  describe('scheduledAllocationTime', () => {
    const month = {
      start: iso('2026-08-10T00:00:00.000Z'),
      end: iso('2026-09-10T00:00:00.000Z'),
    };
    it('is now for a month that has begun or not begun yet', () => {
      const during = iso('2026-08-10T00:00:30.000Z');
      const before = iso('2026-08-09T23:00:00.000Z');
      expect(scheduledAllocationTime(month, during)).toEqual(during);
      expect(scheduledAllocationTime(month, before)).toEqual(before);
    });
    it('is the month start for a month that already ended', () => {
      expect(scheduledAllocationTime(month, month.end)).toEqual(month.start);
      expect(
        scheduledAllocationTime(month, iso('2026-12-01T00:00:00.000Z')),
      ).toEqual(month.start);
    });
  });

  describe('dueAllowances (trial only)', () => {
    it('is nothing for a free user (no record, or never used)', () => {
      const now = iso('2026-05-01T00:00:00.000Z');
      expect(dueAllowances(null, now, AMOUNTS)).toEqual([]);
      expect(dueAllowances(record(), now, AMOUNTS)).toEqual([]);
    });

    it('grants the trial allowance for the trial, expiring with it', () => {
      const r = trial('2026-05-01T12:00:00.000Z', '2026-05-08T12:00:00.000Z');
      expect(
        dueAllowances(r, iso('2026-05-03T00:00:00.000Z'), AMOUNTS),
      ).toEqual([
        {
          source: CreditSource.TRIAL,
          sourceReference: 'trial:2026-05-01T12:00:00.000Z',
          amount: 50,
          expiresAt: iso('2026-05-08T12:00:00.000Z'),
          description: 'Free trial credits',
        },
      ]);
    });

    it('grants nothing once the trial has ended', () => {
      expect(
        dueAllowances(
          trial('2026-05-01T00:00:00.000Z', '2026-05-08T00:00:00.000Z'),
          iso('2026-05-08T00:00:00.000Z'),
          AMOUNTS,
        ),
      ).toEqual([]);
    });

    it('never grants monthly Pro credits: those come only with a payment', () => {
      expect(
        dueAllowances(
          paid('2026-05-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
          iso('2026-05-10T00:00:00.000Z'),
          AMOUNTS,
        ),
      ).toEqual([]);
    });

    it('grants nothing once paid Pro is bought during the trial', () => {
      const r = record({
        trialUsed: true,
        trialStartedAt: iso('2026-05-01T00:00:00.000Z'),
        trialExpiresAt: iso('2026-05-08T00:00:00.000Z'),
        billingInterval: BillingInterval.MONTHLY,
        proStartedAt: iso('2026-05-05T00:00:00.000Z'),
        proExpiresAt: iso('2026-06-05T00:00:00.000Z'),
      });
      expect(
        dueAllowances(r, iso('2026-05-06T00:00:00.000Z'), AMOUNTS),
      ).toEqual([]);
    });

    it('uses the configured amount', () => {
      const r = trial('2026-05-01T00:00:00.000Z', '2026-05-08T00:00:00.000Z');
      expect(
        dueAllowances(r, iso('2026-05-02T00:00:00.000Z'), {
          trialCredits: 75,
        })[0]?.amount,
      ).toBe(75);
    });
  });

  describe('isCreditSourceUsable', () => {
    const now = iso('2026-06-10T00:00:00.000Z');
    const expiredPro = paid(
      '2026-04-01T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
    );
    const activePro = paid(
      '2026-06-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
    );
    const activeTrial = trial(
      '2026-06-08T00:00:00.000Z',
      '2026-06-15T00:00:00.000Z',
    );

    it.each([CreditSource.PURCHASE, CreditSource.REFERRAL])(
      '%s credits are usable with, without, or after Pro',
      (source) => {
        expect(isCreditSourceUsable(source, null, now)).toBe(true);
        expect(isCreditSourceUsable(source, expiredPro, now)).toBe(true);
        expect(isCreditSourceUsable(source, activePro, now)).toBe(true);
      },
    );

    it('subscription credits are usable only while the paid term is active', () => {
      expect(
        isCreditSourceUsable(CreditSource.SUBSCRIPTION, activePro, now),
      ).toBe(true);
      expect(
        isCreditSourceUsable(CreditSource.SUBSCRIPTION, expiredPro, now),
      ).toBe(false);
      expect(
        isCreditSourceUsable(CreditSource.SUBSCRIPTION, activeTrial, now),
      ).toBe(false);
      expect(isCreditSourceUsable(CreditSource.SUBSCRIPTION, null, now)).toBe(
        false,
      );
    });

    it('trial credits are usable only while the trial is active and Pro has not been bought', () => {
      expect(isCreditSourceUsable(CreditSource.TRIAL, activeTrial, now)).toBe(
        true,
      );
      const upgraded = record({
        ...activeTrial,
        billingInterval: BillingInterval.MONTHLY,
        proStartedAt: iso('2026-06-09T00:00:00.000Z'),
        proExpiresAt: iso('2026-07-09T00:00:00.000Z'),
      });
      expect(isCreditSourceUsable(CreditSource.TRIAL, upgraded, now)).toBe(
        false,
      );
      expect(
        isCreditSourceUsable(
          CreditSource.TRIAL,
          activeTrial,
          iso('2026-06-15T00:00:00.000Z'),
        ),
      ).toBe(false);
      expect(isCreditSourceUsable(CreditSource.TRIAL, activePro, now)).toBe(
        false,
      );
    });
  });
});
