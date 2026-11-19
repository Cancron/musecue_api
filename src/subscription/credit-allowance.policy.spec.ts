import { BillingInterval, CreditSource } from '@prisma/client';
import {
  addMonthsClamped,
  currentProAllowancePeriod,
  dueAllowances,
  isCreditSourceUsable,
} from './credit-allowance.policy';
import type { SubscriptionRecord } from './subscription-access.policy';

const iso = (value: string) => new Date(value);
const AMOUNTS = { trialCredits: 50, proMonthlyCredits: 1000 };

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

  describe('currentProAllowancePeriod', () => {
    it('is the billing month of a monthly term', () => {
      const term = paid('2026-03-15T09:00:00.000Z', '2026-04-15T09:00:00.000Z');
      expect(
        currentProAllowancePeriod(term, iso('2026-03-20T00:00:00.000Z')),
      ).toEqual({
        start: iso('2026-03-15T09:00:00.000Z'),
        end: iso('2026-04-15T09:00:00.000Z'),
      });
    });

    it('splits a yearly term into months from its start', () => {
      const term = paid(
        '2026-01-31T00:00:00.000Z',
        '2027-01-31T00:00:00.000Z',
        BillingInterval.YEARLY,
      );
      expect(
        currentProAllowancePeriod(term, iso('2026-03-05T00:00:00.000Z')),
      ).toEqual({
        start: iso('2026-02-28T00:00:00.000Z'),
        end: iso('2026-03-31T00:00:00.000Z'),
      });
      expect(
        currentProAllowancePeriod(term, iso('2026-12-31T12:00:00.000Z')),
      ).toEqual({
        start: iso('2026-12-31T00:00:00.000Z'),
        end: iso('2027-01-31T00:00:00.000Z'),
      });
    });

    it('switches months at the exact anchor instant', () => {
      const term = paid(
        '2026-01-10T08:00:00.000Z',
        '2027-01-10T08:00:00.000Z',
        BillingInterval.YEARLY,
      );
      expect(
        currentProAllowancePeriod(term, iso('2026-02-10T07:59:59.999Z'))?.start,
      ).toEqual(iso('2026-01-10T08:00:00.000Z'));
      expect(
        currentProAllowancePeriod(term, iso('2026-02-10T08:00:00.000Z'))?.start,
      ).toEqual(iso('2026-02-10T08:00:00.000Z'));
    });

    it('is null without an active paid term', () => {
      const term = paid('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
      expect(
        currentProAllowancePeriod(null, iso('2026-01-10T00:00:00.000Z')),
      ).toBeNull();
      expect(
        currentProAllowancePeriod(term, iso('2026-02-01T00:00:00.000Z')),
      ).toBeNull();
      expect(
        currentProAllowancePeriod(
          trial('2026-01-01T00:00:00.000Z', '2026-01-08T00:00:00.000Z'),
          iso('2026-01-02T00:00:00.000Z'),
        ),
      ).toBeNull();
    });
  });

  describe('dueAllowances', () => {
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

    it('grants nothing once the trial or term has ended', () => {
      expect(
        dueAllowances(
          trial('2026-05-01T00:00:00.000Z', '2026-05-08T00:00:00.000Z'),
          iso('2026-05-08T00:00:00.000Z'),
          AMOUNTS,
        ),
      ).toEqual([]);
      expect(
        dueAllowances(
          paid('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
          iso('2026-03-01T00:00:00.000Z'),
          AMOUNTS,
        ),
      ).toEqual([]);
    });

    it('grants one monthly allowance per month of a term, with a stable reference', () => {
      const term = paid(
        '2026-01-15T00:00:00.000Z',
        '2027-01-15T00:00:00.000Z',
        BillingInterval.YEARLY,
      );
      const early = dueAllowances(
        term,
        iso('2026-03-16T00:00:00.000Z'),
        AMOUNTS,
      );
      const late = dueAllowances(
        term,
        iso('2026-04-14T23:00:00.000Z'),
        AMOUNTS,
      );
      const next = dueAllowances(
        term,
        iso('2026-04-15T00:00:00.000Z'),
        AMOUNTS,
      );

      expect(early).toEqual([
        {
          source: CreditSource.SUBSCRIPTION,
          sourceReference:
            'pro:2026-01-15T00:00:00.000Z:2026-03-15T00:00:00.000Z',
          amount: 1000,
          expiresAt: iso('2026-04-15T00:00:00.000Z'),
          description: 'Monthly Pro credits',
        },
      ]);
      expect(late).toEqual(early);
      expect(next[0]?.sourceReference).toBe(
        'pro:2026-01-15T00:00:00.000Z:2026-04-15T00:00:00.000Z',
      );
    });

    it('never lets monthly credits outlive the paid term', () => {
      // A term shortened (e.g. by a refund) mid-month.
      const term = paid('2026-01-15T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
      expect(
        dueAllowances(term, iso('2026-01-20T00:00:00.000Z'), AMOUNTS)[0]
          ?.expiresAt,
      ).toEqual(iso('2026-02-01T00:00:00.000Z'));
    });

    it('grants only the Pro allowance once paid Pro is bought during the trial', () => {
      const r = record({
        trialUsed: true,
        trialStartedAt: iso('2026-05-01T00:00:00.000Z'),
        trialExpiresAt: iso('2026-05-08T00:00:00.000Z'),
        billingInterval: BillingInterval.MONTHLY,
        proStartedAt: iso('2026-05-05T00:00:00.000Z'),
        proExpiresAt: iso('2026-06-05T00:00:00.000Z'),
      });
      expect(
        dueAllowances(r, iso('2026-05-06T00:00:00.000Z'), AMOUNTS).map(
          (a) => a.source,
        ),
      ).toEqual([CreditSource.SUBSCRIPTION]);
    });

    it('uses the configured amounts', () => {
      const r = trial('2026-05-01T00:00:00.000Z', '2026-05-08T00:00:00.000Z');
      expect(
        dueAllowances(r, iso('2026-05-02T00:00:00.000Z'), {
          trialCredits: 75,
          proMonthlyCredits: 1,
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
