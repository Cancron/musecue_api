import { Prisma, type AiUsage } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../common/services/prisma.service';
import { CreditUsageService } from '../credits/credit-usage.service';
import { CreditWalletService } from '../credits/credit-wallet.service';
import {
  CreditEligibilityService,
  type CreditEligibility,
} from '../subscription/credit-eligibility.service';
import { MakeupCreditService } from './makeup-credit.service';

describe('MakeupCreditService', () => {
  const prisma = mockDeep<PrismaService>();
  const usage = mock<CreditUsageService>();
  const wallet = mock<CreditWalletService>();
  const eligibility = mock<CreditEligibilityService>();
  const service = new MakeupCreditService(prisma, usage, wallet, eligibility);
  const job = { runId: 'run-1', authId: 'user-1', sessionId: 'session-1' };

  beforeEach(() => jest.resetAllMocks());

  describe('assertCanUseAi', () => {
    it('lets a user with usable credits use AI', async () => {
      eligibility.getEligibility.mockResolvedValue({
        eligible: true,
      } as CreditEligibility);
      await expect(
        service.assertCanUseAi('user-1', 'session-1'),
      ).resolves.toBeUndefined();
      expect(wallet.sessionOverageRemaining.mock.calls).toHaveLength(0);
    });

    it("lets a user without credits use the rest of the session's overage allowance", async () => {
      eligibility.getEligibility.mockResolvedValue({
        eligible: false,
      } as CreditEligibility);
      wallet.sessionOverageRemaining.mockResolvedValue(
        new Prisma.Decimal('0.5'),
      );
      await expect(
        service.assertCanUseAi('user-1', 'session-1'),
      ).resolves.toBeUndefined();
      expect(wallet.sessionOverageRemaining.mock.calls).toEqual([
        ['user-1', 'session-1'],
      ]);
    });

    it('refuses a user with neither, with a non-retryable "Insufficient credits"', async () => {
      eligibility.getEligibility.mockResolvedValue({
        eligible: false,
      } as CreditEligibility);
      wallet.sessionOverageRemaining.mockResolvedValue(new Prisma.Decimal(0));
      await expect(
        service.assertCanUseAi('user-1', 'session-1'),
      ).rejects.toMatchObject({
        code: 'INSUFFICIENT_CREDITS',
        message: 'Insufficient credits',
        retryable: false,
      });
    });
  });

  it('records nothing for a provider that reports no usage (the mock gateway)', async () => {
    await expect(
      service.recordUsage(job, 'GUIDE_QUESTION', 'mock', { model: 'm' }),
    ).resolves.toBeNull();
    expect(usage.record.mock.calls).toHaveLength(0);
  });

  it('records input, output and total tokens and the cost against the user, session and run', async () => {
    usage.record.mockResolvedValue({ id: 'usage-1' } as AiUsage);
    await service.recordUsage(job, 'GUIDE_QUESTION', 'openrouter', {
      responseId: 'gen-1',
      model: 'm',
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        costUsd: '0.0004',
      },
    });
    expect(usage.record.mock.calls[0]?.[0]).toMatchObject({
      authId: 'user-1',
      sessionId: 'session-1',
      runId: 'run-1',
      operation: 'GUIDE_QUESTION',
      provider: 'openrouter',
      model: 'm',
      providerRequestId: 'gen-1',
      outcome: 'SUCCEEDED',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costUsd: '0.0004',
    });
  });

  it('charges the run spending only the credits the user may use now', async () => {
    const tx = mockDeep<PrismaService>();
    eligibility.usableSources.mockResolvedValue(['PURCHASE', 'REFERRAL']);
    await service.chargeRun(tx, { id: 'usage-1', authId: 'user-1' } as AiUsage);
    expect(usage.chargeRun.mock.calls).toEqual([
      [tx, 'usage-1', { sources: ['PURCHASE', 'REFERRAL'] }],
    ]);
  });

  it("reports usage only for the caller's own session", async () => {
    prisma.makeupSession.findFirst.mockResolvedValue(null);
    await expect(
      service.getSessionUsage('user-1', 'someone-elses'),
    ).rejects.toMatchObject({ status: 404 });
    expect(usage.getSessionUsage.mock.calls).toHaveLength(0);
  });
});
