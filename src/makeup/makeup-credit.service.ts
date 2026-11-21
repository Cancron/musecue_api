import { Injectable } from '@nestjs/common';
import {
  AiUsageOutcome,
  type AiUsage,
  type CreditSource,
  type Prisma,
} from '@prisma/client';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import {
  CreditUsageService,
  USAGE_NOTE,
  type SessionUsageView,
  type UsageChargeResult,
} from '../credits/credit-usage.service';
import { InsufficientCreditsError } from '../credits/credit-wallet.errors';
import { CreditWalletService } from '../credits/credit-wallet.service';
import type {
  SessionCreditView,
  SessionUseView,
} from '../credits/interfaces/credit-wallet.interface';
import { CreditEligibilityService } from '../subscription/credit-eligibility.service';
import type { AiCallMetadata } from './ai/ai.gateway';
import { AiProviderError } from './ai/ai-provider.error';
import type { AiOperation } from './interfaces/makeup.interface';
import type { MakeupAiJob } from './queues/makeup.queue';

export const INSUFFICIENT_CREDITS_FOR_AI = 'Insufficient credits';

/** Session usage with the session's credit state (overage, reservation). */
export interface MakeupSessionUsageView extends SessionUsageView {
  /** Null if the session was never initialized for credits. */
  credits: SessionCreditView | null;
}

/**
 * Connects makeup sessions and their AI runs to credits: initializes a
 * session with free credits when it is created (reserving up to one credit
 * and fixing its overage allowance), checks that the session can pay
 * before an AI run is queued and before its provider request is made,
 * records the usage of every provider request against the user, makeup
 * session and run, and charges the run once for the request that produced
 * its result (see CreditUsageService and CreditWalletService). Only the
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
   * The credit sources the user may spend now. Read before opening the
   * transaction that uses them, so it holds no extra connection.
   */
  usableSources(authId: string): Promise<CreditSource[]> {
    return this.eligibility.usableSources(authId);
  }

  /**
   * Initializes a new makeup session for credits in the transaction that
   * creates it: needs free credits (InsufficientCreditsError, 403
   * "Insufficient credits", otherwise).
   */
  initializeSession(
    tx: Prisma.TransactionClient,
    authId: string,
    sessionId: string,
    sources: CreditSource[],
  ): Promise<SessionUseView> {
    return this.wallet.initializeSession(
      { authId, sessionId, sources },
      { tx },
    );
  }

  /**
   * Checks, in the transaction that queues an AI run, that the session can
   * pay for it (initializing it if needed); InsufficientCreditsError (403
   * "Insufficient credits") otherwise.
   */
  prepareAiRequest(
    tx: Prisma.TransactionClient,
    authId: string,
    sessionId: string,
    sources: CreditSource[],
  ): Promise<SessionUseView> {
    return this.wallet.prepareSessionUse(
      { authId, sessionId, sources },
      { tx },
    );
  }

  /**
   * Refuses (without a provider request) an AI run whose session cannot pay
   * any more: no free credits and no overage left, or not initialized and
   * no free credits to initialize it with.
   */
  async assertCanUseAi(authId: string, sessionId: string): Promise<void> {
    const sources = await this.eligibility.usableSources(authId);
    try {
      await this.wallet.prepareSessionUse({ authId, sessionId, sources });
    } catch (error) {
      if (!(error instanceof InsufficientCreditsError)) throw error;
      throw new AiProviderError(
        'INSUFFICIENT_CREDITS',
        INSUFFICIENT_CREDITS_FOR_AI,
        false,
      );
    }
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

  /**
   * Charges the run for this usage, in the transaction publishing it, and
   * settles the pending usage of the run's earlier (interrupted) attempts
   * as not charged.
   */
  async chargeRun(
    tx: Prisma.TransactionClient,
    usage: AiUsage,
    sources: CreditSource[],
  ): Promise<UsageChargeResult> {
    const charge = await this.usage.chargeRun(tx, usage.id, { sources });
    await this.usage.settleRunAttempts(
      tx,
      usage.runId,
      USAGE_NOTE.SUPERSEDED_ATTEMPT,
      usage.id,
    );
    return charge;
  }

  /**
   * Settles usage left pending by interrupted attempts whose run cannot
   * publish any more (recovery sweep).
   */
  settleInterruptedUsage(olderThan: Date): Promise<number> {
    return this.usage.settleInterruptedUsage(olderThan);
  }

  /** The run's result was not published (e.g. the run was cancelled). */
  discard(usage: AiUsage, note: string = USAGE_NOTE.RESULT_DISCARDED) {
    return this.usage.markNotCharged(usage.id, note);
  }

  /**
   * Usage, exact totals and the credit state (reservation, overage) of the
   * caller's own makeup session, also after the session was deleted. 404
   * for another user's session, indistinguishable from a missing one.
   */
  async getSessionUsage(
    authId: string,
    sessionId: string,
  ): Promise<MakeupSessionUsageView> {
    const [session, recorded] = await Promise.all([
      this.prisma.makeupSession.findFirst({
        where: { id: sessionId, authId },
        select: { id: true },
      }),
      this.prisma.aiUsage.findFirst({
        where: { sessionId, authId },
        select: { id: true },
      }),
    ]);
    if (!session && !recorded) throw AppError.notFound('Session not found');
    const [usage, credits] = await Promise.all([
      this.usage.getSessionUsage(authId, sessionId),
      this.wallet.getSessionCredits(authId, sessionId),
    ]);
    return { ...usage, credits };
  }
}
