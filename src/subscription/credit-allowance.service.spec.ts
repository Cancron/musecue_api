import { CreditSource } from '@prisma/client';
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
  const service = new CreditAllowanceService(wallet, settings);
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
