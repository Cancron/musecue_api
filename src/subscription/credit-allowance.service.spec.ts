import { BillingInterval, CreditSource } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../common/services/prisma.service';
import { CreditSettingsService } from '../credits/credit-settings.service';
import { CreditWalletService } from '../credits/credit-wallet.service';
import type { GrantCreditsResult } from '../credits/interfaces/credit-wallet.interface';
import {
  CreditAllowanceService,
  TRIAL_CREDITS_ENDED_BY_UPGRADE,
} from './credit-allowance.service';

describe('CreditAllowanceService', () => {
  const tx = mockDeep<PrismaService>();
  const wallet = mock<CreditWalletService>();
  const settings = mock<CreditSettingsService>();
  const prisma = mockDeep<PrismaService>();
  const service = new CreditAllowanceService(prisma, wallet, settings);
  const startedAt = new Date('2026-07-01T10:00:00.000Z');
  const expiresAt = new Date('2026-07-08T10:00:00.000Z');

  beforeEach(() => {
    jest.resetAllMocks();
    settings.getSettings.mockResolvedValue({
      trialCredits: 50,
      proMonthlyCredits: 1000,
      creditCostUsdMicros: 5000,
      creditCostUsd: '0.005',
      sessionOverageCredits: 5,
      updatedAt: startedAt.toISOString(),
    });
    wallet.grant.mockResolvedValue({ replayed: false } as GrantCreditsResult);
  });

  describe('grantTrialCredits', () => {
    it("grants the administrator's trial allowance, expiring with the trial, in the caller's transaction", async () => {
      await service.grantTrialCredits(tx, 'user-1', { startedAt, expiresAt });

      expect(settings.getSettings.mock.calls).toEqual([[tx]]);
      expect(wallet.grant.mock.calls).toEqual([
        [
          {
            authId: 'user-1',
            source: CreditSource.TRIAL,
            sourceReference: 'trial:2026-07-01T10:00:00.000Z',
            amount: 50,
            expiresAt,
            description: 'Free trial credits',
          },
          { tx, at: startedAt },
        ],
      ]);
    });

    it('uses the configured amount', async () => {
      settings.getSettings.mockResolvedValue({
        trialCredits: 120,
      } as never);

      await service.grantTrialCredits(tx, 'user-1', { startedAt, expiresAt });

      expect(wallet.grant.mock.calls[0]?.[0]).toMatchObject({ amount: 120 });
    });

    it('never retries a repeated grant with other values: a second trial conflicts', async () => {
      wallet.grant.mockRejectedValue(
        new Error('Trial credits were already granted'),
      );
      await expect(
        service.grantTrialCredits(tx, 'user-1', { startedAt, expiresAt }),
      ).rejects.toThrow('already granted');
      expect(wallet.grant.mock.calls[0]?.[0]).not.toHaveProperty(
        'keepExistingGrant',
      );
    });
  });

  describe('grantPaidPeriod', () => {
    const payment = {
      id: 'pay-1',
      periodStart: new Date('2026-07-10T00:00:00.000Z'),
      periodEnd: new Date('2026-08-10T00:00:00.000Z'),
      billingInterval: BillingInterval.MONTHLY,
    };
    const grant = (at = new Date('2026-07-10T00:05:00.000Z')) =>
      service.grantPaidPeriod(tx, {
        authId: 'user-1',
        subscriptionId: 'sub-1',
        payment,
        at,
      });

    it("grants the administrator's monthly Pro credits for the paid period, linked to the payment", async () => {
      tx.creditAllocation.findFirst.mockResolvedValue(null);
      settings.getSettings.mockResolvedValue({
        proMonthlyCredits: 1200,
      } as never);
      const at = new Date('2026-07-10T00:05:00.000Z');

      await expect(grant(at)).resolves.toBe('GRANTED');

      expect(settings.getSettings.mock.calls).toEqual([[tx]]);
      expect(wallet.grant.mock.calls).toEqual([
        [
          {
            authId: 'user-1',
            source: CreditSource.SUBSCRIPTION,
            sourceReference: 'payment:pay-1:2026-07-10T00:00:00.000Z',
            amount: 1200,
            expiresAt: payment.periodEnd,
            description: 'Monthly Pro credits',
            paidPeriod: {
              subscriptionId: 'sub-1',
              paymentId: 'pay-1',
              periodStart: payment.periodStart,
              periodEnd: payment.periodEnd,
            },
          },
          { tx, at },
        ],
      ]);
    });

    it('grants nothing for a period that already has its credits', async () => {
      tx.creditAllocation.findFirst.mockResolvedValue({ id: 'a' } as never);

      await expect(grant()).resolves.toBe('ALREADY_GRANTED');

      expect(tx.creditAllocation.findFirst.mock.calls[0]?.[0]).toEqual({
        where: {
          authId: 'user-1',
          source: CreditSource.SUBSCRIPTION,
          OR: [
            { periodStart: payment.periodStart },
            {
              paymentId: null,
              expiresAt: { gt: payment.periodStart },
              grantedAt: { lt: payment.periodEnd },
            },
          ],
        },
        select: { id: true },
      });
      expect(wallet.grant.mock.calls).toHaveLength(0);
    });

    it('grants nothing once the paid period is over', async () => {
      await expect(grant(payment.periodEnd)).resolves.toBe('PERIOD_OVER');
      expect(tx.creditAllocation.findFirst.mock.calls).toHaveLength(0);
      expect(wallet.grant.mock.calls).toHaveLength(0);
    });
  });

  describe('grantCurrentPaidPeriod', () => {
    const at = new Date('2026-09-15T00:00:00.000Z');
    beforeEach(() => {
      prisma.$transaction.mockImplementation(((
        callback: (client: PrismaService) => Promise<unknown>,
      ) => callback(prisma)) as never);
    });

    it('grants nothing without a subscription, without a lookup of payments', async () => {
      prisma.userSubscription.findUnique.mockResolvedValue(null);
      await expect(service.grantCurrentPaidPeriod('user-1', at)).resolves.toBe(
        'NOT_PAID',
      );
      expect(prisma.paymentTransaction.findFirst.mock.calls).toHaveLength(0);
    });

    it('only counts successful payments that created or renewed the paid term', async () => {
      prisma.userSubscription.findUnique.mockResolvedValue({
        id: 'sub-1',
      } as never);
      prisma.userSubscription.findUniqueOrThrow.mockResolvedValue({
        id: 'sub-1',
        proStartedAt: new Date('2026-01-15T00:00:00.000Z'),
        proExpiresAt: new Date('2027-01-15T00:00:00.000Z'),
      } as never);
      prisma.paymentTransaction.findFirst.mockResolvedValue(null);

      await expect(service.grantCurrentPaidPeriod('user-1', at)).resolves.toBe(
        'NOT_PAID',
      );
      expect(prisma.$queryRaw.mock.calls).toHaveLength(1);
      expect(prisma.paymentTransaction.findFirst.mock.calls[0]?.[0]).toEqual({
        where: {
          subscriptionId: 'sub-1',
          status: { in: ['SUCCEEDED', 'PARTIALLY_REFUNDED'] },
          periodStart: { lte: at },
          periodEnd: { gt: at },
          event: { type: { in: ['CREATED', 'RENEWED'] } },
        },
        orderBy: { periodStart: 'desc' },
      });
    });

    it('grants nothing outside an active paid term', async () => {
      prisma.userSubscription.findUnique.mockResolvedValue({
        id: 'sub-1',
      } as never);
      prisma.userSubscription.findUniqueOrThrow.mockResolvedValue({
        id: 'sub-1',
        proStartedAt: new Date('2026-01-15T00:00:00.000Z'),
        proExpiresAt: new Date('2026-02-15T00:00:00.000Z'),
      } as never);

      await expect(service.grantCurrentPaidPeriod('user-1', at)).resolves.toBe(
        'NOT_PAID',
      );
      expect(prisma.paymentTransaction.findFirst.mock.calls).toHaveLength(0);
    });
  });

  describe('expireTrialCreditsOnUpgrade', () => {
    it("ends only TRIAL credits, now, in the caller's transaction", async () => {
      wallet.expireSourceNow.mockResolvedValue(1);

      const upgradedAt = new Date('2026-07-03T12:00:00.000Z');
      await expect(
        service.expireTrialCreditsOnUpgrade(tx, 'user-1', upgradedAt),
      ).resolves.toBe(1);

      expect(wallet.expireSourceNow.mock.calls).toEqual([
        [
          'user-1',
          CreditSource.TRIAL,
          TRIAL_CREDITS_ENDED_BY_UPGRADE,
          { tx, at: upgradedAt },
        ],
      ]);
    });
  });
});
