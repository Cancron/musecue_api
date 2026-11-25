import { Injectable } from '@nestjs/common';
import {
  AiUsageChargeStatus,
  Prisma,
  type AiOperation,
  type AiUsage,
} from '@prisma/client';
import { PrismaService } from '../common/services/prisma.service';
import {
  creditsForCost,
  formatCredits,
  parseUsdCost,
  ZERO_CREDITS,
} from './credit-ledger.policy';
import { CreditSettingsService } from './credit-settings.service';
import { CreditWalletService } from './credit-wallet.service';
import { CreditConflictError } from './credit.errors';

type Tx = Prisma.TransactionClient;

/** The AI run a provider request served. */
export interface AiUsageContext {
  authId: string;
  sessionId: string;
  aiRunId: string;
  operation: AiOperation;
  /** Job attempt of the run (1, 2, ...). */
  attempt: number;
}

/** What the provider reported for one request. */
export interface ProviderUsage {
  provider: string;
  model?: string;
  /** The provider's request ID (OpenRouter generation ID). */
  providerRequestId?: string;
  /** Whether the response was usable as the run's result. */
  succeeded: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** usage.cost in US dollars. */
  costUsd?: number | string;
}

export interface UsageChargeOutcome {
  status: AiUsageChargeStatus;
  /** Credits deducted (0 unless CHARGED). */
  credits: string;
  usdMicrosPerCredit: number | null;
}

const nonNegativeInt = (value: number | undefined) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;

/**
 * AI usage tracking and credit charging. Every provider request is recorded
 * (AiUsage: tokens and the provider's cost in US dollars, tied to the user,
 * makeup session and AI run). Each AI run is charged once, for the request
 * whose result is published, by its actual cost converted at the current
 * rate (CreditSettings.openRouterUsdMicrosPerCredit; $0.005 per credit by
 * default): credits = round(cost / rate, 6). The charge is made inside the
 * transaction that publishes the result, with the run as idempotency key,
 * so retries, re-processing and duplicate requests never charge twice, and
 * concurrent charges are serialized by the wallet lock. The USD cost and the
 * rate are stored on the ledger transaction and the usage, so later rate
 * changes never alter history.
 */
