import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type AiRun } from '@prisma/client';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import { PrivateImageStorageService } from '../storage/private-image-storage.service';
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
import { failRun } from './queues/run-lifecycle';

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

@Injectable()
export class MakeupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: MakeupQueueService,
    private readonly imageValidation: ImageValidationService,
    private readonly imageStorage: PrivateImageStorageService,
    @Inject(AI_GATEWAY) private readonly aiGateway: AiGateway,
  ) {}

  createSession(authId: string) {
    return this.prisma.makeupSession.create({
      data: { authId },
      include: SESSION_INCLUDE,
    });
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
      select: {
        id: true,
        status: true,
        images: { select: { storageKey: true } },
      },
    });
    if (!session) throw AppError.notFound('Makeup session not found');
    if (session.status !== 'COMPLETED') {
      throw AppError.conflict(
        'Only completed sessions can be deleted from history',
      );
    }

    const deletion = await this.prisma.makeupSession.deleteMany({
      where: { id: sessionId, authId, status: 'COMPLETED' },
    });
    if (deletion.count !== 1) {
      throw AppError.conflict('The session changed and could not be deleted');
    }

    await Promise.allSettled(
      session.images.map((image) => this.imageStorage.delete(image.storageKey)),
    );
    return { id: sessionId };
  }

  async getImageContent(authId: string, imageId: string) {
    const image = await this.prisma.imageAsset.findFirst({
      where: { id: imageId, session: { authId } },
      select: { storageKey: true, mimeType: true, source: true },
    });
    if (!image) throw AppError.notFound('Image not found');
    if (image.source !== 'PRIVATE_UPLOAD') {
      throw AppError.notFound('Image content is unavailable');
    }

    try {
      return {
        mimeType: image.mimeType,
        bytes: await this.imageStorage.read(image.storageKey),
      };
    } catch {
      throw AppError.notFound('Image content is unavailable');
    }
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
    let replacedImages: Array<{ storageKey: string }> = [];
    const storageKey = await this.imageStorage.save(
      authId,
      sessionId,
      image.mimeType,
      file.buffer,
    );

    try {
      await this.prisma.$transaction(async (tx) => {
        requireSessionStatus(await lockSession(tx, authId, sessionId), [
          'CREATED',
          'IMAGE_UPLOADED',
        ]);
        replacedImages = await tx.imageAsset.findMany({
          where: { sessionId, purpose: 'INITIAL_ANALYSIS' },
          select: { storageKey: true },
        });
        await tx.imageAsset.deleteMany({
          where: { sessionId, purpose: 'INITIAL_ANALYSIS' },
        });
        await tx.imageAsset.create({
          data: {
            sessionId,
            purpose: 'INITIAL_ANALYSIS',
            source: 'PRIVATE_UPLOAD',
            storageKey,
            ...image,
          },
        });
        await tx.makeupSession.update({
          where: { id: sessionId },
          data: { status: 'IMAGE_UPLOADED' },
        });
      });
    } catch (error) {
      await this.imageStorage.delete(storageKey);
      throw error;
    }

    await Promise.all(
      replacedImages.map((imageAsset) =>
        this.imageStorage.delete(imageAsset.storageKey),
      ),
    );
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
    const storageKey = await this.imageStorage.save(
      authId,
      step.guide.sessionId,
      image.mimeType,
      file.buffer,
    );

    let imageAssetId: string | null = null;
    try {
      const imageAsset = await this.prisma.imageAsset.create({
        data: {
          sessionId: step.guide.sessionId,
          purpose: 'STEP_CHECK',
          source: 'PRIVATE_UPLOAD',
          storageKey,
          ...image,
        },
      });
      imageAssetId = imageAsset.id;
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
        await Promise.allSettled([
          this.prisma.imageAsset.delete({ where: { id: imageAsset.id } }),
          this.imageStorage.delete(storageKey),
        ]);
      }
      return runResult.run;
    } catch (error) {
      if (imageAssetId) {
        await this.prisma.imageAsset.deleteMany({
          where: { id: imageAssetId },
        });
      }
      await this.imageStorage.delete(storageKey);
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
    const storageKey = await this.imageStorage.save(
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
            storageKey,
            ...image,
          },
        });
      });
    } catch (error) {
      await this.imageStorage.delete(storageKey);
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
  ): Promise<{ run: AiRun; created: boolean }> {
    const existing = await this.prisma.aiRun.findUnique({
      where: { authId_idempotencyKey: { authId, idempotencyKey } },
    });
    if (existing) {
      this.assertRunAction(existing, sessionId, operation, stepId);
      return { run: existing, created: false };
    }
    const descriptor = this.aiGateway.describe(operation);
    let run: AiRun;
    let created = false;
    try {
      run = await this.prisma.$transaction(async (tx) => {
        const status = await lockSession(tx, authId, sessionId);
        const duplicate = await tx.aiRun.findUnique({
          where: { authId_idempotencyKey: { authId, idempotencyKey } },
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
          },
        });
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        const concurrentRun = await this.prisma.aiRun.findUnique({
          where: { authId_idempotencyKey: { authId, idempotencyKey } },
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
    run: AiRun,
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
