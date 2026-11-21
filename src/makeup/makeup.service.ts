import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type AiRun } from '@prisma/client';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import { PrivateImageLifecycleService } from '../storage/private-image-lifecycle.service';
import {
  PrivateImageStorageService,
  type PrivateObjectRef,
  type SupportedImageMime,
} from '../storage/private-image-storage.service';
import { toImageStorageHttpError } from '../storage/private-storage-http';
import { issueSignedImageUrl } from '../storage/signed-image-url';
import {
  PrivateImageUnavailableError,
  loadOwnedPrivateImage,
  type PrivateImageContent,
} from './private-image-content';
import type {
  AskQuestionDto,
  CompleteStepDto,
  ListSessionsDto,
  SavePreferencesDto,
} from './dto/makeup.dto';
import { MakeupQueueService } from './queues/makeup.queue';
import { ImageValidationService } from './services/image-validation.service';
import { AI_GATEWAY, type AiGateway } from './ai/ai.gateway';
import type { AiOperation } from './interfaces/makeup.interface';
import { lockSession, requireSessionStatus } from './workflow-lock';
import { failRun, toRunJobInput } from './queues/run-lifecycle';
import { MakeupCreditService } from './makeup-credit.service';

/**
 * Transactions that initialize or check a session's credits wait for the
 * user's wallet lock; other requests of the same user may hold it briefly.
 */
const CREDIT_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

/** Columns of an AI run that are never returned by the API. */
const RUN_OMIT = { jobInput: true } as const satisfies Prisma.AiRunOmit;
/** An AI run as returned by the API. */
type AiRunView = Omit<AiRun, keyof typeof RUN_OMIT>;

const SESSION_INCLUDE = {
  images: {
    orderBy: { createdAt: 'desc' as const },
    select: {
      id: true,
      guideStepId: true,
      purpose: true,
      source: true,
      mimeType: true,
      width: true,
      height: true,
      sizeBytes: true,
      createdAt: true,
    },
  },
  preferences: true,
  faceAnalysis: true,
  recommendations: { orderBy: { rank: 'asc' as const } },
  guide: {
    include: {
      recommendation: true,
      steps: {
        orderBy: { position: 'asc' as const },
        include: {
          attempts: { orderBy: { createdAt: 'desc' as const } },
          questions: { orderBy: { createdAt: 'asc' as const } },
        },
      },
    },
  },
} satisfies Prisma.MakeupSessionInclude;

function storedObject(image: {
  storageKey: string;
  storageProvider: string;
}): PrivateObjectRef {
  return { provider: image.storageProvider, key: image.storageKey };
}

