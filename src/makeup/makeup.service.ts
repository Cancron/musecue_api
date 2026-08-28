import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import type {
  AskQuestionDto,
  CompleteStepDto,
  ListSessionsDto,
  RegisterMockImageDto,
  SavePreferencesDto,
} from './dto/makeup.dto';
import { MakeupQueueService } from './queues/makeup.queue';

const SESSION_INCLUDE = {
  images: {
    orderBy: { createdAt: 'desc' as const },
    select: {
      id: true,
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
          attempts: { orderBy: { createdAt: 'desc' as const }, take: 1 },
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

  async registerMockImage(
    authId: string,
    sessionId: string,
    dto: RegisterMockImageDto,
  ) {
    const session = await this.getSession(authId, sessionId);
    if (!['CREATED', 'IMAGE_UPLOADED'].includes(session.status)) {
      throw AppError.conflict(
        'The initial image cannot be replaced after analysis starts',
      );
    }
    await this.prisma.$transaction([
      this.prisma.imageAsset.create({
        data: {
          sessionId,
          purpose: 'INITIAL_ANALYSIS',
          source: 'MOCK_CAPTURE',
          storageKey: `mock-capture://${sessionId}`,
          ...dto,
        },
      }),
      this.prisma.makeupSession.update({
        where: { id: sessionId },
        data: { status: 'IMAGE_UPLOADED' },
      }),
    ]);
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
    await this.prisma.makeupPreferences.upsert({
      where: { sessionId },
      create: { sessionId, ...dto },
      update: dto,
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
    if (!['IMAGE_UPLOADED', 'ANALYSIS_FAILED'].includes(session.status)) {
      throw AppError.conflict(
        'This session cannot start analysis from its current state',
      );
    }
    return this.createRun(
      authId,
      sessionId,
      'PERSONALIZATION',
      idempotencyKey,
      undefined,
      undefined,
      'ANALYZING',
    );
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
    await this.prisma.$transaction([
      this.prisma.recommendation.updateMany({
        where: { sessionId },
        data: { selectedAt: null },
      }),
      this.prisma.recommendation.update({
        where: { id: recommendationId },
        data: { selectedAt: new Date() },
      }),
      this.prisma.makeupSession.update({
        where: { id: sessionId },
        data: { status: 'METHOD_SELECTED' },
      }),
    ]);
    return this.createRun(
      authId,
      sessionId,
      'GUIDE_GENERATION',
      idempotencyKey,
      undefined,
      undefined,
      'GUIDE_GENERATING',
    );
  }

  async toggleSaved(authId: string, recommendationId: string) {
    const recommendation = await this.prisma.recommendation.findFirst({
      where: { id: recommendationId, session: { authId } },
    });
    if (!recommendation) throw AppError.notFound('Recommendation not found');
    return this.prisma.recommendation.update({
      where: { id: recommendationId },
      data: { savedAt: recommendation.savedAt ? null : new Date() },
    });
  }

  listSaved(authId: string) {
    return this.prisma.recommendation.findMany({
      where: { session: { authId }, savedAt: { not: null } },
      orderBy: { savedAt: 'desc' },
    });
  }

  async checkStep(authId: string, stepId: string, idempotencyKey: string) {
    const step = await this.getOwnedStep(authId, stepId);
    if (!['CURRENT', 'COMPLETED'].includes(step.status)) {
      throw AppError.conflict('Only the current step can be checked');
    }
    return this.createRun(
      authId,
      step.guide.sessionId,
      'VISION_CHECK',
      idempotencyKey,
      stepId,
    );
  }

  async askQuestion(
    authId: string,
    stepId: string,
    dto: AskQuestionDto,
    idempotencyKey: string,
  ) {
    const step = await this.getOwnedStep(authId, stepId);
    return this.createRun(
      authId,
      step.guide.sessionId,
      'GUIDE_QUESTION',
      idempotencyKey,
      stepId,
      dto.question,
    );
  }

  async completeStep(authId: string, stepId: string, dto: CompleteStepDto) {
    const step = await this.getOwnedStep(authId, stepId);
    if (step.status !== 'CURRENT')
      throw AppError.conflict('Only the current step can be completed');
    const next = step.guide.steps.find(
      (item) => item.position === step.position + 1,
    );
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
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
    return this.getSession(authId, step.guide.sessionId);
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
    operation:
      | 'PERSONALIZATION'
      | 'GUIDE_GENERATION'
      | 'VISION_CHECK'
      | 'GUIDE_QUESTION',
    idempotencyKey: string,
    stepId?: string,
    question?: string,
    nextStatus?: 'ANALYZING' | 'GUIDE_GENERATING',
  ) {
    const existing = await this.prisma.aiRun.findUnique({
      where: { authId_idempotencyKey: { authId, idempotencyKey } },
    });
    if (existing) return existing;
    const run = await this.prisma.$transaction(async (tx) => {
      if (nextStatus)
        await tx.makeupSession.update({
          where: { id: sessionId },
          data: { status: nextStatus },
        });
      return tx.aiRun.create({
        data: {
          authId,
          sessionId,
          stepId,
          operation,
          promptVersion: 'musecue-mock-v1',
          idempotencyKey,
        },
      });
    });
    try {
      await this.queue.enqueue(operation, {
        runId: run.id,
        authId,
        sessionId,
        stepId,
        question,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to queue makeup processing';
      await this.prisma.$transaction([
        this.prisma.aiRun.update({
          where: { id: run.id },
          data: {
            status: 'FAILED',
            progress: 100,
            error: message,
            completedAt: new Date(),
          },
        }),
        ...(operation === 'PERSONALIZATION'
          ? [
              this.prisma.makeupSession.update({
                where: { id: sessionId },
                data: { status: 'ANALYSIS_FAILED' as const },
              }),
            ]
          : operation === 'GUIDE_GENERATION'
            ? [
                this.prisma.makeupSession.update({
                  where: { id: sessionId },
                  data: { status: 'GUIDE_FAILED' as const },
                }),
              ]
            : []),
      ]);
      throw AppError.serviceUnavailable(
        'Makeup processing is temporarily unavailable',
      );
    }
    return run;
  }
}