@Injectable()
export class CreditUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CreditSettingsService,
    private readonly wallets: CreditWalletService,
  ) {}

  /**
   * Whether the user can still pay for AI work in this session: available
   * credits, or overage room for this session (a session started with
   * credits, within its own and the user's overage allowance). Checked
   * before a provider request is made; the charge re-checks under the lock.
   */
  async hasSpendableCredits(
    authId: string,
    sessionId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const spendable = await this.wallets.spendableForSession(
      authId,
      sessionId,
      now,
    );
    return (
      /[1-9]/.test(spendable.availableCredits) ||
      /[1-9]/.test(spendable.overageRoomCredits)
    );
  }

  /**
   * Closes the PENDING usages of a run (NOT_CHARGED), e.g. of an earlier
   * attempt that was interrupted between recording its response and
   * publishing it. A run's charge is made by the publishing transaction only,
   * so a usage that is still pending when the run moves on is never charged.
   */
  async closePendingForRun(client: Tx, aiRunId: string): Promise<number> {
    const { count } = await client.aiUsage.updateMany({
      where: { aiRunId, chargeStatus: AiUsageChargeStatus.PENDING },
      data: { chargeStatus: AiUsageChargeStatus.NOT_CHARGED },
    });
    return count;
  }

  /**
   * Reconciles usages left PENDING by an interrupted worker (for example the
   * process died between recording a response and publishing it): those
   * whose run has completed or failed, or no longer exists, are closed as
   * NOT_CHARGED. Their run was charged at most once, by its publication.
   */
  async reconcileStaleUsage(): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "AiUsage" u SET "chargeStatus" = 'NOT_CHARGED',
          "updatedAt" = (now() AT TIME ZONE 'UTC')
      WHERE u."chargeStatus" = 'PENDING'
        AND NOT EXISTS (
          SELECT 1 FROM "AiRun" r
          WHERE r."id" = u."aiRunId" AND r."status" IN ('QUEUED', 'PROCESSING')
        )`;
  }

  /**
   * Records one provider request. Idempotent per provider request ID: the
   * same response recorded again returns the existing row. A failed request
   * is recorded as NOT_CHARGED; a usable one as PENDING until its run's
   * result is published (chargeInTransaction) or discarded (close).
   */
  async recordUsage(
    context: AiUsageContext,
    usage: ProviderUsage,
  ): Promise<AiUsage> {
    const providerRequestId = usage.providerRequestId?.trim().slice(0, 200);
    if (providerRequestId) {
      const existing = await this.findByRequest(
        usage.provider,
        providerRequestId,
      );
      if (existing) return this.sameRun(existing, context);
    }
    try {
      return await this.prisma.aiUsage.create({
        data: {
          authId: context.authId,
          sessionId: context.sessionId,
          aiRunId: context.aiRunId,
          operation: context.operation,
          attempt: context.attempt,
          provider: usage.provider.slice(0, 50),
          model: usage.model?.slice(0, 200) ?? null,
          providerRequestId: providerRequestId || null,
          succeeded: usage.succeeded,
          inputTokens: nonNegativeInt(usage.inputTokens),
          outputTokens: nonNegativeInt(usage.outputTokens),
          totalTokens: nonNegativeInt(usage.totalTokens),
          costUsd: parseUsdCost(usage.costUsd),
          chargeStatus: usage.succeeded
            ? AiUsageChargeStatus.PENDING
            : AiUsageChargeStatus.NOT_CHARGED,
        },
      });
    } catch (error) {
      // A concurrent recording of the same response won the unique index.
      if (
        providerRequestId &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.findByRequest(
          usage.provider,
          providerRequestId,
        );
        if (existing) return this.sameRun(existing, context);
      }
      throw error;
    }
  }

  /**
   * Charges a PENDING usage inside the transaction that publishes its run's
   * result: converts its cost at the current rate and deducts the credits
   * (session overage allowed), once per run. Throws InsufficientCreditsError
   * when the credits and the session's overage do not cover the cost (the
   * caller's transaction then rolls back and the run fails).
   */
  async chargeInTransaction(
    tx: Tx,
    usageId: string,
    now: Date = new Date(),
  ): Promise<UsageChargeOutcome> {
    const usage = await tx.aiUsage.findUniqueOrThrow({
      where: { id: usageId },
    });
    if (usage.chargeStatus !== AiUsageChargeStatus.PENDING) {
      return {
        status: usage.chargeStatus,
        credits: formatCredits(usage.chargedCredits ?? ZERO_CREDITS),
        usdMicrosPerCredit: usage.usdMicrosPerCredit,
      };
    }
    const rate = (await this.settings.getSettings(tx))
      .openRouterUsdMicrosPerCredit;
    if (!usage.costUsd) {
      // The provider reported no cost: nothing to convert.
      return this.finish(tx, usage.id, AiUsageChargeStatus.NOT_CHARGED, null);
    }
    const credits = creditsForCost(usage.costUsd, rate);
    if (credits.lte(0)) {
      return this.finish(tx, usage.id, AiUsageChargeStatus.FREE, rate);
    }

    const { duplicate, transaction } = await this.wallets.deductInTransaction(
      tx,
      {
        authId: usage.authId,
        credits,
        idempotencyKey: `ai-run:${usage.aiRunId}`,
        sessionId: usage.sessionId,
        reference: `ai-run:${usage.aiRunId}`,
        cost: { usd: usage.costUsd.toFixed(), usdMicrosPerCredit: rate },
        now,
      },
    );
    if (duplicate) {
      // The run was already charged (for another of its requests).
      return this.finish(tx, usage.id, AiUsageChargeStatus.NOT_CHARGED, null);
    }
    await tx.aiUsage.update({
      where: { id: usage.id },
      data: {
        chargeStatus: AiUsageChargeStatus.CHARGED,
        creditTransactionId: transaction.id,
        chargedCredits: credits,
        usdMicrosPerCredit: rate,
        chargedAt: now,
      },
    });
    return {
      status: AiUsageChargeStatus.CHARGED,
      credits: formatCredits(credits),
      usdMicrosPerCredit: rate,
    };
  }

  /**
   * Closes a usage that was not charged: its result was not published
   * (NOT_CHARGED), or the credits did not cover it (INSUFFICIENT_CREDITS).
   * Only PENDING usages change; charged ones are final.
   */
  async close(
    usageId: string,
    status:
      | typeof AiUsageChargeStatus.NOT_CHARGED
      | typeof AiUsageChargeStatus.INSUFFICIENT_CREDITS = AiUsageChargeStatus.NOT_CHARGED,
  ): Promise<void> {
    await this.prisma.aiUsage.updateMany({
      where: { id: usageId, chargeStatus: AiUsageChargeStatus.PENDING },
      data: { chargeStatus: status },
    });
  }

  private async finish(
    tx: Tx,
    usageId: string,
    status: AiUsageChargeStatus,
    rate: number | null,
  ): Promise<UsageChargeOutcome> {
    await tx.aiUsage.update({
      where: { id: usageId },
      data: { chargeStatus: status, usdMicrosPerCredit: rate },
    });
    return { status, credits: '0', usdMicrosPerCredit: rate };
  }

  private findByRequest(provider: string, providerRequestId: string) {
    return this.prisma.aiUsage.findUnique({
      where: {
        provider_providerRequestId: {
          provider: provider.slice(0, 50),
          providerRequestId,
        },
      },
    });
  }

  private sameRun(existing: AiUsage, context: AiUsageContext): AiUsage {
    if (existing.aiRunId !== context.aiRunId) {
      throw new CreditConflictError(
        'This provider request was already recorded for another AI run',
      );
    }
    return existing;
  }
}
