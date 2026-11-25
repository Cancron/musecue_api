import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../../common/services/prisma.service';
import { PrivateImageStorageService } from '../../storage/private-image-storage.service';
import {
  PrivateImageUnavailableError,
  loadOwnedPrivateImage,
} from '../private-image-content';
import {
  isMissingPrivateObject,
  isPrivateStorageError,
} from '../../storage/private-storage.error';
import {
  AI_GATEWAY,
  type AiCallMetadata,
  type AiGateway,
} from '../ai/ai.gateway';
import { AiProviderError, isRetryableAiError } from '../ai/ai-provider.error';
import type {
  AiImageInput,
  AiOperation,
  GuideStepResult,
  RecommendationResult,
} from '../interfaces/makeup.interface';
import type {
  AbandonedJob,
  JobExecution,
  JobHandler,
} from '../../infrastructure/jobs/job.types';
import type { MakeupAiJob } from './makeup.queue';
import {
  canPublishRun,
  failRun,
  INTERRUPTED_RUN_MESSAGE,
  readRunJobInput,
} from './run-lifecycle';
import { lockSession } from '../workflow-lock';
import { CreditUsageService } from '../../credit/credit-usage.service';
import {
  INSUFFICIENT_CREDITS_MESSAGE,
  InsufficientCreditsError,
} from '../../credit/credit.errors';

/** A job's data plus what this attempt needs for usage accounting. */
type RunContext = MakeupAiJob & {
  operation: AiOperation;
  /** Job attempt (1, 2, ...). */
  attempt: number;
  provider: string;
  /** Whether requests are billed (recorded and charged in credits). */
  billable: boolean;
};

/** A Prisma/driver error code (e.g. P1001) for logs; never the message. */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === 'string' || typeof code === 'number'
    ? String(code)
    : undefined;
}

/**
 * Runs makeup AI jobs: loads the run's input, calls the AI gateway, validates
 * and publishes the result, and decides retries and terminal failures. Used
 * by both queue drivers (the BullMQ processor and the PostgreSQL worker).
 */
