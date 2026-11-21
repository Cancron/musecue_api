import { Injectable } from '@nestjs/common';
import {
  AiUsageChargeStatus,
  AiUsageOutcome,
  Prisma,
  type AiOperation,
  type AiUsage,
  type CreditSource,
} from '@prisma/client';
import { PrismaService } from '../common/services/prisma.service';
import { formatCredits, ZERO_CREDITS } from './credit-amount';
import {
  formatUsdMicros,
  MICRO_CREDITS_PER_CREDIT,
  USD_MICROS_PER_USD,
} from './credit-settings.constants';
import { CreditSettingsService } from './credit-settings.service';
import { InsufficientCreditsError } from './credit-wallet.errors';
import { CreditWalletService } from './credit-wallet.service';

/** Why a usage was not (fully) charged (AiUsage.chargeNote). */
export const USAGE_NOTE = {
  FAILED_ATTEMPT: 'FAILED_ATTEMPT',
  RESULT_DISCARDED: 'RESULT_DISCARDED',
  RUN_ALREADY_CHARGED: 'RUN_ALREADY_CHARGED',
  COST_UNAVAILABLE: 'COST_UNAVAILABLE',
  NO_COST: 'NO_COST',
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  /** An earlier attempt of a run whose result another attempt published. */
  SUPERSEDED_ATTEMPT: 'SUPERSEDED_ATTEMPT',
  /** The run failed (or was failed by recovery) without a published result. */
  RUN_FAILED: 'RUN_FAILED',
  /** Left pending by an interrupted attempt; settled by the recovery sweep. */
  INTERRUPTED: 'INTERRUPTED',
} as const;

/** AI runs that may still publish a result (and charge their usage). */
const UNFINISHED_RUN_STATUSES = ['QUEUED', 'PROCESSING'] as const;

/** One provider request as reported by the provider. */
export interface AiUsageRecord {
  authId: string;
  sessionId: string;
  runId: string;
  operation: AiOperation;
  provider: string;
  model: string;
  providerRequestId?: string;
  outcome: AiUsageOutcome;
  errorCode?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** usage.cost in USD as a decimal string; undefined if not reported. */
  costUsd?: string;
  occurredAt: Date;
}

export interface UsageChargeResult {
  status: AiUsageChargeStatus;
  note: string | null;
  creditsDue: string | null;
  creditsCharged: string | null;
  transactionId: string | null;
}

/** The AI usage of one makeup session: one entry per provider request. */
export interface SessionUsageView {
  usages: Array<{
    id: string;
    runId: string;
    operation: AiOperation;
    model: string;
    outcome: AiUsageOutcome;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: string | null;
    chargeStatus: AiUsageChargeStatus;
    /** Why it was not (fully) charged, e.g. FAILED_ATTEMPT. */
    chargeNote: string | null;
    /** The conversion rate used: USD micros per credit, and as USD. */
    creditCostUsdMicros: number | null;
    creditCostUsd: string | null;
    /** Credits for the cost: exact, due (after rounding) and deducted. */
    creditsExact: string | null;
    creditsDue: string | null;
    creditsCharged: string | null;
    /** Part of creditsCharged covered by the session's overage allowance. */
    overageCredits: string | null;
    /** The DEBIT transaction that charged it (see the credit history). */
    transactionId: string | null;
    occurredAt: string;
  }>;
  totals: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: string;
    creditsCharged: string;
    overageCredits: string;
    /** Credits that were due but could not be collected. */
    uncollectedCredits: string;
  };
}

/**
 * Credits for `costUsd` at `creditCostUsdMicros` (USD micros per credit),
 * exactly and rounded up to the deduction step (in micro-credits). Pure.
 */
export function creditsForCost(
  costUsd: Prisma.Decimal,
  creditCostUsdMicros: number,
  deductionStepMicroCredits: number,
): { exact: Prisma.Decimal; due: Prisma.Decimal } {
  const exact = costUsd
    .times(USD_MICROS_PER_USD)
    .dividedBy(creditCostUsdMicros);
  const step = new Prisma.Decimal(deductionStepMicroCredits).dividedBy(
    MICRO_CREDITS_PER_CREDIT,
  );
  return { exact, due: exact.dividedBy(step).ceil().times(step) };
}

const errorCodeOf = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null;