@Injectable()
export class MakeupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: MakeupQueueService,
    private readonly imageValidation: ImageValidationService,
    private readonly imageStorage: PrivateImageStorageService,
    private readonly imageLifecycle: PrivateImageLifecycleService,
    @Inject(AI_GATEWAY) private readonly aiGateway: AiGateway,
    private readonly credits: MakeupCreditService,
  ) {}

  /**
   * Creates a session and, in the same transaction under the user's wallet
   * lock, initializes it with free credits (reserving up to one credit and
   * fixing its overage allowance). Without free credits nothing is created:
   * 403 "Insufficient credits". Concurrent requests are applied one at a
   * time, so one credit never initializes two sessions.
   */
  async createSession(authId: string) {
    const sources = await this.credits.usableSources(authId);
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.makeupSession.create({
        data: { authId },
        select: { id: true },
      });
      await this.credits.initializeSession(tx, authId, session.id, sources);
      return tx.makeupSession.findUniqueOrThrow({
        where: { id: session.id },
        include: SESSION_INCLUDE,
      });
    }, CREDIT_TRANSACTION_OPTIONS);
  }

  async listSessions(authId: string, query: ListSessionsDto) {
    const status = query.scope === 'completed' ? 'COMPLETED' : undefined;
    const activeStatuses = [
      'CREATED',
      'IMAGE_UPLOADED',
      'ANALYZING',
      'RECOMMENDATIONS_READY',
      'METHOD_SELECTED',
      'GUIDE_GENERATING',
      'GUIDE_READY',
      'IN_PROGRESS',
    ] as const;
    return this.prisma.makeupSession.findMany({
      where: {
        authId,
        ...(status
          ? { status }
          : query.scope === 'active'
            ? { status: { in: [...activeStatuses] } }
            : {}),
      },
      include: SESSION_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getSession(authId: string, sessionId: string) {
    const session = await this.prisma.makeupSession.findFirst({
      where: { id: sessionId, authId },
      include: SESSION_INCLUDE,
    });
    if (!session) throw AppError.notFound('Makeup session not found');
    return session;
  }

  async deleteSession(authId: string, sessionId: string) {
    const session = await this.prisma.makeupSession.findFirst({
      where: { id: sessionId, authId },
      select: { id: true, status: true },
    });
    if (!session) throw AppError.notFound('Makeup session not found');
    if (session.status !== 'COMPLETED') {
      throw AppError.conflict(
        'Only completed sessions can be deleted from history',
      );
    }

    // The rows and their pending object deletions commit together, so no
    // private image can lose its last record before it is actually deleted.
    const removed = await this.prisma.$transaction(async (tx) => {
      await lockSession(tx, authId, sessionId);
      const images = await tx.imageAsset.findMany({
        where: { sessionId },
        select: { storageKey: true, storageProvider: true },
      });
      const deletion = await tx.makeupSession.deleteMany({
        where: { id: sessionId, authId, status: 'COMPLETED' },
      });
      if (deletion.count !== 1) {
        throw AppError.conflict('The session changed and could not be deleted');
      }
      return this.imageLifecycle.scheduleDeletion(
        tx,
        images.map(storedObject),
        'SESSION_DELETED',
        authId,
      );
    });

    await this.imageLifecycle.processRefs(removed);
    return { id: sessionId };
  }

  /**
   * The original bytes and stored content type of an owned private image,
   * loaded exactly as the AI worker loads it (`loadOwnedPrivateImage`).
   */
  async getImageContent(
    authId: string,
    imageId: string,
  ): Promise<PrivateImageContent> {
    try {
      return await loadOwnedPrivateImage(
        this.prisma,
        this.imageStorage,
        authId,
        imageId,
      );
    } catch (error) {
      if (error instanceof PrivateImageUnavailableError) {
        throw AppError.notFound(
          error.reason === 'NOT_FOUND'
            ? 'Image not found'
            : 'Image content is unavailable',
        );
      }
      throw toImageStorageHttpError(error, 'Image content is unavailable');
    }
  }

  /**
   * Issues a fresh short-lived read URL for an owned private image. Nothing is
   * stored or cached; clients request a new URL whenever one expires.
   */
  async getImageSignedUrl(authId: string, imageId: string) {
    const image = await this.prisma.imageAsset.findFirst({
      where: { id: imageId, session: { authId } },
      select: { storageKey: true, storageProvider: true, source: true },
    });
    if (!image) throw AppError.notFound('Image not found');
    if (image.source !== 'PRIVATE_UPLOAD') {
      throw AppError.notFound('Image content is unavailable');
    }

    return issueSignedImageUrl(
      this.imageStorage,
      storedObject(image),
      'Image content is unavailable',
    );
  }

  async uploadInitialImage(
    authId: string,
    sessionId: string,
    file?: Express.Multer.File,
  ) {
    const session = await this.getSession(authId, sessionId);
    if (!['CREATED', 'IMAGE_UPLOADED'].includes(session.status)) {
      throw AppError.conflict(
        'The initial image cannot be replaced after analysis starts',
      );
    }
    if (!file) throw AppError.badRequest('An image file is required');

    const image = await this.imageValidation.validate(file);
    const stored = await this.storeImage(
      authId,
      sessionId,
      image.mimeType,
      file.buffer,
    );

    let replaced: PrivateObjectRef[];
    try {
      replaced = await this.prisma.$transaction(async (tx) => {
        requireSessionStatus(await lockSession(tx, authId, sessionId), [
          'CREATED',
          'IMAGE_UPLOADED',
        ]);
        const replacedImages = await tx.imageAsset.findMany({
          where: { sessionId, purpose: 'INITIAL_ANALYSIS' },
          select: { storageKey: true, storageProvider: true },
        });
        await tx.imageAsset.deleteMany({
          where: { sessionId, purpose: 'INITIAL_ANALYSIS' },
        });
        await tx.imageAsset.create({
          data: {
            sessionId,
            purpose: 'INITIAL_ANALYSIS',
            source: 'PRIVATE_UPLOAD',
            storageKey: stored.key,
            storageProvider: stored.provider,
            ...image,
          },
        });
        await this.imageLifecycle.confirmUpload(tx, stored);
        const refs = await this.imageLifecycle.scheduleDeletion(
          tx,
          replacedImages.map(storedObject),
          'IMAGE_REPLACED',
          authId,
        );
        await tx.makeupSession.update({
          where: { id: sessionId },
          data: { status: 'IMAGE_UPLOADED' },
        });
        return refs;
      });
    } catch (error) {
      await this.imageLifecycle.abandonUpload(stored);
      throw error;
    }

    await this.imageLifecycle.processRefs(replaced);
    return this.getSession(authId, sessionId);
  }

  async savePreferences(
    authId: string,
    sessionId: string,
    dto: SavePreferencesDto,
  ) {
    const session = await this.getSession(authId, sessionId);
    if (!['IMAGE_UPLOADED', 'ANALYSIS_FAILED'].includes(session.status)) {
      throw AppError.conflict('Preferences can only be saved before analysis');
    }
    await this.prisma.$transaction(async (tx) => {
      requireSessionStatus(await lockSession(tx, authId, sessionId), [
        'IMAGE_UPLOADED',
        'ANALYSIS_FAILED',
      ]);
      await tx.makeupPreferences.upsert({
        where: { sessionId },
        create: { sessionId, ...dto },
        update: dto,
      });
    });
    return this.getSession(authId, sessionId);
  }

  async startAnalysis(
    authId: string,
    sessionId: string,
    idempotencyKey: string,
  ) {
    const session = await this.getSession(authId, sessionId);
    if (!session.images.length || !session.preferences) {
      throw AppError.badRequest(
        'An image and preferences are required before analysis',
      );
    }
    const { run } = await this.createRun(
      authId,
      sessionId,
      'PERSONALIZATION',
      idempotencyKey,
      undefined,
      undefined,
      'ANALYZING',
    );
    return run;
  }

  async selectRecommendation(
    authId: string,
    sessionId: string,
    recommendationId: string,
    idempotencyKey: string,
  ) {
    const session = await this.getSession(authId, sessionId);
    const recommendation = session.recommendations.find(
      (item) => item.id === recommendationId,
    );
    if (!recommendation) throw AppError.notFound('Recommendation not found');

    const guideAlreadyRequested = [
      'METHOD_SELECTED',
      'GUIDE_GENERATING',
      'GUIDE_READY',
      'IN_PROGRESS',
    ].includes(session.status);
    if (guideAlreadyRequested && recommendation.selectedAt) {
      const existingRun = await this.prisma.aiRun.findFirst({
        omit: RUN_OMIT,
        where: {
          authId,
          sessionId,
          operation: 'GUIDE_GENERATION',
          status: { in: ['QUEUED', 'PROCESSING', 'COMPLETED'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (existingRun) return existingRun;
    }

    if (!['RECOMMENDATIONS_READY', 'GUIDE_FAILED'].includes(session.status)) {
      throw AppError.conflict('Recommendations are not ready for selection');
    }
    const { run } = await this.createRun(
      authId,
      sessionId,
      'GUIDE_GENERATION',
      idempotencyKey,
      undefined,
      undefined,
      'GUIDE_GENERATING',
      undefined,
      recommendationId,
    );
    return run;
  }

  async toggleSaved(authId: string, recommendationId: string, saved?: boolean) {
    const recommendation = await this.prisma.recommendation.findFirst({
      where: { id: recommendationId, session: { authId } },
    });
    if (!recommendation) throw AppError.notFound('Recommendation not found');
    return this.prisma.$transaction(async (tx) => {
      await lockSession(tx, authId, recommendation.sessionId);
      const current = await tx.recommendation.findUniqueOrThrow({
        where: { id: recommendationId },
      });
      const shouldSave = saved ?? !current.savedAt;
      return tx.recommendation.update({
        where: { id: recommendationId },
        data: { savedAt: shouldSave ? (current.savedAt ?? new Date()) : null },
      });
    });
  }

  listSaved(authId: string) {
    return this.prisma.recommendation.findMany({
      where: { session: { authId }, savedAt: { not: null } },
      orderBy: { savedAt: 'desc' },
    });
  }

  async checkStep(
    authId: string,
    stepId: string,
    idempotencyKey: string,
    file?: Express.Multer.File,
  ) {
    const existing = await this.prisma.aiRun.findUnique({
      where: { authId_idempotencyKey: { authId, idempotencyKey } },
      omit: RUN_OMIT,
    });
    if (existing) {
      if (existing.operation !== 'VISION_CHECK' || existing.stepId !== stepId) {
        throw AppError.conflict(
          'Idempotency key was already used for another action',
        );
      }
      return existing;
    }

    const step = await this.getOwnedStep(authId, stepId);
    if (!['CURRENT', 'COMPLETED'].includes(step.status)) {
      throw AppError.conflict('Only the current step can be checked');
    }
    if (!file) throw AppError.badRequest('A current makeup image is required');

    const image = await this.imageValidation.validate(file);
    const stored = await this.storeImage(
      authId,
      step.guide.sessionId,
      image.mimeType,
      file.buffer,
    );

    let imageAsset: { id: string };
    try {
      imageAsset = await this.prisma.$transaction(async (tx) => {
        const created = await tx.imageAsset.create({
          data: {
            sessionId: step.guide.sessionId,
            purpose: 'STEP_CHECK',
            source: 'PRIVATE_UPLOAD',
            storageKey: stored.key,
            storageProvider: stored.provider,
            ...image,
          },
        });
        await this.imageLifecycle.confirmUpload(tx, stored);
        return created;
      });
    } catch (error) {
      await this.imageLifecycle.abandonUpload(stored);
      throw error;
    }

    try {
      const runResult = await this.createRun(
        authId,
        step.guide.sessionId,
        'VISION_CHECK',
        idempotencyKey,
        stepId,
        undefined,
        undefined,
        imageAsset.id,
      );
      if (!runResult.created) {
        await this.discardImage(authId, imageAsset.id, stored);
      }
      return runResult.run;
    } catch (error) {
      await this.discardImage(authId, imageAsset.id, stored);
      throw error;
    }
  }

  async saveStepSnapshot(
    authId: string,
    stepId: string,
    file?: Express.Multer.File,
  ) {
    const step = await this.getOwnedStep(authId, stepId);
    if (step.status !== 'CURRENT') {
      throw AppError.conflict('Only the current step can save a snapshot');
    }
    if (!file) throw AppError.badRequest('A current makeup image is required');

    const image = await this.imageValidation.validate(file);
    const stored = await this.storeImage(
      authId,
      step.guide.sessionId,
      image.mimeType,
      file.buffer,
    );

    try {
      await this.prisma.$transaction(async (tx) => {
        await lockSession(tx, authId, step.guide.sessionId);
        const current = await tx.guideStep.findUnique({
          where: { id: stepId },
          select: { status: true },
        });
        if (current?.status !== 'CURRENT')
          throw AppError.conflict('Only the current step can save a snapshot');
        await tx.imageAsset.create({
          data: {
            sessionId: step.guide.sessionId,
            guideStepId: step.id,
            purpose: 'STEP_CHECK',
            source: 'PRIVATE_UPLOAD',
            storageKey: stored.key,
            storageProvider: stored.provider,
            ...image,
          },
        });
        await this.imageLifecycle.confirmUpload(tx, stored);
      });
    } catch (error) {
      await this.imageLifecycle.abandonUpload(stored);
      throw error;
    }

    return this.getSession(authId, step.guide.sessionId);
  }

  async askQuestion(
    authId: string,
    stepId: string,
    dto: AskQuestionDto,
    idempotencyKey: string,
  ) {
    const step = await this.getOwnedStep(authId, stepId);
    const { run } = await this.createRun(
      authId,
      step.guide.sessionId,
      'GUIDE_QUESTION',
      idempotencyKey,
      stepId,
      dto.question,
    );
    return run;
  }

  async completeStep(authId: string, stepId: string, dto: CompleteStepDto) {
    const owned = await this.getOwnedStep(authId, stepId);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await lockSession(tx, authId, owned.guide.sessionId);
      const step = await tx.guideStep.findUniqueOrThrow({
        where: { id: stepId },
        include: { guide: { include: { steps: true } } },
      });
      if (step.status === 'COMPLETED' || step.status === 'SKIPPED') return;
      if (step.status !== 'CURRENT')
        throw AppError.conflict('Only the current step can be completed');
      const next = step.guide.steps.find(
        (item) => item.position === step.position + 1,
      );
      await tx.guideStep.update({
        where: { id: stepId },
        data: { status: dto.outcome ?? 'COMPLETED', completedAt: now },
      });
      if (next) {
        await tx.guideStep.update({
          where: { id: next.id },
          data: { status: 'CURRENT' },
        });
        await tx.guide.update({
          where: { id: step.guideId },
          data: {
            status: 'IN_PROGRESS',
            currentStepIndex: next.position,
            startedAt: step.guide.startedAt ?? now,
          },
        });
        await tx.makeupSession.update({
          where: { id: step.guide.sessionId },
          data: { status: 'IN_PROGRESS' },
        });
      } else {
        const finalSnapshot = await tx.imageAsset.findFirst({
          where: {
            sessionId: step.guide.sessionId,
            guideStepId: stepId,
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        const finalAttempt = await tx.stepAttempt.findFirst({
          where: { stepId, imageId: { not: null } },
          orderBy: { createdAt: 'desc' },
          select: { imageId: true },
        });
        const finalImageId = finalSnapshot?.id ?? finalAttempt?.imageId;
        if (finalImageId) {
          await tx.imageAsset.updateMany({
            where: {
              id: finalImageId,
              sessionId: step.guide.sessionId,
            },
            data: { purpose: 'COMPLETION' },
          });
        }
        await tx.guide.update({
          where: { id: step.guideId },
          data: { status: 'COMPLETED', completedAt: now },
        });
        await tx.makeupSession.update({
          where: { id: step.guide.sessionId },
          data: { status: 'COMPLETED', completedAt: now },
        });
      }
    });
    return this.getSession(authId, owned.guide.sessionId);
  }

  async getRun(authId: string, runId: string) {
    const run = await this.prisma.aiRun.findFirst({
      where: { id: runId, authId },
      omit: RUN_OMIT,
    });
    if (!run) throw AppError.notFound('AI job not found');
    return run;
  }

  async getStats(authId: string) {
    const [completedSessions, savedLooks, totalSteps] = await Promise.all([
      this.prisma.makeupSession.count({
        where: { authId, status: 'COMPLETED' },
      }),
      this.prisma.recommendation.count({
        where: { session: { authId }, savedAt: { not: null } },
      }),
      this.prisma.guideStep.count({
        where: {
          guide: { session: { authId } },
          status: { in: ['COMPLETED', 'SKIPPED'] },
        },
      }),
    ]);
    return { completedSessions, savedLooks, totalSteps };
  }

  /**
   * Uploads validated bytes under a cleanup reservation; the caller confirms
   * it in the transaction storing the reference. Failures become safe HTTP
   * errors.
   */
  private async storeImage(
    authId: string,
    scopeId: string,
    mimeType: SupportedImageMime,
    bytes: Buffer,
  ): Promise<PrivateObjectRef> {
    try {
      return await this.imageLifecycle.upload(authId, scopeId, mimeType, bytes);
    } catch (error) {
      throw toImageStorageHttpError(error);
    }
  }

  /**
   * Removes an image row that must not be kept and records its object for
   * deletion atomically. If this fails, the row keeps referencing the object,
   * so nothing is orphaned.
   */
  private async discardImage(
    authId: string,
    imageId: string,
    ref: PrivateObjectRef,
  ): Promise<void> {
    let scheduled: PrivateObjectRef[];
    try {
      scheduled = await this.prisma.$transaction(async (tx) => {
        await tx.imageAsset.deleteMany({ where: { id: imageId } });
        return this.imageLifecycle.scheduleDeletion(
          tx,
          [ref],
          'IMAGE_DISCARDED',
          authId,
        );
      });
    } catch {
      return;
    }
    await this.imageLifecycle.processRefs(scheduled);
  }

  private async getOwnedStep(authId: string, stepId: string) {
    const step = await this.prisma.guideStep.findFirst({
      where: { id: stepId, guide: { session: { authId } } },
      include: {
        guide: { include: { steps: { orderBy: { position: 'asc' } } } },
      },
    });
    if (!step) throw AppError.notFound('Guide step not found');
    return step;
  }

  private async createRun(
    authId: string,
    sessionId: string,
    operation: AiOperation,
    idempotencyKey: string,
    stepId?: string,
    question?: string,
    nextStatus?: 'ANALYZING' | 'GUIDE_GENERATING',
    imageId?: string,
    recommendationId?: string,
  ): Promise<{ run: AiRunView; created: boolean }> {
    const existing = await this.prisma.aiRun.findUnique({
      where: { authId_idempotencyKey: { authId, idempotencyKey } },
      omit: RUN_OMIT,
    });
    if (existing) {
      this.assertRunAction(existing, sessionId, operation, stepId);
      return { run: existing, created: false };
    }
    const descriptor = this.aiGateway.describe(operation);
    const sources = await this.credits.usableSources(authId);
    let run: AiRunView;
    let created = false;
    try {
      run = await this.prisma.$transaction(async (tx) => {
        const status = await lockSession(tx, authId, sessionId);
        const duplicate = await tx.aiRun.findUnique({
          where: { authId_idempotencyKey: { authId, idempotencyKey } },
          omit: RUN_OMIT,
        });
        if (duplicate) {
          this.assertRunAction(duplicate, sessionId, operation, stepId);
          return duplicate;
        }
        if (operation === 'PERSONALIZATION')
          requireSessionStatus(status, ['IMAGE_UPLOADED', 'ANALYSIS_FAILED']);
        if (operation === 'GUIDE_GENERATION') {
          requireSessionStatus(status, [
            'RECOMMENDATIONS_READY',
            'GUIDE_FAILED',
          ]);
          const selected = await tx.recommendation.findFirst({
            where: { id: recommendationId, sessionId },
          });
          if (!selected) throw AppError.notFound('Recommendation not found');
          await tx.recommendation.updateMany({
            where: { sessionId },
            data: { selectedAt: null },
          });
          await tx.recommendation.update({
            where: { id: selected.id },
            data: { selectedAt: new Date() },
          });
        }
        if (stepId) {
          const step = await tx.guideStep.findFirst({
            where: { id: stepId, guide: { sessionId } },
            select: { status: true },
          });
          if (!step || !['CURRENT', 'COMPLETED'].includes(step.status))
            throw AppError.conflict('This step is not available for coaching');
        }
        // The session must be able to pay (403 "Insufficient credits"):
        // checked under the wallet lock, so the decision holds for this run.
        await this.credits.prepareAiRequest(tx, authId, sessionId, sources);
        if (nextStatus)
          await tx.makeupSession.update({
            where: { id: sessionId },
            data: { status: nextStatus },
          });
        created = true;
        return tx.aiRun.create({
          data: {
            authId,
            sessionId,
            stepId,
            operation,
            provider: descriptor.provider,
            model: descriptor.model,
            promptVersion: descriptor.promptVersion,
            idempotencyKey,
            // Immutable: the worker reads the operation input from the run.
            jobInput: toRunJobInput({ imageId, question }),
          },
          omit: RUN_OMIT,
        });
      }, CREDIT_TRANSACTION_OPTIONS);
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        const concurrentRun = await this.prisma.aiRun.findUnique({
          where: { authId_idempotencyKey: { authId, idempotencyKey } },
          omit: RUN_OMIT,
        });
        if (concurrentRun) {
          this.assertRunAction(concurrentRun, sessionId, operation, stepId);
          return { run: concurrentRun, created: false };
        }
      }
      throw error;
    }
    if (!created) return { run, created: false };
    try {
      await this.queue.enqueue(operation, {
        runId: run.id,
        authId,
        sessionId,
        stepId,
        imageId,
        question,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to queue makeup processing';
      await failRun(this.prisma, run.id, message);
      throw AppError.serviceUnavailable(
        'Makeup processing is temporarily unavailable',
      );
    }
    return { run, created: true };
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    );
  }

  private assertRunAction(
    run: AiRunView,
    sessionId: string,
    operation: AiOperation,
    stepId?: string,
  ): void {
    if (
      run.sessionId !== sessionId ||
      run.operation !== operation ||
      (run.stepId ?? undefined) !== stepId
    ) {
      throw AppError.conflict(
        'Idempotency key was already used for another action',
      );
    }
  }
}
