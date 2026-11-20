import {
  BillingInterval,
  CreditSource,
  type UserSubscription,
} from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { freezeTime } from '../../test/support/freeze-time';
import { PrismaService } from '../common/services/prisma.service';
import { CreditSettingsService } from '../credits/credit-settings.service';
import { InvalidCreditOperationError } from '../credits/credit-wallet.errors';
import { CreditWalletService } from '../credits/credit-wallet.service';
import type {
  CreditAllocationView,
  CreditBalanceView,
  GrantCreditsResult,
} from '../credits/interfaces/credit-wallet.interface';
import { CreditAllowanceService } from './credit-allowance.service';
import { CreditEligibilityService } from './credit-eligibility.service';
import { SubscriptionAccessService } from './subscription-access.service';
import { SubscriptionPlanService } from './subscription-plan.service';

const NOW = new Date('2026-06-10T12:00:00.000Z');
const iso = (value: string) => new Date(value);

type Row = Pick<
  UserSubscription,
  | 'trialUsed'
  | 'trialStartedAt'
  | 'trialExpiresAt'
  | 'billingInterval'
  | 'proStartedAt'
  | 'proExpiresAt'
  | 'proCanceledAt'
>;
const row = (overrides: Partial<Row> = {}): Row => ({
  trialUsed: false,
  trialStartedAt: null,
  trialExpiresAt: null,
  billingInterval: null,
  proStartedAt: null,
  proExpiresAt: null,
  proCanceledAt: null,
  ...overrides,
});

const allocation = (
  source: CreditSource,
  remaining: string,
  expiresAt: string | null = null,
): CreditAllocationView => ({
  id: `${source}-${remaining}`,
  source,
  sourceReference: 'ref',
  amount: remaining,
  remaining,
  grantedAt: '2026-06-01T00:00:00.000Z',
  expiresAt,
  periodStart: null,
  subscriptionId: null,
  paymentId: null,
});

/**
 * Real SubscriptionAccessService and policies; the database, wallet and
 * settings are mocked.
 */
