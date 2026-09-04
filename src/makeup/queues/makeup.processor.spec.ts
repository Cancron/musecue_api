import type { Job } from 'bullmq';
import { mock, mockDeep } from 'jest-mock-extended';
import type { Logger } from 'winston';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/services/prisma.service';
import { PrivateImageStorageService } from '../../storage/private-image-storage.service';
import type { AiGateway } from '../ai/ai.gateway';
import { AiProviderError } from '../ai/ai-provider.error';
import { MakeupProcessor } from './makeup.processor';
import type { MakeupAiJob } from './makeup.queue';

describe('MakeupProcessor delivery semantics', () => {
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
