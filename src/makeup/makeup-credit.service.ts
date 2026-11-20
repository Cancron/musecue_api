import { Injectable } from '@nestjs/common';
import { AiUsageOutcome, type AiUsage, type Prisma } from '@prisma/client';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import {
  CreditUsageService,
  USAGE_NOTE,
  type SessionUsageView,
  type UsageChargeResult,
} from '../credits/credit-usage.service';
import { CreditWalletService } from '../credits/credit-wallet.service';
import { CreditEligibilityService } from '../subscription/credit-eligibility.service';
import type { AiCallMetadata } from './ai/ai.gateway';
import { AiProviderError } from './ai/ai-provider.error';
import type { AiOperation } from './interfaces/makeup.interface';
import type { MakeupAiJob } from './queues/makeup.queue';

export const INSUFFICIENT_CREDITS_FOR_AI = 'Insufficient credits';

/**
 * Connects makeup AI runs to credits: checks that the user can pay before a
 * provider request is made, records the usage of every provider request
 * against the user, makeup session and run, and charges the run once for
 * the request that produced its result (see CreditUsageService). Only the
 * credits the user may use now are spent (CreditEligibilityService).
 */
@Injectable()
export class MakeupCreditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: CreditUsageService,
    private readonly wallet: CreditWalletService,
    private readonly eligibility: CreditEligibilityService,
  ) {}

  /**
   * Refuses (without a provider request) an AI run of a user who has no
   * usable credits and no overage allowance left in the session.
   */
  async assertCanUseAi(authId: string, sessionId: string): Promise<void> {
    if ((await this.eligibility.getEligibility(authId)).eligible) return;
    const overage = await this.wallet.sessionOverageRemaining(
      authId,
      sessionId,
    );
    if (overage.gt(0)) return;
    throw new AiProviderError(
      'INSUFFICIENT_CREDITS',
      INSUFFICIENT_CREDITS_FOR_AI,
      false,
    );
  }

  /**
   * Records a provider request of a run; returns null when the provider
   * reported no usage (e.g. the deterministic mock gateway).
   */
  async recordUsage(
    job: MakeupAiJob,
    operation: AiOperation,
    provider: string,
    metadata: AiCallMetadata | undefined,
    failure?: AiProviderError,
  ): Promise<AiUsage | null> {
    if (!metadata?.usage) return null;
    return this.usage.record({
      authId: job.authId,
      sessionId: job.sessionId,
      runId: job.runId,
      operation,
      provider,
      model: metadata.model ?? 'unknown',
      providerRequestId: metadata.responseId,
      outcome: failure ? AiUsageOutcome.FAILED : AiUsageOutcome.SUCCEEDED,
      errorCode: failure?.code,
      inputTokens: metadata.usage.promptTokens,
      outputTokens: metadata.usage.completionTokens,
      totalTokens: metadata.usage.totalTokens,
      costUsd: metadata.usage.costUsd,
      occurredAt: new Date(),
    });
  }

  /** Charges the run for this usage, in the transaction publishing it. */
  async chargeRun(
    tx: Prisma.TransactionClient,
    usage: AiUsage,
  ): Promise<UsageChargeResult> {
    const sources = await this.eligibility.usableSources(usage.authId);
    return this.usage.chargeRun(tx, usage.id, { sources });
  }

  /** The run's result was not published (e.g. the run was cancelled). */
  discard(usage: AiUsage, note: string = USAGE_NOTE.RESULT_DISCARDED) {
    return this.usage.markNotCharged(usage.id, note);
  }

  /** Usage and exact totals of the caller's own makeup session. */
  async getSessionUsage(
    authId: string,
    sessionId: string,
  ): Promise<SessionUsageView> {
    const session = await this.prisma.makeupSession.findFirst({
      where: { id: sessionId, authId },
      select: { id: true },
    });
    if (!session) throw AppError.notFound('Session not found');
    return this.usage.getSessionUsage(authId, sessionId);
  }
}
