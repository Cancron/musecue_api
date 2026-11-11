import { BillingInterval, SubscriptionStatus } from '@prisma/client';
import {
  canStartTrial,
  getTrialIneligibility,
  isTrialAccountEligible,
  resolveSubscriptionAccess,
  type SubscriptionRecord,
} from './subscription-access.policy';

const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));
const NOW = day(10);

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

const trial = (start: number, end: number) => ({
  trialUsed: true,
  trialStartedAt: day(start),
  trialExpiresAt: day(end),
});
const pro = (
  start: number,
  end: number,
  billingInterval: BillingInterval = BillingInterval.MONTHLY,
) => ({ billingInterval, proStartedAt: day(start), proExpiresAt: day(end) });

const noAccess = (status: SubscriptionStatus) => ({
  status,
  hasProAccess: false,
  accessSource: null,
  accessExpiresAt: null,
});

describe('resolveSubscriptionAccess', () => {
  describe('FREE', () => {
    it('treats a user without a record as FREE', () => {
      expect(resolveSubscriptionAccess(null, NOW)).toEqual(
        noAccess(SubscriptionStatus.FREE),
      );
    });

    it('treats an empty record as FREE', () => {
      expect(resolveSubscriptionAccess(record(), NOW)).toEqual(
        noAccess(SubscriptionStatus.FREE),
      );
    });
  });

  describe('TRIAL', () => {
    it('grants access during the trial window', () => {
      expect(resolveSubscriptionAccess(record(trial(8, 15)), NOW)).toEqual({
        status: SubscriptionStatus.TRIAL,
        hasProAccess: true,
        accessSource: 'TRIAL',
        accessExpiresAt: day(15),
      });
    });

    it('grants access from the exact start instant', () => {
      expect(
        resolveSubscriptionAccess(record(trial(10, 17)), NOW).hasProAccess,
      ).toBe(true);
    });

    it('ends access at the exact expiry instant', () => {
      expect(resolveSubscriptionAccess(record(trial(3, 10)), NOW)).toEqual(
        noAccess(SubscriptionStatus.EXPIRED),
      );
    });

    it('grants nothing before a future-dated trial starts', () => {
      expect(
        resolveSubscriptionAccess(record(trial(11, 18)), NOW).hasProAccess,
      ).toBe(false);
    });
  });

  describe('PRO', () => {
    it.each([BillingInterval.MONTHLY, BillingInterval.YEARLY])(
      'grants access during a %s term',
      (interval) => {
        expect(
          resolveSubscriptionAccess(record(pro(5, 35, interval)), NOW),
        ).toEqual({
          status: SubscriptionStatus.PRO,
          hasProAccess: true,
          accessSource: 'PRO',
          accessExpiresAt: day(35),
        });
      },
    );

    it('keeps access after cancellation until the term expires', () => {
      const canceled = record({ ...pro(5, 35), proCanceledAt: day(9) });
      expect(resolveSubscriptionAccess(canceled, NOW).hasProAccess).toBe(true);
      expect(resolveSubscriptionAccess(canceled, day(35))).toEqual(
        noAccess(SubscriptionStatus.EXPIRED),
      );
    });

    it('ends access when the term expires', () => {
      expect(resolveSubscriptionAccess(record(pro(-30, 10)), NOW)).toEqual(
        noAccess(SubscriptionStatus.EXPIRED),
      );
    });

    it('restores access when an expired user buys a new term', () => {
      const renewed = record({ ...trial(-20, -13), ...pro(9, 39) });
      expect(resolveSubscriptionAccess(renewed, NOW)).toMatchObject({
        status: SubscriptionStatus.PRO,
        hasProAccess: true,
      });
    });
  });

  describe('TRIAL and PRO on the same record', () => {
    it('reports PRO when both are active and access lasts until the later expiry', () => {
      const both = record({ ...trial(8, 40), ...pro(9, 39) });
      expect(resolveSubscriptionAccess(both, NOW)).toEqual({
        status: SubscriptionStatus.PRO,
        hasProAccess: true,
        accessSource: 'PRO',
        accessExpiresAt: day(40),
      });
    });

    it('falls back to the trial when the paid term has lapsed', () => {
      const both = record({ ...trial(8, 15), ...pro(-30, 9) });
      expect(resolveSubscriptionAccess(both, NOW)).toMatchObject({
        status: SubscriptionStatus.TRIAL,
        accessSource: 'TRIAL',
      });
    });

    it('is EXPIRED with no access once both have expired', () => {
      const both = record({ ...trial(-40, -33), ...pro(-33, 10) });
      expect(resolveSubscriptionAccess(both, NOW)).toEqual(
        noAccess(SubscriptionStatus.EXPIRED),
      );
    });
  });

  it('marks a used trial without dates as EXPIRED', () => {
    expect(resolveSubscriptionAccess(record({ trialUsed: true }), NOW)).toEqual(
      noAccess(SubscriptionStatus.EXPIRED),
    );
  });
});

