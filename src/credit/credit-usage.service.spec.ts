import { Prisma, type AiUsage } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../common/services/prisma.service';
import type { CreditSettingsService } from './credit-settings.service';
import { CreditUsageService } from './credit-usage.service';
import type { CreditWalletService } from './credit-wallet.service';
import { InsufficientCreditsError } from './credit.errors';
import type { DeductionResult } from './interfaces/credit-wallet.interface';

const d = (value: string | number) => new Prisma.Decimal(value);
const NOW = new Date('2026-11-29T12:00:00.000Z');
const context = {
  authId: 'user-1',
  sessionId: 'session-1',
  aiRunId: 'run-1',
  operation: 'PERSONALIZATION' as const,
  attempt: 1,
};

describe('CreditUsageService', () => {
  const prisma = mockDeep<PrismaService>();
  const settings = mock<CreditSettingsService>();
  const wallets = mock<CreditWalletService>();
  const service = new CreditUsageService(prisma, settings, wallets);

  const usageRow = (overrides: Partial<AiUsage> = {}): AiUsage => ({
    id: 'usage-1',
    ...context,
    provider: 'openrouter',
    model: 'openai/gpt-4.1-mini',
    providerRequestId: 'gen-1',
    succeeded: true,
    inputTokens: 1200,
    outputTokens: 300,
    totalTokens: 1500,
    costUsd: d('0.025'),
    chargeStatus: 'PENDING',
    creditTransactionId: null,
    chargedCredits: null,
    usdMicrosPerCredit: null,
    chargedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
  const givenRate = (openRouterUsdMicrosPerCredit: number) =>
    settings.getSettings.mockResolvedValue({
      trialAllowanceCredits: 50,
      proMonthlyAllowanceCredits: 1000,
      openRouterUsdMicrosPerCredit,
      openRouterUsdPerCredit: String(openRouterUsdMicrosPerCredit / 1e6),
      sessionOverageAllowanceCredits: 5,
      updatedAt: NOW.toISOString(),
    });
  const deduction = (duplicate = false): DeductionResult =>
    ({ duplicate, transaction: { id: 'tx-1' } }) as DeductionResult;

  beforeEach(() => {
    jest.resetAllMocks();
    givenRate(5000);
    wallets.deductInTransaction.mockResolvedValue(deduction());
  });

  describe('recordUsage', () => {
    it('records tokens and the exact USD cost for the right user, session and run', async () => {
      prisma.aiUsage.findUnique.mockResolvedValue(null);
      prisma.aiUsage.create.mockResolvedValue(usageRow());

      await service.recordUsage(context, {
        provider: 'openrouter',
        model: 'openai/gpt-4.1-mini',
        providerRequestId: 'gen-1',
        succeeded: true,
        inputTokens: 1200,
        outputTokens: 300,
        totalTokens: 1500,
        costUsd: 0.0123456789,
      });

      expect(prisma.aiUsage.create.mock.calls[0]?.[0].data).toEqual({
        authId: 'user-1',
        sessionId: 'session-1',
        aiRunId: 'run-1',
        operation: 'PERSONALIZATION',
        attempt: 1,
        provider: 'openrouter',
        model: 'openai/gpt-4.1-mini',
        providerRequestId: 'gen-1',
        succeeded: true,
        inputTokens: 1200,
        outputTokens: 300,
        totalTokens: 1500,
        costUsd: d('0.0123456789'),
        chargeStatus: 'PENDING',
      });
    });

    it('records a failed request as not charged', async () => {
      prisma.aiUsage.findUnique.mockResolvedValue(null);
      prisma.aiUsage.create.mockResolvedValue(usageRow());

      await service.recordUsage(context, {
        provider: 'openrouter',
        providerRequestId: 'gen-2',
        succeeded: false,
        costUsd: 0.01,
      });

      expect(prisma.aiUsage.create.mock.calls[0]?.[0].data).toMatchObject({
        succeeded: false,
        chargeStatus: 'NOT_CHARGED',
      });
    });

    it('returns the existing row when the same provider response is recorded again', async () => {
      prisma.aiUsage.findUnique.mockResolvedValue(usageRow());

      await expect(
        service.recordUsage(context, {
          provider: 'openrouter',
          providerRequestId: 'gen-1',
          succeeded: true,
          costUsd: 0.025,
        }),
      ).resolves.toMatchObject({ id: 'usage-1' });
      expect(prisma.aiUsage.create.mock.calls).toHaveLength(0);
    });

    it('refuses a provider response already recorded for another run', async () => {
      prisma.aiUsage.findUnique.mockResolvedValue(
        usageRow({ aiRunId: 'run-2' }),
      );

      await expect(
        service.recordUsage(context, {
          provider: 'openrouter',
          providerRequestId: 'gen-1',
          succeeded: true,
        }),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('chargeInTransaction', () => {
    it.each([
      ['0.025', 5000, '5'],
      ['0.0000123', 5000, '0.00246'],
      ['0.025', 2500, '10'],
    ])(
      'deducts $%s at %d micro-dollars per credit as %s credits, with the cost and rate on the transaction',
      async (cost, rate, credits) => {
        givenRate(rate);
        prisma.aiUsage.findUniqueOrThrow.mockResolvedValue(
          usageRow({ costUsd: d(cost) }),
        );

        await expect(
          service.chargeInTransaction(prisma, 'usage-1', NOW),
        ).resolves.toEqual({
          status: 'CHARGED',
          credits,
          usdMicrosPerCredit: rate,
        });
        expect(wallets.deductInTransaction.mock.calls).toEqual([
          [
            prisma,
            {
              authId: 'user-1',
              credits: d(credits),
              idempotencyKey: 'ai-run:run-1',
              sessionId: 'session-1',
              reference: 'ai-run:run-1',
              cost: { usd: cost, usdMicrosPerCredit: rate },
              now: NOW,
            },
          ],
        ]);
        expect(prisma.aiUsage.update.mock.calls[0]?.[0]).toEqual({
          where: { id: 'usage-1' },
          data: {
            chargeStatus: 'CHARGED',
            creditTransactionId: 'tx-1',
            chargedCredits: d(credits),
            usdMicrosPerCredit: rate,
            chargedAt: NOW,
          },
        });
      },
    );

    it('reads the conversion rate in the charging transaction', async () => {
      prisma.aiUsage.findUniqueOrThrow.mockResolvedValue(usageRow());

      await service.chargeInTransaction(prisma, 'usage-1', NOW);

      expect(settings.getSettings.mock.calls).toEqual([[prisma]]);
    });

    it('marks a run that was already charged as not charged (no second deduction)', async () => {
      prisma.aiUsage.findUniqueOrThrow.mockResolvedValue(usageRow());
      wallets.deductInTransaction.mockResolvedValue(deduction(true));

      await expect(
        service.chargeInTransaction(prisma, 'usage-1', NOW),
      ).resolves.toMatchObject({ status: 'NOT_CHARGED', credits: '0' });
      expect(prisma.aiUsage.update.mock.calls[0]?.[0].data).toMatchObject({
        chargeStatus: 'NOT_CHARGED',
      });
    });

    it.each([
      ['a free request', { costUsd: d(0) }, 'FREE'],
      ['a cost below 0.0000005 credits', { costUsd: d('0.000000002') }, 'FREE'],
      ['no reported cost', { costUsd: null }, 'NOT_CHARGED'],
    ])('does not deduct for %s', async (_case, overrides, status) => {
      prisma.aiUsage.findUniqueOrThrow.mockResolvedValue(usageRow(overrides));

      await expect(
        service.chargeInTransaction(prisma, 'usage-1', NOW),
      ).resolves.toMatchObject({ status });
      expect(wallets.deductInTransaction.mock.calls).toHaveLength(0);
    });

    it('never charges a usage twice', async () => {
      prisma.aiUsage.findUniqueOrThrow.mockResolvedValue(
        usageRow({
          chargeStatus: 'CHARGED',
          chargedCredits: d(5),
          usdMicrosPerCredit: 5000,
        }),
      );

      await expect(
        service.chargeInTransaction(prisma, 'usage-1', NOW),
      ).resolves.toEqual({
        status: 'CHARGED',
        credits: '5',
        usdMicrosPerCredit: 5000,
      });
      expect(wallets.deductInTransaction.mock.calls).toHaveLength(0);
    });

    it('lets insufficient credits fail the charge (the caller rolls back)', async () => {
      prisma.aiUsage.findUniqueOrThrow.mockResolvedValue(usageRow());
      wallets.deductInTransaction.mockRejectedValue(
        new InsufficientCreditsError(),
      );

      await expect(
        service.chargeInTransaction(prisma, 'usage-1', NOW),
      ).rejects.toBeInstanceOf(InsufficientCreditsError);
      expect(prisma.aiUsage.update.mock.calls).toHaveLength(0);
    });
  });

  describe('close and pre-check', () => {
    it('only closes usages that are still pending', async () => {
      await service.close('usage-1', 'INSUFFICIENT_CREDITS');

      expect(prisma.aiUsage.updateMany.mock.calls[0]?.[0]).toEqual({
        where: { id: 'usage-1', chargeStatus: 'PENDING' },
        data: { chargeStatus: 'INSUFFICIENT_CREDITS' },
      });
    });

    it.each([
      ['available credits', '0.5', null, true],
      ['no credits but overage room', '0', { used: '2', limit: '5' }, true],
      [
        'no credits and the overage used up',
        '0',
        { used: '5', limit: '5' },
        false,
      ],
      [
        'no credits and a fresh session (configured allowance)',
        '0',
        null,
        true,
      ],
    ])(
      'with %s, a request can be made: %p',
      async (_case, available, overage, expected) => {
        wallets.getBalance.mockResolvedValue({
          availableCredits: available,
        } as never);
        prisma.creditSessionOverage.findUnique.mockResolvedValue(
          overage
            ? ({
                limitCredits: d(overage.limit),
                overageCredits: d(overage.used),
              } as never)
            : null,
        );

        await expect(
          service.hasSpendableCredits('user-1', 'session-1', NOW),
        ).resolves.toBe(expected);
      },
    );
  });
});