/**
 * AI usage metering and credit deductions. Every provider request the
 * provider reported usage for is stored (AiUsage) with its user, makeup
 * session, run, tokens and cost in USD; a generation is stored once.
 *
 * A run is charged once, for the request that produced its result, in the
 * transaction that publishes the result: credits = cost / rate (the
 * settings' `creditCostUsdMicros`, default $0.005), rounded up to
 * `deductionStepMicroCredits` (default exact: $0.025 -> 5, $0.023 -> 4.6).
 * The DEBIT uses the idempotency key `ai-run:<runId>`, so retries and duplicate
 * executions never charge twice, and the wallet lock keeps parallel charges
 * exact. The rate is fixed on the usage and its transaction, so changing it
 * never alters history. A charge is paid from the session's free balance
 * first, then from the session's overage allowance (see CreditWalletService);
 * what neither can cover is recorded as UNCOLLECTED, never as a negative
 * balance.
 */
@Injectable()
export class CreditUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: CreditWalletService,
    private readonly settings: CreditSettingsService,
  ) {}

  /**
   * Stores one provider request. Idempotent per provider generation: a
   * generation recorded before is returned unchanged. Failed requests are
   * recorded as never charged.
   */
  async record(input: AiUsageRecord): Promise<AiUsage> {
    const failed = input.outcome === AiUsageOutcome.FAILED;
    const data: Prisma.AiUsageUncheckedCreateInput = {
      authId: input.authId,
      sessionId: input.sessionId,
      runId: input.runId,
      operation: input.operation,
      provider: input.provider,
      model: input.model,
      providerRequestId: input.providerRequestId ?? null,
      outcome: input.outcome,
      errorCode: input.errorCode ?? null,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      totalTokens:
        input.totalTokens ??
        (input.inputTokens ?? 0) + (input.outputTokens ?? 0),
      costUsd:
        input.costUsd === undefined ? null : new Prisma.Decimal(input.costUsd),
      chargeStatus: failed
        ? AiUsageChargeStatus.NOT_CHARGED
        : AiUsageChargeStatus.PENDING,
      chargeNote: failed ? USAGE_NOTE.FAILED_ATTEMPT : null,
      occurredAt: input.occurredAt,
    };
    if (!input.providerRequestId) {
      return this.prisma.aiUsage.create({ data });
    }
    try {
      return await this.prisma.aiUsage.create({ data });
    } catch (error) {
      if (errorCodeOf(error) !== 'P2002') throw error;
      // The same generation was recorded already (a retried delivery).
      return this.prisma.aiUsage.findUniqueOrThrow({
        where: {
          provider_providerRequestId: {
            provider: input.provider,
            providerRequestId: input.providerRequestId,
          },
        },
      });
    }
  }

  /**
   * Charges a run's usage in the caller's transaction (the one publishing
   * the run's result). Spends only `sources` when given. Does nothing if
   * the usage was already settled.
   */
  async chargeRun(
    tx: Prisma.TransactionClient,
    usageId: string,
    options: { sources?: CreditSource[]; at?: Date } = {},
  ): Promise<UsageChargeResult> {
    // Charges of the same run (and the settling of its other attempts) are
    // serialized on the run's usage rows, locked in one order (no deadlock).
    await tx.$queryRaw`
      SELECT "id" FROM "AiUsage"
      WHERE "runId" = (SELECT "runId" FROM "AiUsage" WHERE "id" = ${usageId})
      ORDER BY "id"
      FOR UPDATE
    `;
    const usage = await tx.aiUsage.findUniqueOrThrow({
      where: { id: usageId },
    });
    if (usage.chargeStatus !== AiUsageChargeStatus.PENDING) {
      return this.toChargeResult(usage);
    }
    if (usage.costUsd === null) {
      return this.settle(tx, usage, {
        chargeStatus: AiUsageChargeStatus.NOT_CHARGED,
        chargeNote: USAGE_NOTE.COST_UNAVAILABLE,
      });
    }

    const settings = await this.settings.getSettings(tx);
    const rate = settings.creditCostUsdMicros;
    const { exact, due } = creditsForCost(
      usage.costUsd,
      rate,
      settings.deductionStepMicroCredits,
    );
    const terms = {
      creditCostUsdMicros: rate,
      creditsExact: exact.toDecimalPlaces(12, Prisma.Decimal.ROUND_UP),
      creditsDue: due,
    };
    if (due.lte(0)) {
      return this.settle(tx, usage, {
        ...terms,
        creditsCharged: ZERO_CREDITS,
        chargeStatus: AiUsageChargeStatus.NOT_CHARGED,
        chargeNote: USAGE_NOTE.NO_COST,
      });
    }

    try {
      const debit = await this.wallet.debit(
        {
          authId: usage.authId,
          amount: due,
          idempotencyKey: `ai-run:${usage.runId}`,
          sessionId: usage.sessionId,
          description: `AI ${usage.operation} (${usage.model})`,
          sources: options.sources,
          partial: true,
          usage: { costUsd: usage.costUsd, creditCostUsdMicros: rate },
        },
        { tx, at: options.at },
      );
      if (debit.replayed) {
        // Another request of the same run was charged already.
        return this.settle(tx, usage, {
          ...terms,
          chargeStatus: AiUsageChargeStatus.NOT_CHARGED,
          chargeNote: USAGE_NOTE.RUN_ALREADY_CHARGED,
        });
      }
      const charged = new Prisma.Decimal(debit.consumed).plus(debit.overage);
      const uncollected = new Prisma.Decimal(debit.uncollected).gt(0);
      return this.settle(tx, usage, {
        ...terms,
        creditsCharged: charged,
        transactionId: debit.transaction.id,
        chargeStatus: uncollected
          ? AiUsageChargeStatus.UNCOLLECTED
          : AiUsageChargeStatus.CHARGED,
        chargeNote: uncollected ? USAGE_NOTE.INSUFFICIENT_CREDITS : null,
      });
    } catch (error) {
      if (!(error instanceof InsufficientCreditsError)) throw error;
      // Nothing at all could be collected.
      return this.settle(tx, usage, {
        ...terms,
        creditsCharged: ZERO_CREDITS,
        chargeStatus: AiUsageChargeStatus.UNCOLLECTED,
        chargeNote: USAGE_NOTE.INSUFFICIENT_CREDITS,
      });
    }
  }

  /** Marks a usage that will not be charged (only while it is PENDING). */
  async markNotCharged(usageId: string, note: string): Promise<void> {
    await this.prisma.aiUsage.updateMany({
      where: { id: usageId, chargeStatus: AiUsageChargeStatus.PENDING },
      data: { chargeStatus: AiUsageChargeStatus.NOT_CHARGED, chargeNote: note },
    });
  }

  /**
   * Settles the still PENDING usage of a run's other attempts as not
   * charged, e.g. an attempt interrupted after its provider response was
   * recorded, in the transaction that charged (or failed) the run. Returns
   * how many were settled.
   */
  async settleRunAttempts(
    tx: Prisma.TransactionClient,
    runId: string,
    note: string,
    exceptUsageId?: string,
  ): Promise<number> {
    const { count } = await tx.aiUsage.updateMany({
      where: {
        runId,
        chargeStatus: AiUsageChargeStatus.PENDING,
        ...(exceptUsageId ? { id: { not: exceptUsageId } } : {}),
      },
      data: { chargeStatus: AiUsageChargeStatus.NOT_CHARGED, chargeNote: note },
    });
    return count;
  }

  /**
   * Settles usage left PENDING by interrupted attempts whose run can no
   * longer publish a result (finished, failed or deleted), recorded before
   * `olderThan`. Such usage is never charged: a run is charged only with its
   * published result. Returns how many were settled.
   */
  async settleInterruptedUsage(olderThan: Date, limit = 500): Promise<number> {
    const pending = await this.prisma.aiUsage.findMany({
      where: {
        chargeStatus: AiUsageChargeStatus.PENDING,
        occurredAt: { lt: olderThan },
      },
      select: { id: true, runId: true },
      orderBy: { occurredAt: 'asc' },
      take: limit,
    });
    if (pending.length === 0) return 0;
    const unfinished = new Set(
      (
        await this.prisma.aiRun.findMany({
          where: {
            id: { in: [...new Set(pending.map((usage) => usage.runId))] },
            status: { in: [...UNFINISHED_RUN_STATUSES] },
          },
          select: { id: true },
        })
      ).map((run) => run.id),
    );
    const settle = pending.filter((usage) => !unfinished.has(usage.runId));
    if (settle.length === 0) return 0;
    const { count } = await this.prisma.aiUsage.updateMany({
      where: {
        id: { in: settle.map((usage) => usage.id) },
        chargeStatus: AiUsageChargeStatus.PENDING,
      },
      data: {
        chargeStatus: AiUsageChargeStatus.NOT_CHARGED,
        chargeNote: USAGE_NOTE.INTERRUPTED,
      },
    });
    return count;
  }

  /**
   * Every provider request of a makeup session with exact totals (summed
   * in PostgreSQL). The caller checks that the session is the user's.
   */
  async getSessionUsage(
    authId: string,
    sessionId: string,
  ): Promise<SessionUsageView> {
    const where = { authId, sessionId };
    const [usages, totals, overage, uncollected] = await Promise.all([
      this.prisma.aiUsage.findMany({
        where,
        orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
        include: { transaction: { select: { overageAmount: true } } },
      }),
      this.prisma.aiUsage.aggregate({
        where,
        _count: { _all: true },
        _sum: {
          inputTokens: true,
          outputTokens: true,
          totalTokens: true,
          costUsd: true,
          creditsCharged: true,
        },
      }),
      this.prisma.creditTransaction.aggregate({
        where: { authId, sessionId, aiUsage: { isNot: null } },
        _sum: { overageAmount: true },
      }),
      this.prisma.aiUsage.aggregate({
        where: { ...where, chargeStatus: AiUsageChargeStatus.UNCOLLECTED },
        _sum: { creditsDue: true, creditsCharged: true },
      }),
    ]);
    return {
      usages: usages.map((usage) => ({
        id: usage.id,
        runId: usage.runId,
        operation: usage.operation,
        model: usage.model,
        outcome: usage.outcome,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        costUsd: usage.costUsd === null ? null : formatCredits(usage.costUsd),
        chargeStatus: usage.chargeStatus,
        chargeNote: usage.chargeNote,
        creditCostUsdMicros: usage.creditCostUsdMicros,
        creditCostUsd:
          usage.creditCostUsdMicros === null
            ? null
            : formatUsdMicros(usage.creditCostUsdMicros),
        creditsExact:
          usage.creditsExact === null
            ? null
            : formatCredits(usage.creditsExact),
        creditsDue:
          usage.creditsDue === null ? null : formatCredits(usage.creditsDue),
        creditsCharged:
          usage.creditsCharged === null
            ? null
            : formatCredits(usage.creditsCharged),
        overageCredits: usage.transaction
          ? formatCredits(usage.transaction.overageAmount)
          : null,
        transactionId: usage.transactionId,
        occurredAt: usage.occurredAt.toISOString(),
      })),
      totals: {
        requests: totals._count._all,
        inputTokens: totals._sum.inputTokens ?? 0,
        outputTokens: totals._sum.outputTokens ?? 0,
        totalTokens: totals._sum.totalTokens ?? 0,
        costUsd: formatCredits(totals._sum.costUsd ?? ZERO_CREDITS),
        creditsCharged: formatCredits(
          totals._sum.creditsCharged ?? ZERO_CREDITS,
        ),
        overageCredits: formatCredits(
          overage._sum.overageAmount ?? ZERO_CREDITS,
        ),
        uncollectedCredits: formatCredits(
          (uncollected._sum.creditsDue ?? ZERO_CREDITS).minus(
            uncollected._sum.creditsCharged ?? ZERO_CREDITS,
          ),
        ),
      },
    };
  }

  /**
   * Writes the usage's charge once: only while it is still PENDING (the
   * database allows nothing else). If a concurrent transaction settled it
   * first, e.g. as a superseded attempt of a run charged meanwhile, that
   * result stands and is returned.
   */
  private async settle(
    tx: Prisma.TransactionClient,
    usage: AiUsage,
    data: Prisma.AiUsageUncheckedUpdateInput,
  ): Promise<UsageChargeResult> {
    try {
      const settled = await tx.aiUsage.update({
        where: { id: usage.id, chargeStatus: AiUsageChargeStatus.PENDING },
        data,
      });
      return this.toChargeResult(settled);
    } catch (error) {
      if (errorCodeOf(error) !== 'P2025') throw error;
      return this.toChargeResult(
        await tx.aiUsage.findUniqueOrThrow({ where: { id: usage.id } }),
      );
    }
  }

  private toChargeResult(usage: AiUsage): UsageChargeResult {
    return {
      status: usage.chargeStatus,
      note: usage.chargeNote,
      creditsDue:
        usage.creditsDue === null ? null : formatCredits(usage.creditsDue),
      creditsCharged:
        usage.creditsCharged === null
          ? null
          : formatCredits(usage.creditsCharged),
      transactionId: usage.transactionId,
    };
  }
}
