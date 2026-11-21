import type { Prisma } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import type { Logger } from 'winston';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/services/prisma.service';
import { PrivateImageStorageService } from '../../storage/private-image-storage.service';
import type { AiGateway } from '../ai/ai.gateway';
import { AiProviderError } from '../ai/ai-provider.error';
import { MockAiGateway } from '../ai/mock-ai.gateway';
import { MakeupJobHandler } from './makeup-job.handler';
import { MakeupCreditService } from '../makeup-credit.service';
import type { JobExecution } from '../../infrastructure/jobs/job.types';
import type { MakeupAiJob } from './makeup.queue';

function workflowPrisma() {
  const prisma = mockDeep<PrismaService>();
  prisma.$queryRaw.mockResolvedValue([{ status: 'GUIDE_GENERATING' }]);
  prisma.aiRun.findUnique.mockResolvedValue({
    id: 'run',
    authId: 'owner',
    sessionId: 'session',
    operation: 'GUIDE_GENERATION',
    status: 'PROCESSING',
    startedAt: new Date(1000),
    createdAt: new Date(0),
  } as never);
  prisma.aiRun.updateMany.mockResolvedValue({ count: 1 });
  prisma.$transaction.mockImplementation(((
    callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => callback(prisma)) as PrismaService['$transaction']);
  return prisma;
}

describe('MakeupJobHandler delivery semantics', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(1000));
  afterEach(() => jest.restoreAllMocks());
  it.each([false, true])(
    'preserves guide failure/retry semantics (retryable=%s) and logs diagnostics',
    async (retryable) => {
      const prisma = workflowPrisma();
      const ai = mock<AiGateway>();
      const logger = mock<Logger>();
      const error = new AiProviderError(
        retryable ? 'AI_HTTP_502' : 'AI_OUTPUT_TRUNCATED',
        'Safe failure message',
        retryable,
      );
      error.diagnostics = {
        maxTokens: 8000,
        finishReason: retryable ? 'error' : 'length',
      };
      ai.describe.mockReturnValue({
        provider: 'openrouter',
        model: 'test',
        promptVersion: 'test',
      });
      ai.generateGuide.mockRejectedValue(error);
      prisma.makeupSession.findFirstOrThrow.mockResolvedValue({
        preferences: {},
        faceAnalysis: null,
        recommendations: [{ id: 'look', selectedAt: new Date(), palette: [] }],
      } as never);
      const processor = new MakeupJobHandler(
        prisma,
        ai,
        mock<PrivateImageStorageService>(),
        logger,
        new ConfigService(),
        mock<MakeupCreditService>(),
      );
      const discard = jest.fn();
      await expect(
        processor.process({
          name: 'GUIDE_GENERATION',
          data: { runId: 'run', authId: 'owner', sessionId: 'session' },
          maxAttempts: 3,
          attemptsMade: 0,
          discard,
        } as unknown as JobExecution<MakeupAiJob>),
      ).rejects.toBe(error);
      expect(discard).toHaveBeenCalledTimes(retryable ? 0 : 1);
      expect(prisma.aiRun.updateMany.mock.calls.at(-1)?.[0].data.status).toBe(
        retryable ? 'QUEUED' : 'FAILED',
      );
      if (!retryable) {
        expect(prisma.makeupSession.updateMany.mock.calls[0]?.[0]).toEqual({
          where: { id: 'session', status: 'GUIDE_GENERATING' },
          data: { status: 'GUIDE_FAILED' },
        });
      }
      expect(retryable ? logger.warn : logger.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          runId: 'run',
          code: error.code,
          diagnostics: error.diagnostics,
        }),
      );
      expect(prisma.guide.create.mock.calls).toHaveLength(0);
    },
  );

  it('persists spoken guide content without changing main-step statuses', async () => {
    const prisma = workflowPrisma();
    const gateway = new MockAiGateway();
    const ai = mock<AiGateway>();
    const preferences = {
      vibe: 'natural',
      skillLevel: null,
      occasion: null,
      desiredEffect: null,
      timeMinutes: 10,
      notes: null,
    };
    const image = {
      bytes: Buffer.from('test'),
      mimeType: 'image/jpeg' as const,
    };
    const personalization = await gateway.personalize({ preferences, image });
    const recommendation = personalization.data.recommendations[0];
    const guide = await gateway.generateGuide({
      preferences,
      recommendation,
      analysis: null,
    });
    ai.describe.mockReturnValue(gateway.describe('GUIDE_GENERATION'));
    ai.generateGuide.mockResolvedValue(guide);
    prisma.makeupSession.findFirstOrThrow.mockResolvedValue({
      preferences,
      recommendations: [
        { ...recommendation, id: 'look', selectedAt: new Date() },
      ],
      faceAnalysis: null,
    } as never);
    prisma.$transaction.mockImplementation(((
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) => callback(prisma)) as PrismaService['$transaction']);
    const processor = new MakeupJobHandler(
      prisma,
      ai,
      mock<PrivateImageStorageService>(),
      mock<Logger>(),
      new ConfigService(),
      mock<MakeupCreditService>(),
    );
    await processor.process({
      name: 'GUIDE_GENERATION',
      data: { runId: 'run', authId: 'owner', sessionId: 'session' },
    } as JobExecution<MakeupAiJob>);
    expect(prisma.guide.create.mock.calls[0]?.[0].data.steps).toEqual({
      create: guide.data.steps.map((step) => ({
        ...step,
        status: step.position === 0 ? 'CURRENT' : 'LOCKED',
      })),
    });
    expect(ai.generateGuide.mock.calls).toHaveLength(1);
    expect(prisma.aiRun.update.mock.calls.at(-1)?.[0].data.result).toEqual(
      guide.data,
    );
  });

  it('stores spoken feedback alongside evaluation without advancing the guide', async () => {
    const prisma = workflowPrisma();
    const ai = mock<AiGateway>();
    const storage = mock<PrivateImageStorageService>();
    const evaluation = {
      result: 'NEEDS_ADJUSTMENT' as const,
      feedback: 'Blend the outer edge.',
      spokenFeedback:
        'Gently soften that outer edge, then check again when ready.',
      confidence: 0.8,
    };
    ai.describe.mockReturnValue({
      provider: 'mock',
      model: 'test',
      promptVersion: 'test',
    });
    ai.evaluateStep.mockResolvedValue({ data: evaluation });
    prisma.guideStep.findFirstOrThrow.mockResolvedValue({
      id: 'step',
      attempts: [],
      guide: {
        recommendation: { name: 'Natural', tagline: 'Soft' },
        session: { preferences: null },
      },
    } as never);
    prisma.imageAsset.findFirst.mockResolvedValue({
      storageKey: 'owned-image',
      storageProvider: 'supabase',
      mimeType: 'image/jpeg',
      source: 'PRIVATE_UPLOAD',
    } as never);
    storage.readImage.mockResolvedValue(Buffer.from('test'));
    prisma.$transaction.mockImplementation(((
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) => callback(prisma)) as PrismaService['$transaction']);
    const processor = new MakeupJobHandler(
      prisma,
      ai,
      storage,
      mock<Logger>(),
      new ConfigService(),
      mock<MakeupCreditService>(),
    );
    await processor.process({
      name: 'VISION_CHECK',
      data: {
        runId: 'run',
        authId: 'owner',
        sessionId: 'session',
        stepId: 'step',
        imageId: 'photo',
      },
    } as JobExecution<MakeupAiJob>);
    expect(prisma.stepAttempt.create.mock.calls[0]?.[0].data).toEqual({
      stepId: 'step',
      imageId: 'photo',
      ...evaluation,
    });
    expect(prisma.aiRun.update.mock.calls.at(-1)?.[0].data.result).toEqual(
      evaluation,
    );
    expect(prisma.guide.update.mock.calls).toHaveLength(0);
    expect(prisma.guideStep.update.mock.calls).toHaveLength(0);
    expect(ai.evaluateStep.mock.calls).toHaveLength(1);
  });
  it('does not call the provider again when the queue redelivers a completed run', async () => {
    const prisma = workflowPrisma();
    const ai = mock<AiGateway>();
    const storage = mock<PrivateImageStorageService>();
    const logger = mock<Logger>();
    const processor = new MakeupJobHandler(
      prisma,
      ai,
      storage,
      logger,
      new ConfigService(),
      mock<MakeupCreditService>(),
    );
    prisma.aiRun.findUnique.mockResolvedValue({ status: 'COMPLETED' } as never);
    const job = {
      name: 'PERSONALIZATION',
      data: {
        runId: 'run-id',
        authId: 'auth-id',
        sessionId: 'session-id',
      },
    } as JobExecution<MakeupAiJob>;

    await processor.process(job);

    expect(ai.describe.mock.calls).toHaveLength(0);
    expect(ai.personalize.mock.calls).toHaveLength(0);
    expect(prisma.aiRun.update.mock.calls).toHaveLength(0);
  });

  it('terminates immediately when a provider quota reset is too far away', async () => {
    const prisma = workflowPrisma();
    const ai = mock<AiGateway>();
    const storage = mock<PrivateImageStorageService>();
    const logger = mock<Logger>();
    const processor = new MakeupJobHandler(
      prisma,
      ai,
      storage,
      logger,
      new ConfigService({ AI_QUEUE_MAX_PROVIDER_PAUSE_MS: '120000' }),
      mock<MakeupCreditService>(),
    );
    prisma.aiRun.findUnique.mockResolvedValue({
      id: 'run-id',
      authId: 'auth-id',
      sessionId: 'session-id',
      operation: 'PERSONALIZATION',
      status: 'PROCESSING',
      startedAt: new Date(1000),
      createdAt: new Date(0),
    } as never);
    prisma.makeupSession.findFirstOrThrow.mockResolvedValue({
      preferences: {
        vibe: 'natural',
        skillLevel: null,
        occasion: null,
        desiredEffect: null,
        timeMinutes: 10,
        notes: null,
      },
      images: [{ id: 'image-id' }],
    } as never);
    prisma.imageAsset.findFirst.mockResolvedValue({
      storageKey: 'owner/session/image.jpg',
      storageProvider: 'supabase',
      mimeType: 'image/jpeg',
      source: 'PRIVATE_UPLOAD',
    } as never);
    storage.readImage.mockResolvedValue(Buffer.from('photo'));
    ai.describe.mockReturnValue({
      provider: 'openrouter',
      model: 'free-model',
      promptVersion: 'v1',
    });
    ai.personalize.mockRejectedValue(
      new AiProviderError(
        'AI_HTTP_429',
        'OpenRouter is temporarily unavailable',
        true,
        10 * 60 * 60 * 1_000,
      ),
    );
    const discard = jest.fn();
    const job = {
      name: 'PERSONALIZATION',
      data: {
        runId: 'run-id',
        authId: 'auth-id',
        sessionId: 'session-id',
      },
      maxAttempts: 3,
      attemptsMade: 0,
      discard,
    } as unknown as JobExecution<MakeupAiJob>;

    await expect(processor.process(job)).rejects.toMatchObject({
      code: 'AI_CAPACITY_UNAVAILABLE',
      retryable: false,
    });

    expect(discard).toHaveBeenCalledTimes(1);
    expect(
      prisma.aiRun.updateMany.mock.calls.some(
        ([args]) =>
          args.where?.id === 'run-id' &&
          args.data.status === 'FAILED' &&
          args.data.progress === 100,
      ),
    ).toBe(true);
  });

  describe('run input and queue-driver independence', () => {
    function visionSetup(jobInput: unknown) {
      const prisma = workflowPrisma();
      // The first read loads the run's input; later reads see this attempt.
      prisma.aiRun.findUnique
        .mockResolvedValueOnce({ status: 'QUEUED', jobInput } as never)
        .mockResolvedValue({
          status: 'PROCESSING',
          startedAt: new Date(1000),
        } as never);
      const ai = mock<AiGateway>();
      const storage = mock<PrivateImageStorageService>();
      ai.describe.mockReturnValue({
        provider: 'mock',
        model: 'test',
        promptVersion: 'test',
      });
      const evaluation = {
        result: 'PASS' as const,
        feedback: 'Looks even.',
        spokenFeedback: 'Looks even.',
        confidence: 0.9,
      };
      ai.evaluateStep.mockResolvedValue({ data: evaluation });
      prisma.guideStep.findFirstOrThrow.mockResolvedValue({
        id: 'step',
        attempts: [],
        guide: {
          recommendation: { name: 'Natural', tagline: 'Soft' },
          session: { preferences: null },
        },
      } as never);
      prisma.imageAsset.findFirst.mockResolvedValue({
        storageKey: 'owned-image',
        storageProvider: 'supabase',
        mimeType: 'image/jpeg',
        source: 'PRIVATE_UPLOAD',
      } as never);
      storage.readImage.mockResolvedValue(Buffer.from('test'));
      const handler = new MakeupJobHandler(
        prisma,
        ai,
        storage,
        mock<Logger>(),
        new ConfigService(),
        mock<MakeupCreditService>(),
      );
      const job = {
        id: 'run',
        name: 'VISION_CHECK',
        data: {
          runId: 'run',
          authId: 'owner',
          sessionId: 'session',
          stepId: 'step',
          imageId: 'payload-photo',
        },
        maxAttempts: 3,
        attemptsMade: 0,
      } as unknown as JobExecution<MakeupAiJob>;
      return { prisma, handler, job };
    }

    it('evaluates the image recorded on the run, not the one in the queue payload', async () => {
      const { prisma, handler, job } = visionSetup({ imageId: 'run-photo' });

      await handler.process(job);

      expect(prisma.aiRun.findUnique.mock.calls[0]?.[0]).toMatchObject({
        select: { status: true, jobInput: true },
      });
      expect(prisma.imageAsset.findFirst.mock.calls[0]?.[0]).toMatchObject({
        where: { id: 'run-photo', session: { authId: 'owner' } },
      });
      expect(prisma.stepAttempt.create.mock.calls[0]?.[0].data).toMatchObject({
        imageId: 'run-photo',
      });
    });

    it('falls back to the payload for runs created before the input was recorded', async () => {
      const { prisma, handler, job } = visionSetup(null);

      await handler.process(job);

      expect(prisma.stepAttempt.create.mock.calls[0]?.[0].data).toMatchObject({
        imageId: 'payload-photo',
      });
    });

    it('postpones a briefly rate-limited run through the queue driver without using an attempt', async () => {
      const prisma = workflowPrisma();
      prisma.aiRun.findUnique.mockResolvedValue({
        status: 'QUEUED',
        jobInput: {},
      } as never);
      const ai = mock<AiGateway>();
      ai.describe.mockReturnValue({
        provider: 'openrouter',
        model: 'test',
        promptVersion: 'test',
      });
      ai.generateGuide.mockRejectedValue(
        new AiProviderError('AI_HTTP_429', 'Slow down', true, 5_000),
      );
      prisma.makeupSession.findFirstOrThrow.mockResolvedValue({
        preferences: {},
        faceAnalysis: null,
        recommendations: [{ id: 'look', selectedAt: new Date(), palette: [] }],
      } as never);
      const postponed = new Error('postponed by the driver');
      const updateData = jest.fn().mockResolvedValue(undefined);
      const rateLimit = jest.fn().mockResolvedValue(postponed);
      const discard = jest.fn();
      const handler = new MakeupJobHandler(
        prisma,
        ai,
        mock<PrivateImageStorageService>(),
        mock<Logger>(),
        new ConfigService(),
        mock<MakeupCreditService>(),
      );

      await expect(
        handler.process({
          id: 'run',
          name: 'GUIDE_GENERATION',
          data: { runId: 'run', authId: 'owner', sessionId: 'session' },
          maxAttempts: 3,
          attemptsMade: 0,
          discard,
          updateData,
          rateLimit,
        }),
      ).rejects.toBe(postponed);

      expect(updateData).toHaveBeenCalledWith(
        expect.objectContaining({ rateLimitDeferrals: 1 }),
      );
      expect(rateLimit).toHaveBeenCalledWith(5_000);
      expect(discard).not.toHaveBeenCalled();
      expect(prisma.aiRun.updateMany.mock.calls.at(-1)?.[0].data).toEqual({
        status: 'QUEUED',
        progress: 0,
        error: null,
        startedAt: null,
      });
    });

    it('fails the run when its job is abandoned by the PostgreSQL worker', async () => {
      const prisma = workflowPrisma();
      prisma.aiRun.findUnique.mockResolvedValue({
        id: 'run',
        authId: 'owner',
        sessionId: 'session',
        operation: 'VISION_CHECK',
        status: 'PROCESSING',
        createdAt: new Date(0),
      } as never);
      const handler = new MakeupJobHandler(
        prisma,
        mock<AiGateway>(),
        mock<PrivateImageStorageService>(),
        mock<Logger>(),
        new ConfigService(),
        mock<MakeupCreditService>(),
      );

      await handler.onAbandoned({
        id: 'run',
        name: 'VISION_CHECK',
        data: undefined,
        reason: 'UNREADABLE',
      });

      expect(prisma.aiRun.updateMany.mock.calls[0]?.[0]).toMatchObject({
        where: { id: 'run' },
        data: {
          status: 'FAILED',
          progress: 100,
          error: 'Processing was interrupted. Please try again.',
        },
      });
    });
  });
});