describe('CreditEligibilityService', () => {
  const prisma = mockDeep<PrismaService>();
  const wallet = mock<CreditWalletService>();
  const settings = mock<CreditSettingsService>();
  const allowances = mock<CreditAllowanceService>();
  const service = new CreditEligibilityService(
    new SubscriptionAccessService(prisma, mock<SubscriptionPlanService>()),
    wallet,
    settings,
    allowances,
  );
  let stored: Row | null;
  let allocations: CreditAllocationView[];

  beforeEach(() => {
    jest.resetAllMocks();
    allowances.catchUpPaidMonths.mockResolvedValue(0);
    freezeTime(NOW);
    stored = null;
    allocations = [];
    prisma.userSubscription.findUnique.mockImplementation((() =>
      Promise.resolve(stored)) as never);
    wallet.getBalance.mockImplementation(() =>
      Promise.resolve({ allocations } as CreditBalanceView),
    );
    wallet.hasGrant.mockResolvedValue(false);
    wallet.grant.mockResolvedValue({ replayed: false } as GrantCreditsResult);
    settings.getSettings.mockResolvedValue({
      trialCredits: 50,
      proMonthlyCredits: 1000,
      creditCostUsdMicros: 5000,
      creditCostUsd: '0.005',
      sessionOverageCredits: 5,
      updatedAt: NOW.toISOString(),
    });
  });

  afterEach(() => jest.useRealTimers());

  describe('free users', () => {
    it.each([
      ['no subscription record', null],
      ['an unused record', row()],
    ])(
      'with %s have zero credits and are granted nothing',
      async (_case, record) => {
        stored = record;

        const result = await service.getEligibility('user-1');

        expect(result).toMatchObject({ eligible: false, usableCredits: '0' });
        expect(wallet.grant.mock.calls).toHaveLength(0);
        expect(wallet.hasGrant.mock.calls).toHaveLength(0);
        expect(settings.getSettings.mock.calls).toHaveLength(0);
      },
    );
  });

  describe('allowances', () => {
    it('grants the trial allowance once, from the settings, expiring with the trial', async () => {
      stored = row({
        trialUsed: true,
        trialStartedAt: iso('2026-06-08T00:00:00.000Z'),
        trialExpiresAt: iso('2026-06-15T00:00:00.000Z'),
      });

      await service.getEligibility('user-1');

      expect(wallet.hasGrant.mock.calls).toEqual([
        ['user-1', 'TRIAL', 'trial:2026-06-08T00:00:00.000Z'],
      ]);
      expect(wallet.grant.mock.calls).toEqual([
        [
          {
            authId: 'user-1',
            source: 'TRIAL',
            sourceReference: 'trial:2026-06-08T00:00:00.000Z',
            amount: 50,
            expiresAt: iso('2026-06-15T00:00:00.000Z'),
            description: 'Free trial credits',
            keepExistingGrant: true,
          },
        ],
      ]);
    });

    it('never grants Pro credits itself: it only catches up on recorded payments', async () => {
      stored = row({
        billingInterval: BillingInterval.YEARLY,
        proStartedAt: iso('2026-01-20T00:00:00.000Z'),
        proExpiresAt: iso('2027-01-20T00:00:00.000Z'),
      });

      await service.getEligibility('user-1');

      expect(wallet.grant.mock.calls).toHaveLength(0);
      expect(allowances.catchUpPaidMonths.mock.calls).toEqual([
        ['user-1', stored, NOW],
      ]);
    });

    it('does not open a wallet transaction when the trial allowance was already granted', async () => {
      stored = row({
        trialUsed: true,
        trialStartedAt: iso('2026-06-08T00:00:00.000Z'),
        trialExpiresAt: iso('2026-06-15T00:00:00.000Z'),
      });
      wallet.hasGrant.mockResolvedValue(true);

      await service.getEligibility('user-1');

      expect(wallet.grant.mock.calls).toHaveLength(0);
      expect(settings.getSettings.mock.calls).toHaveLength(0);
    });

    it('skips an allowance whose trial ended in the moment before the grant', async () => {
      stored = row({
        trialUsed: true,
        trialStartedAt: iso('2026-06-03T12:00:00.000Z'),
        trialExpiresAt: new Date(NOW.getTime() + 1),
      });
      wallet.grant.mockImplementation(() => {
        freezeTime(new Date(NOW.getTime() + 1));
        return Promise.reject(
          new InvalidCreditOperationError(
            'The expiration date must be in the future',
          ),
        );
      });

      await expect(service.grantDueAllowances('user-1')).resolves.toBe(0);
    });

    it('propagates other grant failures', async () => {
      stored = row({
        trialUsed: true,
        trialStartedAt: iso('2026-06-08T00:00:00.000Z'),
        trialExpiresAt: iso('2026-06-15T00:00:00.000Z'),
      });
      wallet.grant.mockRejectedValue(new Error('db down'));

      await expect(service.getEligibility('user-1')).rejects.toThrow('db down');
    });
  });

  describe('usable credits', () => {
    it('counts purchased and referral credits after the Pro subscription has expired', async () => {
      stored = row({
        billingInterval: BillingInterval.MONTHLY,
        proStartedAt: iso('2026-04-01T00:00:00.000Z'),
        proExpiresAt: iso('2026-05-01T00:00:00.000Z'),
      });
      allocations = [
        allocation(CreditSource.PURCHASE, '10.25'),
        allocation(CreditSource.REFERRAL, '5'),
      ];

      await expect(service.getEligibility('user-1')).resolves.toMatchObject({
        eligible: true,
        usableCredits: '15.25',
        usableBySource: { PURCHASE: '10.25', REFERRAL: '5' },
        proAccess: { hasProAccess: false, status: 'EXPIRED' },
      });
      expect(wallet.grant.mock.calls).toHaveLength(0);
    });

    it('does not count subscription credits once the paid term has ended early (refund)', async () => {
      // The allocation has not expired yet, but the term was cut short.
      stored = row({
        billingInterval: BillingInterval.MONTHLY,
        proStartedAt: iso('2026-06-01T00:00:00.000Z'),
        proExpiresAt: iso('2026-06-05T00:00:00.000Z'),
      });
      allocations = [
        allocation(
          CreditSource.SUBSCRIPTION,
          '900',
          '2026-07-01T00:00:00.000Z',
        ),
      ];

      await expect(service.getEligibility('user-1')).resolves.toMatchObject({
        eligible: false,
        usableCredits: '0',
      });
    });

    it('does not count trial credits outside the trial', async () => {
      stored = row({
        trialUsed: true,
        trialStartedAt: iso('2026-05-01T00:00:00.000Z'),
        trialExpiresAt: iso('2026-05-08T00:00:00.000Z'),
      });
      allocations = [
        allocation(CreditSource.TRIAL, '50', '2026-06-30T00:00:00.000Z'),
      ];

      await expect(service.getEligibility('user-1')).resolves.toMatchObject({
        eligible: false,
      });
    });

    it('counts trial credits during the trial, exactly', async () => {
      stored = row({
        trialUsed: true,
        trialStartedAt: iso('2026-06-08T00:00:00.000Z'),
        trialExpiresAt: iso('2026-06-15T00:00:00.000Z'),
      });
      allocations = [
        allocation(CreditSource.TRIAL, '0.1', '2026-06-15T00:00:00.000Z'),
        allocation(CreditSource.PURCHASE, '0.2'),
      ];

      await expect(service.getEligibility('user-1')).resolves.toMatchObject({
        eligible: true,
        usableCredits: '0.3',
        proAccess: { accessSource: 'TRIAL' },
      });
    });

    it('stops counting trial credits once paid Pro is bought during the trial', async () => {
      stored = row({
        trialUsed: true,
        trialStartedAt: iso('2026-06-08T00:00:00.000Z'),
        trialExpiresAt: iso('2026-06-15T00:00:00.000Z'),
        billingInterval: BillingInterval.MONTHLY,
        proStartedAt: iso('2026-06-09T00:00:00.000Z'),
        proExpiresAt: iso('2026-07-09T00:00:00.000Z'),
      });
      wallet.hasGrant.mockResolvedValue(true);
      allocations = [
        allocation(CreditSource.TRIAL, '0.1', '2026-06-15T00:00:00.000Z'),
        allocation(
          CreditSource.SUBSCRIPTION,
          '0.2',
          '2026-07-09T00:00:00.000Z',
        ),
      ];

      await expect(service.getEligibility('user-1')).resolves.toMatchObject({
        eligible: true,
        usableCredits: '0.2',
        usableBySource: { TRIAL: '0', SUBSCRIPTION: '0.2' },
        proAccess: { accessSource: 'PRO' },
      });
      // No trial allowance is granted after the upgrade.
      expect(
        wallet.grant.mock.calls.filter(([input]) => input.source === 'TRIAL'),
      ).toEqual([]);
    });
  });
});
