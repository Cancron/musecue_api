import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Job, Worker } from 'bullmq';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../../common/services/prisma.service';
import { PrivateImageStorageService } from '../../storage/private-image-storage.service';
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
import type { MakeupAiJob } from './makeup.queue';

@Processor('makeup-ai', {
  concurrency: 8,
  limiter: { max: 1_000_000, duration: 1_000 },
})
export class MakeupProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(AI_GATEWAY) private readonly ai: AiGateway,
    private readonly imageStorage: PrivateImageStorageService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<MakeupAiJob>): Promise<void> {
    const startedAt = Date.now();
    const existingRun = await this.prisma.aiRun.findUnique({
      where: { id: job.data.runId },
      select: { status: true },
    });
    if (existingRun?.status === 'COMPLETED') return;
    const descriptor = this.ai.describe(job.name as AiOperation);
    await this.prisma.aiRun.update({
      where: { id: job.data.runId },
      data: {
        status: 'PROCESSING',
        progress: 20,
        startedAt: new Date(),
        provider: descriptor.provider,
        model: descriptor.model,
        promptVersion: descriptor.promptVersion,
        error: null,
      },
    });

    try {
      switch (job.name) {
        case 'PERSONALIZATION':
          await this.personalize(job.data, startedAt);
          break;
        case 'GUIDE_GENERATION':
          await this.generateGuide(job.data, startedAt);
          break;
        case 'VISION_CHECK':
          await this.evaluateStep(job.data, startedAt);
          break;
        case 'GUIDE_QUESTION':
          await this.answerQuestion(job.data, startedAt);
          break;
        default:
          throw new Error(`Unsupported makeup job: ${job.name}`);
      }
    } catch (error) {
      const propagatedError = await this.handleFailure(job, error, startedAt);
      throw propagatedError;
    }
  }

  private async personalize(data: MakeupAiJob, startedAt: number) {
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
    await this.prisma.$transaction(async (tx) => {
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
      await this.completeRun(
        tx,
        data.runId,
        result,
        startedAt,
        response.metadata,
      );
    });
  }

  private async generateGuide(data: MakeupAiJob, startedAt: number) {
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
    await this.prisma.$transaction(async (tx) => {
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
      await this.completeRun(
        tx,
        data.runId,
        result,
        startedAt,
        response.metadata,
      );
    });
  }

  private async evaluateStep(data: MakeupAiJob, startedAt: number) {
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
    await this.prisma.$transaction(async (tx) => {
      await tx.stepAttempt.create({
        data: { stepId: step.id, imageId: data.imageId, ...result },
      });
      await this.completeRun(
        tx,
        data.runId,
        result,
        startedAt,
        response.metadata,
      );
    });
  }

  private async answerQuestion(data: MakeupAiJob, startedAt: number) {
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
    await this.prisma.$transaction(async (tx) => {
      await tx.question.create({
        data: {
          stepId: step.id,
          question,
          answer: result.answer,
        },
      });
      await this.completeRun(
        tx,
        data.runId,
        result,
        startedAt,
        response.metadata,
      );
    });
  }

  private async loadImage(
    authId: string,
    imageId: string,
  ): Promise<AiImageInput> {
    const image = await this.prisma.imageAsset.findFirstOrThrow({
      where: { id: imageId, session: { authId } },
      select: { storageKey: true, mimeType: true },
    });
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType)) {
      throw new Error('Stored image has an unsupported media type');
    }
    return {
      bytes: await this.imageStorage.read(image.storageKey),
      mimeType: image.mimeType as AiImageInput['mimeType'],
    };
  }

  private toGuideStep(step: GuideStepResult): GuideStepResult {
    return {
      position: step.position,
      title: step.title,
      instruction: step.instruction,
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
    job: Job<MakeupAiJob>,
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
        await this.worker.rateLimit(error.retryAfterMs);
        await this.prisma.aiRun.update({
          where: { id: job.data.runId },
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
        return Worker.RateLimitError();
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
    const maxAttempts = job.opts.attempts ?? 1;
    const finalAttempt = !retryable || job.attemptsMade + 1 >= maxAttempts;

    if (!retryable) job.discard();
    if (!finalAttempt) {
      await this.prisma.aiRun.update({
        where: { id: job.data.runId },
        data: { status: 'QUEUED', progress: 0, error: null, startedAt: null },
      });
      this.logger.warn('Makeup AI job will retry', {
        context: 'MakeupProcessor',
        runId: job.data.runId,
        operation: job.name,
        attempt: job.attemptsMade + 1,
      });
      return error instanceof Error ? error : new Error(message);
    }

    await this.prisma.$transaction([
      this.prisma.aiRun.update({
        where: { id: job.data.runId },
        data: {
          status: 'FAILED',
          error: message,
          progress: 100,
          latencyMs: Date.now() - startedAt,
          completedAt: new Date(),
        },
      }),
      ...(job.name === 'PERSONALIZATION'
        ? [
            this.prisma.makeupSession.update({
              where: { id: job.data.sessionId },
              data: { status: 'ANALYSIS_FAILED' as const },
            }),
          ]
        : job.name === 'GUIDE_GENERATION'
          ? [
              this.prisma.makeupSession.update({
                where: { id: job.data.sessionId },
                data: { status: 'GUIDE_FAILED' as const },
              }),
            ]
          : []),
    ]);
    this.logger.error('Makeup AI job failed', {
      context: 'MakeupProcessor',
      runId: job.data.runId,
      operation: job.name,
      error: message,
    });
    return handledError instanceof Error ? handledError : new Error(message);
  }

  private positiveInteger(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
}