@Injectable()
export class MakeupJobHandler implements JobHandler<MakeupAiJob> {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(AI_GATEWAY) private readonly ai: AiGateway,
    private readonly imageStorage: PrivateImageStorageService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly credits: CreditUsageService,
  ) {}

  async process(job: JobExecution<MakeupAiJob>): Promise<void> {
    const startedAt = Date.now();
    const existingRun = await this.prisma.aiRun.findUnique({
      where: { id: job.data.runId },
      select: { status: true, jobInput: true },
    });
    if (
      !existingRun ||
      existingRun.status === 'COMPLETED' ||
      existingRun.status === 'FAILED'
    )
      return;
    // The input recorded on the run is authoritative; the queue payload only
    // carries it for runs created before it was recorded.
    const descriptor = this.ai.describe(job.name as AiOperation);
    const data: RunContext = {
      ...job.data,
      ...readRunJobInput(existingRun.jobInput),
      operation: job.name as AiOperation,
      attempt: job.attemptsMade + 1,
      provider: descriptor.provider,
      billable: descriptor.billable,
    };
    const claim = await this.prisma.$transaction(async (tx) => {
      await lockSession(tx, data.authId, data.sessionId);
      return tx.aiRun.updateMany({
        where: { id: data.runId, status: { in: ['QUEUED', 'PROCESSING'] } },
        data: {
          status: 'PROCESSING',
          progress: 20,
          startedAt: new Date(startedAt),
          provider: descriptor.provider,
          model: descriptor.model,
          promptVersion: descriptor.promptVersion,
          error: null,
        },
      });
    });
    if (!claim.count) return;

    try {
      // An earlier attempt of this run may have been interrupted after its
      // response was recorded: that usage can no longer be charged.
      if (data.billable) {
        await this.credits.closePendingForRun(this.prisma, data.runId);
      }
      // A billable request is only made while the user can still pay for it
      // (available credits or session overage room); the cost is charged
      // when the result is published.
      if (
        data.billable &&
        !(await this.credits.hasSpendableCredits(data.authId, data.sessionId))
      ) {
        throw new AiProviderError(
          'INSUFFICIENT_CREDITS',
          INSUFFICIENT_CREDITS_MESSAGE,
          false,
        );
      }
      switch (job.name) {
        case 'PERSONALIZATION':
          await this.personalize(data, startedAt);
          break;
        case 'GUIDE_GENERATION':
          await this.generateGuide(data, startedAt);
          break;
        case 'VISION_CHECK':
          await this.evaluateStep(data, startedAt);
          break;
        case 'GUIDE_QUESTION':
          await this.answerQuestion(data, startedAt);
          break;
        default:
          throw new Error(`Unsupported makeup job: ${job.name}`);
      }
    } catch (error) {
      // The provider answered (and billed) but the answer was rejected: the
      // request is still recorded, without a charge.
      if (error instanceof AiProviderError && error.billedResponse) {
        await this.recordUsage(data, error.billedResponse, false).catch(
          (recordError: unknown) =>
            this.logger.warn('AI usage of a failed request was not recorded', {
              context: 'MakeupProcessor',
              runId: data.runId,
              errorType:
                recordError instanceof Error ? recordError.name : 'unknown',
            }),
        );
      }
      const propagatedError = await this.handleFailure(job, error, startedAt);
      throw propagatedError;
    }
  }

  /**
   * The job's last attempt was interrupted (the worker stopped) or its
   * payload was unreadable: fail the run at once, like the recovery sweep
   * does for runs whose job is gone. The job ID is the run ID.
   */
  async onAbandoned(job: AbandonedJob<MakeupAiJob>): Promise<void> {
    await failRun(
      this.prisma,
      job.data?.runId ?? job.id,
      INTERRUPTED_RUN_MESSAGE,
    );
  }

  private async personalize(data: RunContext, startedAt: number) {
    const session = await this.prisma.makeupSession.findFirstOrThrow({
      where: { id: data.sessionId, authId: data.authId },
      include: {
        preferences: true,
        images: {
          where: { purpose: 'INITIAL_ANALYSIS' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (!session.preferences || !session.images[0]) {
      throw new Error('Preferences or initial image are missing');
    }
    const response = await this.ai.personalize({
      image: await this.loadImage(data.authId, session.images[0].id),
      preferences: {
        vibe: session.preferences.vibe,
        skillLevel: session.preferences.skillLevel,
        occasion: session.preferences.occasion,
        desiredEffect: session.preferences.desiredEffect,
        timeMinutes: session.preferences.timeMinutes,
        notes: session.preferences.notes,
      },
    });
    const result = response.data;
    await this.publish(
      data,
      startedAt,
      response.metadata,
      result,
      async (tx) => {
        await tx.faceAnalysis.upsert({
          where: { sessionId: data.sessionId },
          create: { sessionId: data.sessionId, ...result.analysis },
          update: result.analysis,
        });
        await tx.recommendation.deleteMany({
          where: { sessionId: data.sessionId },
        });
        await tx.recommendation.createMany({
          data: result.recommendations.map((item) => ({
            sessionId: data.sessionId,
            rank: item.rank,
            name: item.name,
            tagline: item.tagline,
            matchScore: item.matchScore,
            imageUrl: item.imageUrl,
            palette: item.palette,
            rationale: item.rationale,
          })),
        });
        await tx.makeupSession.update({
          where: { id: data.sessionId },
          data: { status: 'RECOMMENDATIONS_READY' },
        });
      },
    );
  }

  private async generateGuide(data: RunContext, startedAt: number) {
    const session = await this.prisma.makeupSession.findFirstOrThrow({
      where: { id: data.sessionId, authId: data.authId },
      include: {
        preferences: true,
        faceAnalysis: true,
        recommendations: true,
      },
    });
    const selected = session.recommendations.find(
      (item) => item.selectedAt !== null,
    );
    if (!selected || !session.preferences) {
      throw new Error('Selected recommendation or preferences are missing');
    }
    const response = await this.ai.generateGuide({
      recommendation: this.toRecommendation(selected),
      preferences: {
        vibe: session.preferences.vibe,
        skillLevel: session.preferences.skillLevel,
        occasion: session.preferences.occasion,
        desiredEffect: session.preferences.desiredEffect,
        timeMinutes: session.preferences.timeMinutes,
        notes: session.preferences.notes,
      },
      analysis: session.faceAnalysis
        ? {
            faceShape: session.faceAnalysis.faceShape,
            skinTone: session.faceAnalysis.skinTone,
            undertone: session.faceAnalysis.undertone,
            notableFeatures: session.faceAnalysis.notableFeatures,
            confidence: session.faceAnalysis.confidence,
          }
        : null,
    });
    const result = response.data;
    await this.publish(
      data,
      startedAt,
      response.metadata,
      result,
      async (tx) => {
        const existing = await tx.guide.findUnique({
          where: { sessionId: data.sessionId },
        });
        if (existing) await tx.guide.delete({ where: { id: existing.id } });
        await tx.guide.create({
          data: {
            sessionId: data.sessionId,
            recommendationId: selected.id,
            status: 'READY',
            steps: {
              create: result.steps.map((step) => ({
                ...step,
                status: step.position === 0 ? 'CURRENT' : 'LOCKED',
              })),
            },
          },
        });
        await tx.makeupSession.update({
          where: { id: data.sessionId },
          data: { status: 'GUIDE_READY' },
        });
      },
    );
  }

  private async evaluateStep(data: RunContext, startedAt: number) {
    if (!data.stepId || !data.imageId) {
      throw new Error('Guide step or progress image is missing');
    }
    const step = await this.prisma.guideStep.findFirstOrThrow({
      where: { id: data.stepId, guide: { session: { authId: data.authId } } },
      include: {
        attempts: { orderBy: { createdAt: 'desc' }, take: 1 },
        guide: {
          include: {
            recommendation: true,
            session: { include: { preferences: true } },
          },
        },
      },
    });
    const previous = step.attempts[0];
    const response = await this.ai.evaluateStep({
      image: await this.loadImage(data.authId, data.imageId),
      step: this.toGuideStep(step),
      recommendation: {
        name: step.guide.recommendation.name,
        tagline: step.guide.recommendation.tagline,
      },
      preferences: {
        vibe: step.guide.session.preferences?.vibe ?? 'unspecified',
        desiredEffect: step.guide.session.preferences?.desiredEffect ?? null,
      },
      previousEvaluation: previous
        ? {
            result: previous.result,
            feedback: previous.feedback,
            confidence: previous.confidence,
          }
        : null,
    });
    const result = response.data;
    await this.publish(
      data,
      startedAt,
      response.metadata,
      result,
      async (tx) => {
        await tx.stepAttempt.create({
          data: { stepId: step.id, imageId: data.imageId, ...result },
        });
      },
    );
  }

  private async answerQuestion(data: RunContext, startedAt: number) {
    if (!data.stepId || !data.question) {
      throw new Error('Guide step or question is missing');
    }
    const question = data.question;
    const step = await this.prisma.guideStep.findFirstOrThrow({
      where: { id: data.stepId, guide: { session: { authId: data.authId } } },
      include: {
        attempts: {
          where: { imageId: { not: null } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        guide: {
          include: {
            recommendation: true,
            session: { include: { preferences: true } },
          },
        },
      },
    });
    const latestImageId = step.attempts[0]?.imageId;
    const response = await this.ai.answerQuestion({
      question,
      step: this.toGuideStep(step),
      recommendation: {
        name: step.guide.recommendation.name,
        tagline: step.guide.recommendation.tagline,
      },
      preferences: {
        vibe: step.guide.session.preferences?.vibe ?? 'unspecified',
        desiredEffect: step.guide.session.preferences?.desiredEffect ?? null,
      },
      image: latestImageId
        ? await this.loadImage(data.authId, latestImageId)
        : undefined,
    });
    const result = response.data;
    await this.publish(
      data,
      startedAt,
      response.metadata,
      result,
      async (tx) => {
        await tx.question.create({
          data: {
            stepId: step.id,
            question,
            answer: result.answer,
          },
        });
      },
    );
  }

  /**
   * Loads the original private image through the same owner-scoped path as
   * `GET /v1/images/:id/content` (storage provider + stored key, verified
   * type). Failures keep the job's retry semantics: missing or unusable
   * images fail the run immediately, transient storage outages use the
   * normal retry budget. Messages are safe to persist on the run and show to
   * the user; they never name the storage provider, bucket or key.
   */
  private async loadImage(
    authId: string,
    imageId: string,
  ): Promise<AiImageInput> {
    try {
      return await loadOwnedPrivateImage(
        this.prisma,
        this.imageStorage,
        authId,
        imageId,
      );
    } catch (error) {
      if (
        error instanceof PrivateImageUnavailableError ||
        isMissingPrivateObject(error)
      ) {
        throw new AiProviderError(
          'IMAGE_NOT_FOUND',
          'The photo for this request is no longer available. Please upload it again.',
          false,
        );
      }
      if (!isPrivateStorageError(error)) {
        // E.g. the database is unreachable. Retry within the job budget, and
        // never persist the raw error text (it can name internal hosts) on a
        // run that the client can read.
        this.logger.warn('Private image could not be loaded; will retry', {
          context: 'MakeupProcessor',
          errorType: error instanceof Error ? error.name : typeof error,
          errorCode: errorCodeOf(error),
        });
        throw new AiProviderError(
          'IMAGE_LOAD_FAILED',
          'Your photo could not be loaded right now. Please try again.',
          true,
        );
      }
      throw new AiProviderError(
        error.retryable ? 'IMAGE_STORAGE_UNAVAILABLE' : 'IMAGE_STORAGE_FAILED',
        'Your photo could not be loaded right now. Please try again.',
        error.retryable,
      );
    }
  }

  private toGuideStep(step: GuideStepResult): GuideStepResult {
    return {
      position: step.position,
      title: step.title,
      instruction: step.instruction,
      substeps: step.substeps,
      area: step.area,
      technique: step.technique,
      estimatedSeconds: step.estimatedSeconds,
      personalizedTip: step.personalizedTip,
      commonMistake: step.commonMistake,
      successCriteria: step.successCriteria,
    };
  }

  private toRecommendation(recommendation: {
    rank: number;
    name: string;
    tagline: string;
    matchScore: number;
    imageUrl: string;
    palette: Prisma.JsonValue;
    rationale: string;
  }): RecommendationResult {
    const palette = Array.isArray(recommendation.palette)
      ? recommendation.palette.filter(
          (item): item is string => typeof item === 'string',
        )
      : [];
    return { ...recommendation, palette };
  }

  /**
   * Publishes a run's result: records the request's usage, then writes the
   * result, charges the usage and completes the run in one transaction, so
   * a result is never published without its charge and never charged
   * without being published. A result that cannot be published (the run was
   * superseded or recovered) is not charged. Costs exceeding the credits and
   * session overage fail the run with "Insufficient credits".
   */
  private async publish(
    data: RunContext,
    startedAt: number,
    metadata: AiCallMetadata | undefined,
    result: object,
    write: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    const usage = await this.recordUsage(data, metadata, true);
    try {
      await this.prisma.$transaction(async (tx) => {
        if (!(await canPublishRun(tx, data, startedAt))) return;
        await write(tx);
        if (usage) {
          await this.credits.chargeInTransaction(tx, usage.id);
          // Any other pending usage of this run (earlier attempts) is closed.
          await this.credits.closePendingForRun(tx, data.runId);
        }
        await this.completeRun(tx, data.runId, result, startedAt, metadata);
      });
    } catch (error) {
      if (usage && error instanceof InsufficientCreditsError) {
        await this.credits.close(usage.id, 'INSUFFICIENT_CREDITS');
        throw new AiProviderError(
          'INSUFFICIENT_CREDITS',
          INSUFFICIENT_CREDITS_MESSAGE,
          false,
        );
      }
      throw error;
    } finally {
      // Not charged (not published, or the transaction failed): close it.
      if (usage) await this.credits.close(usage.id);
    }
  }

  /** Records a billable provider request of this run (null when free). */
  private async recordUsage(
    data: RunContext,
    metadata: AiCallMetadata | undefined,
    succeeded: boolean,
  ) {
    if (!data.billable) return null;
    return this.credits.recordUsage(
      {
        authId: data.authId,
        sessionId: data.sessionId,
        aiRunId: data.runId,
        operation: data.operation,
        attempt: data.attempt,
      },
      {
        provider: data.provider,
        model: metadata?.model,
        providerRequestId: metadata?.responseId,
        succeeded,
        inputTokens: metadata?.usage?.promptTokens,
        outputTokens: metadata?.usage?.completionTokens,
        totalTokens: metadata?.usage?.totalTokens,
        costUsd: metadata?.usage?.costUsd,
      },
    );
  }

  private async completeRun(
    tx: Prisma.TransactionClient,
    runId: string,
    result: object,
    startedAt: number,
    metadata?: AiCallMetadata,
  ) {
    await tx.aiRun.update({
      where: { id: runId },
      data: {
        status: 'COMPLETED',
        progress: 100,
        result: result as Prisma.InputJsonValue,
        providerResponseId: metadata?.responseId,
        model: metadata?.model,
        usage: metadata?.usage as Prisma.InputJsonValue | undefined,
        latencyMs: Date.now() - startedAt,
        completedAt: new Date(),
      },
    });
  }

  private async handleFailure(
    job: JobExecution<MakeupAiJob>,
    error: unknown,
    startedAt: number,
  ): Promise<Error> {
    let handledError = error;
    if (
      error instanceof AiProviderError &&
      error.code === 'AI_HTTP_429' &&
      error.retryAfterMs !== undefined
    ) {
      const maxPauseMs = this.positiveInteger(
        'AI_QUEUE_MAX_PROVIDER_PAUSE_MS',
        120_000,
      );
      const maxDeferrals = this.positiveInteger(
        'AI_QUEUE_MAX_RATE_LIMIT_DEFERRALS',
        2,
      );
      const deferrals = job.data.rateLimitDeferrals ?? 0;
      if (error.retryAfterMs <= maxPauseMs && deferrals < maxDeferrals) {
        await job.updateData({
          ...job.data,
          rateLimitDeferrals: deferrals + 1,
        });
        const postponed = await job.rateLimit(error.retryAfterMs);
        await this.prisma.aiRun.updateMany({
          where: {
            id: job.data.runId,
            status: 'PROCESSING',
            startedAt: new Date(startedAt),
          },
          data: { status: 'QUEUED', progress: 0, error: null, startedAt: null },
        });
        this.logger.warn(
          'OpenRouter briefly rate limited the makeup AI queue',
          {
            context: 'MakeupProcessor',
            runId: job.data.runId,
            operation: job.name,
            retryAfterMs: error.retryAfterMs,
            deferral: deferrals + 1,
          },
        );
        return postponed;
      }
      handledError = new AiProviderError(
        'AI_CAPACITY_UNAVAILABLE',
        `AI capacity is unavailable right now. Please try again after ${new Date(
          Date.now() + error.retryAfterMs,
        ).toISOString()}.`,
        false,
        error.retryAfterMs,
      );
    }
    const message =
      handledError instanceof Error
        ? handledError.message
        : 'Unknown AI failure';
    const retryable = isRetryableAiError(handledError);
    const maxAttempts = job.maxAttempts;
    const finalAttempt = !retryable || job.attemptsMade + 1 >= maxAttempts;

    if (!retryable) job.discard();
    if (!finalAttempt) {
      await this.prisma.aiRun.updateMany({
        where: {
          id: job.data.runId,
          status: 'PROCESSING',
          startedAt: new Date(startedAt),
        },
        data: { status: 'QUEUED', progress: 0, error: null, startedAt: null },
      });
      this.logger.warn('Makeup AI job will retry', {
        context: 'MakeupProcessor',
        runId: job.data.runId,
        operation: job.name,
        attempt: job.attemptsMade + 1,
        code:
          handledError instanceof AiProviderError
            ? handledError.code
            : undefined,
        diagnostics:
          handledError instanceof AiProviderError
            ? handledError.diagnostics
            : undefined,
      });
      return error instanceof Error ? error : new Error(message);
    }

    await failRun(
      this.prisma,
      job.data.runId,
      message,
      undefined,
      new Date(startedAt),
    );
    this.logger.error('Makeup AI job failed', {
      context: 'MakeupProcessor',
      runId: job.data.runId,
      operation: job.name,
      error: message,
      code:
        handledError instanceof AiProviderError ? handledError.code : undefined,
      diagnostics:
        handledError instanceof AiProviderError
          ? handledError.diagnostics
          : undefined,
    });
    return handledError instanceof Error ? handledError : new Error(message);
  }

  private positiveInteger(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
}