describe('isTrialAccountEligible', () => {
  const active = { status: 'ACTIVE', verified: true, deletedAt: null };

  it('accepts an active, verified, not deleted account', () => {
    expect(isTrialAccountEligible(active)).toBe(true);
  });

  it.each([
    ['a missing account', null],
    ['INACTIVE', { ...active, status: 'INACTIVE' }],
    ['SUSPENDED', { ...active, status: 'SUSPENDED' }],
    ['BLOCKED', { ...active, status: 'BLOCKED' }],
    ['DELETED', { ...active, status: 'DELETED' }],
    ['unverified', { ...active, verified: false }],
    ['soft-deleted', { ...active, deletedAt: new Date('2026-01-01') }],
  ])('rejects %s', (_case, account) => {
    expect(isTrialAccountEligible(account)).toBe(false);
  });
});

describe('trial eligibility', () => {
  const enabled = { planEnabled: true, trialEnabled: true };

  it('allows a user who has never had a trial or a paid term', () => {
    expect(getTrialIneligibility(null, enabled)).toBeNull();
    expect(getTrialIneligibility(record(), enabled)).toBeNull();
    expect(canStartTrial(record(), enabled)).toBe(true);
  });

  it.each([
    ['during the trial', record(trial(8, 15))],
    ['after the trial expired', record(trial(-10, -3))],
    [
      'when the trial is marked used without dates',
      record({ trialUsed: true }),
    ],
    [
      'after both the trial and a paid term',
      record({ ...trial(-40, -33), ...pro(-33, 5) }),
    ],
  ])('refuses a second trial %s', (_case, existing) => {
    expect(getTrialIneligibility(existing, enabled)).toBe('TRIAL_ALREADY_USED');
    expect(canStartTrial(existing, enabled)).toBe(false);
  });

  it.each([
    ['an active paid term', record(pro(5, 35))],
    ['a canceled paid term', record({ ...pro(5, 35), proCanceledAt: day(6) })],
    ['an expired paid term', record(pro(-30, 5))],
    ['an expired yearly term', record(pro(-400, -35, BillingInterval.YEARLY))],
  ])('refuses a never-trialed user with %s', (_case, existing) => {
    expect(getTrialIneligibility(existing, enabled)).toBe('HAS_PRO_HISTORY');
    expect(canStartTrial(existing, enabled)).toBe(false);
  });

  it.each([
    [{ planEnabled: false, trialEnabled: true }, 'PLAN_DISABLED'],
    [{ planEnabled: false, trialEnabled: false }, 'PLAN_DISABLED'],
    [{ planEnabled: true, trialEnabled: false }, 'TRIAL_DISABLED'],
  ])('refuses a trial when the plan settings are %p', (plan, reason) => {
    expect(getTrialIneligibility(null, plan)).toBe(reason);
    expect(canStartTrial(null, plan)).toBe(false);
  });
});
