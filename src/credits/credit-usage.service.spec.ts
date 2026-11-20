import { Prisma, type AiUsage } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../common/services/prisma.service';
import { CreditSettingsService } from './credit-settings.service';
import { creditsForCost, CreditUsageService } from './credit-usage.service';
import { InsufficientCreditsError } from './credit-wallet.errors';
import { CreditWalletService } from './credit-wallet.service';
import type { DebitCreditsResult } from './interfaces/credit-wallet.interface';

const D = (value: string | number) => new Prisma.Decimal(value);

describe('creditsForCost', () => {
  it.each([
    // [cost USD, USD micros per credit, step micro-credits, exact, due]
    ['0.023', 5000, 1_000_000, '4.6', '5'],
    ['0.023', 5000, 100_000, '4.6', '4.6'],
    ['0.023', 5000, 1, '4.6', '4.6'],
    ['0.025', 5000, 1_000_000, '5', '5'],
    ['0.0000001', 5000, 1_000_000, '0.00002', '1'],
    ['0.0000001', 5000, 1, '0.00002', '0.00002'],
    ['0.0000000012', 5000, 1, '0.00000024', '0.000001'],
    ['0.023', 2000, 1_000_000, '11.5', '12'],
    ['0', 5000, 1_000_000, '0', '0'],
  ])(
    '$%s at %i micros/credit, step %i -> exact %s, due %s',
    (cost, rate, step, exact, due) => {
      const result = creditsForCost(D(cost), rate, step);
      expect(result.exact.toFixed()).toBe(exact);
      expect(result.due.toFixed()).toBe(due);
    },
  );

  it('never charges less than the exact amount', () => {
    for (const cost of ['0.0049999', '0.005', '0.0050001', '1.2345678901']) {
      const { exact, due } = creditsForCost(D(cost), 5000, 1_000_000);
      expect(due.gte(exact)).toBe(true);
      expect(due.minus(exact).lt(1)).toBe(true);
    }
  });
});

