import type { AiUsage } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../common/services/prisma.service';
import { CreditUsageService } from '../credits/credit-usage.service';
import { InsufficientCreditsError } from '../credits/credit-wallet.errors';
import { CreditWalletService } from '../credits/credit-wallet.service';
import type { SessionUseView } from '../credits/interfaces/credit-wallet.interface';
import { CreditEligibilityService } from '../subscription/credit-eligibility.service';
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
    it('checks the session with the credit sources the user may use now', async () => {
      eligibility.usableSources.mockResolvedValue(['PURCHASE']);
      wallet.prepareSessionUse.mockResolvedValue({} as SessionUseView);
      await expect(
        service.assertCanUseAi('user-1', 'session-1'),
      ).resolves.toBeUndefined();
      expect(wallet.prepareSessionUse.mock.calls).toEqual([
        [{ authId: 'user-1', sessionId: 'session-1', sources: ['PURCHASE'] }],
      ]);
    });

    it('turns "Insufficient credits" into a non-retryable AI failure', async () => {
      eligibility.usableSources.mockResolvedValue([]);
      wallet.prepareSessionUse.mockRejectedValue(
        new InsufficientCreditsError({ available: '0' }),
      );
      await expect(
        service.assertCanUseAi('user-1', 'session-1'),
      ).rejects.toMatchObject({
        code: 'INSUFFICIENT_CREDITS',
        message: 'Insufficient credits',
        retryable: false,
      });
    });

    it('lets other failures through unchanged', async () => {
      eligibility.usableSources.mockResolvedValue([]);
      const failure = new Error('database unavailable');
      wallet.prepareSessionUse.mockRejectedValue(failure);
      await expect(service.assertCanUseAi('user-1', 'session-1')).rejects.toBe(
        failure,
      );
    });
  });

  it("initializes a session and checks AI requests in the caller's transaction", async () => {
    const tx = mockDeep<PrismaService>();
    await service.initializeSession(tx, 'user-1', 'session-1', ['TRIAL']);
    await service.prepareAiRequest(tx, 'user-1', 'session-1', ['TRIAL']);
    const input = {
      authId: 'user-1',
      sessionId: 'session-1',
      sources: ['TRIAL'],
    };
    expect(wallet.initializeSession.mock.calls).toEqual([[input, { tx }]]);
    expect(wallet.prepareSessionUse.mock.calls).toEqual([[input, { tx }]]);
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

  it('charges the run spending only the given sources, then settles its other attempts', async () => {
    const tx = mockDeep<PrismaService>();
    await service.chargeRun(
      tx,
      { id: 'usage-1', authId: 'user-1', runId: 'run-1' } as AiUsage,
      ['PURCHASE', 'REFERRAL'],
    );
    expect(usage.chargeRun.mock.calls).toEqual([
      [tx, 'usage-1', { sources: ['PURCHASE', 'REFERRAL'] }],
    ]);
    expect(usage.settleRunAttempts.mock.calls).toEqual([
      [tx, 'run-1', 'SUPERSEDED_ATTEMPT', 'usage-1'],
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
