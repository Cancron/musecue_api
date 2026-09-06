import type { Job } from 'bullmq';
import type { Prisma } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import type { Logger } from 'winston';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/services/prisma.service';
import { PrivateImageStorageService } from '../../storage/private-image-storage.service';
import type { AiGateway } from '../ai/ai.gateway';
import { AiProviderError } from '../ai/ai-provider.error';
import { MockAiGateway } from '../ai/mock-ai.gateway';
import { MakeupProcessor } from './makeup.processor';
import type { MakeupAiJob } from './makeup.queue';

describe('MakeupProcessor delivery semantics', () => {
  it.each([false, true])(
    'preserves guide failure/retry semantics (retryable=%s) and logs diagnostics',
    async (retryable) => {
      const prisma = mockDeep<PrismaService>();
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
      const processor = new MakeupProcessor(
        prisma,
        ai,
        mock<PrivateImageStorageService>(),
        logger,
        new ConfigService(),
      );
      const discard = jest.fn();
      await expect(
        processor.process({
          name: 'GUIDE_GENERATION',
          data: { runId: 'run', authId: 'owner', sessionId: 'session' },
          opts: { attempts: 3 },
          attemptsMade: 0,
          discard,
        } as unknown as Job<MakeupAiJob>),
      ).rejects.toBe(error);
      expect(discard).toHaveBeenCalledTimes(retryable ? 0 : 1);
      expect(prisma.aiRun.update.mock.calls.at(-1)?.[0].data.status).toBe(
        retryable ? 'QUEUED' : 'FAILED',
      );
      if (!retryable) {
        expect(prisma.makeupSession.update.mock.calls[0]?.[0]).toEqual({
          where: { id: 'session' },
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
    const prisma = mockDeep<PrismaService>();
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
    prisma.$transaction.mockImplementation(
      (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        callback(prisma),
    );
    const processor = new MakeupProcessor(
      prisma,
      ai,
      mock<PrivateImageStorageService>(),
      mock<Logger>(),
      new ConfigService(),
    );
    await processor.process({
      name: 'GUIDE_GENERATION',
      data: { runId: 'run', authId: 'owner', sessionId: 'session' },
    } as Job<MakeupAiJob>);
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
    const prisma = mockDeep<PrismaService>();
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
    prisma.imageAsset.findFirstOrThrow.mockResolvedValue({
      storageKey: 'owned-image',
      mimeType: 'image/jpeg',
    } as never);
    storage.read.mockResolvedValue(Buffer.from('test'));
    prisma.$transaction.mockImplementation(
      (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        callback(prisma),
    );
    const processor = new MakeupProcessor(
      prisma,
      ai,
      storage,
      mock<Logger>(),
      new ConfigService(),
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
    } as Job<MakeupAiJob>);
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
  it('does not call the provider again when BullMQ redelivers a completed run', async () => {
    const prisma = mockDeep<PrismaService>();
    const ai = mock<AiGateway>();
    const storage = mock<PrivateImageStorageService>();
    const logger = mock<Logger>();
    const processor = new MakeupProcessor(
      prisma,
      ai,
      storage,
      logger,
      new ConfigService(),
    );
    prisma.aiRun.findUnique.mockResolvedValue({ status: 'COMPLETED' } as never);
    const job = {
      name: 'PERSONALIZATION',
      data: {
        runId: 'run-id',
        authId: 'auth-id',
        sessionId: 'session-id',
      },
    } as Job<MakeupAiJob>;

    await processor.process(job);

    expect(ai.describe.mock.calls).toHaveLength(0);
    expect(ai.personalize.mock.calls).toHaveLength(0);
    expect(prisma.aiRun.update.mock.calls).toHaveLength(0);
  });

  it('terminates immediately when a provider quota reset is too far away', async () => {
    const prisma = mockDeep<PrismaService>();
    const ai = mock<AiGateway>();
    const storage = mock<PrivateImageStorageService>();
    const logger = mock<Logger>();
    const processor = new MakeupProcessor(
      prisma,
      ai,
      storage,
      logger,
      new ConfigService({ AI_QUEUE_MAX_PROVIDER_PAUSE_MS: '120000' }),
    );
    prisma.aiRun.findUnique.mockResolvedValue({ status: 'QUEUED' } as never);
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
    prisma.imageAsset.findFirstOrThrow.mockResolvedValue({
      storageKey: 'owner/session/image.jpg',
      mimeType: 'image/jpeg',
    } as never);
    storage.read.mockResolvedValue(Buffer.from('photo'));
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
      opts: { attempts: 3 },
      attemptsMade: 0,
      discard,
    } as unknown as Job<MakeupAiJob>;

    await expect(processor.process(job)).rejects.toMatchObject({
      code: 'AI_CAPACITY_UNAVAILABLE',
      retryable: false,
    });

    expect(discard).toHaveBeenCalledTimes(1);
    expect(
      prisma.aiRun.update.mock.calls.some(
        ([args]) =>
          args.where.id === 'run-id' &&
          args.data.status === 'FAILED' &&
          args.data.progress === 100,
      ),
    ).toBe(true);
  });
});