describe('CreditUsageService', () => {
  const prisma = mockDeep<PrismaService>();
  const tx = mockDeep<PrismaService>();
  const wallet = mock<CreditWalletService>();
  const settings = mock<CreditSettingsService>();
  const service = new CreditUsageService(prisma, wallet, settings);
  const at = new Date('2026-12-01T10:00:00.000Z');

  const usage = (overrides: Partial<AiUsage> = {}): AiUsage => ({
    id: 'usage-1',
    authId: 'user-1',
    sessionId: 'session-1',
    runId: 'run-1',
    operation: 'GUIDE_QUESTION',
    provider: 'openrouter',
    model: 'openai/gpt-4.1-mini',
    providerRequestId: 'gen-1',
    outcome: 'SUCCEEDED',
    errorCode: null,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    costUsd: D('0.023'),
    chargeStatus: 'PENDING',
    chargeNote: null,
    creditCostUsdMicros: null,
    creditsExact: null,
    creditsDue: null,
    creditsCharged: null,
    transactionId: null,
    occurredAt: at,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  });
  const debit = (
    overrides: Partial<DebitCreditsResult> = {},
  ): DebitCreditsResult =>
    ({
      transaction: { id: 'tx-1' },
      consumed: '5',
      overage: '0',
      uncollected: '0',
      replayed: false,
      ...overrides,
    }) as DebitCreditsResult;
  const settled = () => tx.aiUsage.update.mock.calls[0]?.[0]?.data;

  beforeEach(() => {
    jest.resetAllMocks();
    settings.getSettings.mockResolvedValue({
      creditCostUsdMicros: 5000,
      deductionStepMicroCredits: 1_000_000,
    } as never);
    tx.aiUsage.update.mockImplementation(((args: { data: Partial<AiUsage> }) =>
      Promise.resolve(usage(args.data))) as never);
  });

  describe('chargeRun', () => {
    it('deducts the credits for the actual cost once per run, fixing the rate on the usage and its transaction', async () => {
      tx.aiUsage.findUniqueOrThrow.mockResolvedValue(usage());
      wallet.debit.mockResolvedValue(debit());

      await expect(
        service.chargeRun(tx, 'usage-1', { sources: ['PURCHASE'], at }),
      ).resolves.toMatchObject({
        status: 'CHARGED',
        creditsDue: '5',
        creditsCharged: '5',
        transactionId: 'tx-1',
      });

      expect(settings.getSettings.mock.calls).toEqual([[tx]]);
      expect(wallet.debit.mock.calls).toEqual([
        [
          {
            authId: 'user-1',
            amount: D(5),
            idempotencyKey: 'ai-run:run-1',
            sessionId: 'session-1',
            description: 'AI GUIDE_QUESTION (openai/gpt-4.1-mini)',
            sources: ['PURCHASE'],
            partial: true,
            usage: { costUsd: D('0.023'), creditCostUsdMicros: 5000 },
          },
          { tx, at },
        ],
      ]);
      expect(settled()).toEqual({
        creditCostUsdMicros: 5000,
        creditsExact: D('4.6'),
        creditsDue: D(5),
        creditsCharged: D(5),
        transactionId: 'tx-1',
        chargeStatus: 'CHARGED',
        chargeNote: null,
      });
    });

    it('charges fractional credits with a fractional deduction step', async () => {
      settings.getSettings.mockResolvedValue({
        creditCostUsdMicros: 5000,
        deductionStepMicroCredits: 1,
      } as never);
      tx.aiUsage.findUniqueOrThrow.mockResolvedValue(usage());
      wallet.debit.mockResolvedValue(debit({ consumed: '4.6' }));

      await service.chargeRun(tx, 'usage-1');

      expect(wallet.debit.mock.calls[0]?.[0]?.amount).toEqual(D('4.6'));
      expect(settled()).toMatchObject({ creditsCharged: D('4.6') });
    });

    it('uses the rate in force at the time of the charge', async () => {
      settings.getSettings.mockResolvedValue({
        creditCostUsdMicros: 2000,
        deductionStepMicroCredits: 1_000_000,
      } as never);
      tx.aiUsage.findUniqueOrThrow.mockResolvedValue(usage());
      wallet.debit.mockResolvedValue(debit({ consumed: '12' }));

      await service.chargeRun(tx, 'usage-1');

      expect(wallet.debit.mock.calls[0]?.[0]).toMatchObject({
        amount: D(12),
        usage: { creditCostUsdMicros: 2000 },
      });
      expect(settled()).toMatchObject({
        creditCostUsdMicros: 2000,
        creditsExact: D('11.5'),
      });
    });

    it('counts session overage towards the charge', async () => {
      tx.aiUsage.findUniqueOrThrow.mockResolvedValue(usage());
      wallet.debit.mockResolvedValue(
        debit({ consumed: '3.5', overage: '1.5' }),
      );

      await expect(service.chargeRun(tx, 'usage-1')).resolves.toMatchObject({
        status: 'CHARGED',
        creditsCharged: '5',
      });
    });

    it('never charges a run twice: a second usage of the same run is not charged', async () => {
      tx.aiUsage.findUniqueOrThrow.mockResolvedValue(usage({ id: 'usage-2' }));
      wallet.debit.mockResolvedValue(debit({ replayed: true }));

      await expect(service.chargeRun(tx, 'usage-2')).resolves.toMatchObject({
        status: 'NOT_CHARGED',
        note: 'RUN_ALREADY_CHARGED',
        transactionId: null,
      });
    });

    it('does nothing for a usage that was already settled', async () => {
      tx.aiUsage.findUniqueOrThrow.mockResolvedValue(
        usage({ chargeStatus: 'CHARGED', transactionId: 'tx-1' }),
      );
      await service.chargeRun(tx, 'usage-1');
      expect(wallet.debit.mock.calls).toHaveLength(0);
      expect(tx.aiUsage.update.mock.calls).toHaveLength(0);
    });

    it('records the part the user could not pay as UNCOLLECTED', async () => {
      tx.aiUsage.findUniqueOrThrow.mockResolvedValue(usage());
      wallet.debit.mockResolvedValue(
        debit({ consumed: '1', overage: '2', uncollected: '2' }),
      );

      await expect(service.chargeRun(tx, 'usage-1')).resolves.toMatchObject({
        status: 'UNCOLLECTED',
        note: 'INSUFFICIENT_CREDITS',
        creditsDue: '5',
        creditsCharged: '3',
        transactionId: 'tx-1',
      });
    });

    it('records a charge nothing could be collected for as UNCOLLECTED, without a transaction', async () => {
      tx.aiUsage.findUniqueOrThrow.mockResolvedValue(usage());
      wallet.debit.mockRejectedValue(
        new InsufficientCreditsError({ available: '0' }),
      );

      await expect(service.chargeRun(tx, 'usage-1')).resolves.toMatchObject({
        status: 'UNCOLLECTED',
        creditsCharged: '0',
        transactionId: null,
      });
    });

    it.each([
      ['no cost was reported', null, 'COST_UNAVAILABLE'],
      ['the request cost nothing', D(0), 'NO_COST'],
    ])('does not charge when %s', async (_case, costUsd, note) => {
      tx.aiUsage.findUniqueOrThrow.mockResolvedValue(usage({ costUsd }));

      await expect(service.chargeRun(tx, 'usage-1')).resolves.toMatchObject({
        status: 'NOT_CHARGED',
        note,
      });
      expect(wallet.debit.mock.calls).toHaveLength(0);
    });

    it('propagates other failures, so the publishing transaction rolls back', async () => {
      tx.aiUsage.findUniqueOrThrow.mockResolvedValue(usage());
      wallet.debit.mockRejectedValue(new Error('db down'));
      await expect(service.chargeRun(tx, 'usage-1')).rejects.toThrow('db down');
    });
  });

  describe('record', () => {
    const input = {
      authId: 'user-1',
      sessionId: 'session-1',
      runId: 'run-1',
      operation: 'GUIDE_QUESTION' as const,
      provider: 'openrouter',
      model: 'm',
      providerRequestId: 'gen-1',
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costUsd: '0.0000123456789',
      occurredAt: at,
    };

    it('stores the request with its tokens and exact cost, pending its charge', async () => {
      prisma.aiUsage.create.mockResolvedValue(usage());

      await service.record({ ...input, outcome: 'SUCCEEDED' });

      expect(prisma.aiUsage.create.mock.calls[0]?.[0]?.data).toMatchObject({
        authId: 'user-1',
        sessionId: 'session-1',
        runId: 'run-1',
        providerRequestId: 'gen-1',
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        costUsd: D('0.0000123456789'),
        chargeStatus: 'PENDING',
      });
    });

    it('stores a failed request as never charged', async () => {
      prisma.aiUsage.create.mockResolvedValue(usage());

      await service.record({
        ...input,
        outcome: 'FAILED',
        errorCode: 'AI_INVALID_JSON',
      });

      expect(prisma.aiUsage.create.mock.calls[0]?.[0]?.data).toMatchObject({
        outcome: 'FAILED',
        errorCode: 'AI_INVALID_JSON',
        chargeStatus: 'NOT_CHARGED',
        chargeNote: 'FAILED_ATTEMPT',
      });
    });

    it('returns the stored usage for a generation recorded before', async () => {
      prisma.aiUsage.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      prisma.aiUsage.findUniqueOrThrow.mockResolvedValue(usage());

      await expect(
        service.record({ ...input, outcome: 'SUCCEEDED' }),
      ).resolves.toMatchObject({ id: 'usage-1' });
      expect(prisma.aiUsage.findUniqueOrThrow.mock.calls[0]?.[0]).toEqual({
        where: {
          provider_providerRequestId: {
            provider: 'openrouter',
            providerRequestId: 'gen-1',
          },
        },
      });
    });
  });
});
