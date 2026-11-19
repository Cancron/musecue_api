import { BillingInterval, CreditSource } from '@prisma/client';
import {
  addMonthsClamped,
  dueTrialAllowance,
  isCreditSourceUsable,
  paidAllowancePeriod,
  paidAllowanceReference,
} from './credit-allowance.policy';
import type { SubscriptionRecord } from './subscription-access.policy';

const iso = (value: string) => new Date(value);
const { MONTHLY, YEARLY } = BillingInterval;

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
  billingInterval: BillingInterval = MONTHLY,
) =>
  record({
    billingInterval,
    proStartedAt: iso(start),
    proExpiresAt: iso(end),
  });
const payment = (
  start: string,
  end: string,
  billingInterval: BillingInterval = MONTHLY,
) => ({ periodStart: iso(start), periodEnd: iso(end), billingInterval });

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

  describe('paidAllowancePeriod', () => {
    it('is exactly the paid period for monthly billing, including anchored periods', () => {
      // Stripe bills a subscription anchored on the 31st Feb 28 -> Mar 31.
      const anchored = payment(
        '2026-02-28T10:00:00.000Z',
        '2026-03-31T10:00:00.000Z',
      );
      for (const at of [
        '2026-02-28T10:00:00.000Z',
        '2026-03-29T00:00:00.000Z',
        '2026-03-31T09:59:59.999Z',
      ]) {
        expect(paidAllowancePeriod(anchored, iso(at))).toEqual({
          start: iso('2026-02-28T10:00:00.000Z'),
          end: iso('2026-03-31T10:00:00.000Z'),
        });
      }
    });

    it('gives the first period to a payment confirmed before its period starts', () => {
      expect(
        paidAllowancePeriod(
          payment('2026-05-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
          iso('2026-04-30T23:00:00.000Z'),
        ),
      ).toEqual({
        start: iso('2026-05-01T00:00:00.000Z'),
        end: iso('2026-06-01T00:00:00.000Z'),
      });
    });

    it('is null from the end of the paid period (the billing boundary) on', () => {
      const p = payment('2026-05-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
      expect(
        paidAllowancePeriod(p, iso('2026-06-01T00:00:00.000Z')),
      ).toBeNull();
      expect(
        paidAllowancePeriod(p, iso('2026-09-01T00:00:00.000Z')),
      ).toBeNull();
    });

    it('splits a yearly payment into months from its start', () => {
      const yearly = payment(
        '2026-01-31T00:00:00.000Z',
        '2027-01-31T00:00:00.000Z',
        YEARLY,
      );
      expect(
        paidAllowancePeriod(yearly, iso('2026-01-31T00:00:00.000Z')),
      ).toEqual({
        start: iso('2026-01-31T00:00:00.000Z'),
        end: iso('2026-02-28T00:00:00.000Z'),
      });
      expect(
        paidAllowancePeriod(yearly, iso('2026-03-05T00:00:00.000Z')),
      ).toEqual({
        start: iso('2026-02-28T00:00:00.000Z'),
        end: iso('2026-03-31T00:00:00.000Z'),
      });
      expect(
        paidAllowancePeriod(yearly, iso('2026-12-31T12:00:00.000Z')),
      ).toEqual({
        start: iso('2026-12-31T00:00:00.000Z'),
        end: iso('2027-01-31T00:00:00.000Z'),
      });
    });

    it('switches yearly months at the exact anchor instant', () => {
      const yearly = payment(
        '2026-01-10T08:00:00.000Z',
        '2027-01-10T08:00:00.000Z',
        YEARLY,
      );
      expect(
        paidAllowancePeriod(yearly, iso('2026-02-10T07:59:59.999Z'))?.start,
      ).toEqual(iso('2026-01-10T08:00:00.000Z'));
      expect(
        paidAllowancePeriod(yearly, iso('2026-02-10T08:00:00.000Z'))?.start,
      ).toEqual(iso('2026-02-10T08:00:00.000Z'));
    });
  });

  describe('references', () => {
    it('names the payment and the period, so a period is granted once', () => {
      expect(
        paidAllowanceReference('pay-1', iso('2026-05-01T00:00:00.000Z')),
      ).toBe('payment:pay-1:2026-05-01T00:00:00.000Z');
    });
  });

  describe('dueTrialAllowance', () => {
    it('is nothing for a free user (no record, or never used)', () => {
      const now = iso('2026-05-01T00:00:00.000Z');
      expect(dueTrialAllowance(null, now, 50)).toBeNull();
      expect(dueTrialAllowance(record(), now, 50)).toBeNull();
    });

    it('is the trial allowance during the trial, expiring with it', () => {
      const r = trial('2026-05-01T12:00:00.000Z', '2026-05-08T12:00:00.000Z');
      expect(dueTrialAllowance(r, iso('2026-05-03T00:00:00.000Z'), 75)).toEqual(
        {
          source: CreditSource.TRIAL,
          sourceReference: 'trial:2026-05-01T12:00:00.000Z',
          amount: 75,
          expiresAt: iso('2026-05-08T12:00:00.000Z'),
          description: 'Free trial credits',
        },
      );
    });

    it('is nothing once the trial has ended', () => {
      expect(
        dueTrialAllowance(
          trial('2026-05-01T00:00:00.000Z', '2026-05-08T00:00:00.000Z'),
          iso('2026-05-08T00:00:00.000Z'),
          50,
        ),
      ).toBeNull();
    });

    it('is nothing once paid Pro is bought during the trial', () => {
      const r = record({
        trialUsed: true,
        trialStartedAt: iso('2026-05-01T00:00:00.000Z'),
        trialExpiresAt: iso('2026-05-08T00:00:00.000Z'),
        billingInterval: MONTHLY,
        proStartedAt: iso('2026-05-05T00:00:00.000Z'),
        proExpiresAt: iso('2026-06-05T00:00:00.000Z'),
      });
      expect(
        dueTrialAllowance(r, iso('2026-05-06T00:00:00.000Z'), 50),
      ).toBeNull();
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
        billingInterval: MONTHLY,
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
    });
  });
});
