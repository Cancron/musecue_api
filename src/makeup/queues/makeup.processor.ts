import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../../common/services/prisma.service';
import { MockAiGateway } from '../ai/mock-ai.gateway';
import type { MakeupAiJob } from './makeup.queue';

@Processor('makeup-ai')
export class MakeupProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mockAi: MockAiGateway,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {
    super();
  }

  async process(job: Job<MakeupAiJob>): Promise<void> {
    const startedAt = Date.now();
    await this.prisma.aiRun.update({
      where: { id: job.data.runId },
      data: { status: 'PROCESSING', progress: 20, startedAt: new Date() },
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
      const message =
        error instanceof Error ? error.message : 'Unknown makeup job failure';
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
      throw error;
    }
  }

  private async personalize(
    data: MakeupAiJob,
    startedAt: number,
  ): Promise<void> {
    const session = await this.prisma.makeupSession.findFirstOrThrow({
      where: { id: data.sessionId, authId: data.authId },
      include: { preferences: true },
    });
    if (!session.preferences) throw new Error('Preferences are missing');
    const result = this.mockAi.personalize(session.preferences.vibe);
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
      await tx.aiRun.update({
        where: { id: data.runId },
        data: {
          status: 'COMPLETED',
          progress: 100,
          result: result as unknown as Prisma.InputJsonValue,
          latencyMs: Date.now() - startedAt,
          completedAt: new Date(),
        },
      });
    });
  }

  private async generateGuide(
    data: MakeupAiJob,
    startedAt: number,
  ): Promise<void> {
    const session = await this.prisma.makeupSession.findFirstOrThrow({
      where: { id: data.sessionId, authId: data.authId },
      include: { preferences: true, recommendations: true },
    });
    const selected = session.recommendations.find(
      (item) => item.selectedAt !== null,
    );
    if (!selected || !session.preferences)
      throw new Error('Selected recommendation or preferences are missing');
    const result = this.mockAi.generateGuide(
      selected.name,
      session.preferences.timeMinutes,
    );
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
      await tx.aiRun.update({
        where: { id: data.runId },
        data: {
          status: 'COMPLETED',
          progress: 100,
          result: result as unknown as Prisma.InputJsonValue,
          latencyMs: Date.now() - startedAt,
          completedAt: new Date(),
        },
      });
    });
  }

  private async evaluateStep(
    data: MakeupAiJob,
    startedAt: number,
  ): Promise<void> {
    if (!data.stepId || !data.imageId)
      throw new Error('Guide step or progress image is missing');
    const step = await this.prisma.guideStep.findFirstOrThrow({
      where: { id: data.stepId, guide: { session: { authId: data.authId } } },
    });
    const result = this.mockAi.evaluateStep(step.position);
    await this.prisma.$transaction([
      this.prisma.stepAttempt.create({
        data: { stepId: step.id, imageId: data.imageId, ...result },
      }),
      this.prisma.aiRun.update({
        where: { id: data.runId },
        data: {
          status: 'COMPLETED',
          progress: 100,
          result: result as unknown as Prisma.InputJsonValue,
          latencyMs: Date.now() - startedAt,
          completedAt: new Date(),
        },
      }),
    ]);
  }

  private async answerQuestion(
    data: MakeupAiJob,
    startedAt: number,
  ): Promise<void> {
    if (!data.stepId || !data.question)
      throw new Error('Guide step or question is missing');
    const step = await this.prisma.guideStep.findFirstOrThrow({
      where: { id: data.stepId, guide: { session: { authId: data.authId } } },
    });
    const result = this.mockAi.answerQuestion(data.question, step.title);
    await this.prisma.$transaction([
      this.prisma.question.create({
        data: {
          stepId: step.id,
          question: data.question,
          answer: result.answer,
        },
      }),
      this.prisma.aiRun.update({
        where: { id: data.runId },
        data: {
          status: 'COMPLETED',
          progress: 100,
          result: result as unknown as Prisma.InputJsonValue,
          latencyMs: Date.now() - startedAt,
          completedAt: new Date(),
        },
      }),
    ]);
  }
}
