import { mock, mockDeep } from 'jest-mock-extended';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/services/prisma.service';
import { PrivateImageStorageService } from '../storage/private-image-storage.service';
import { MakeupService } from './makeup.service';
import { MakeupQueueService } from './queues/makeup.queue';
import { ImageValidationService } from './services/image-validation.service';
import type { AiGateway } from './ai/ai.gateway';

describe('workflow concurrency guards', () => {
  const prisma = mockDeep<PrismaService>();
  const queue = mock<MakeupQueueService>();
  const ai = mock<AiGateway>();
  const service = new MakeupService(
    prisma,
    queue,
    mock<ImageValidationService>(),
    mock<PrivateImageStorageService>(),
    ai,
  );
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(async (callback) =>
      (callback as (tx: Prisma.TransactionClient) => Promise<unknown>)(prisma),
    );
    prisma.$queryRaw.mockResolvedValue([{ status: 'IN_PROGRESS' }]);
    prisma.guideStep.findFirst.mockResolvedValue({
      id: 'old-step',
      status: 'CURRENT',
      guide: { sessionId: 'session' },
    } as never);
  });
  it('returns current state for completion retries without making the next step CURRENT again', async () => {
    prisma.guideStep.findUniqueOrThrow.mockResolvedValue({
      status: 'COMPLETED',
    } as never);
    prisma.makeupSession.findFirst.mockResolvedValue({
      id: 'session',
    } as never);
    await service.completeStep('owner', 'old-step', {});
    expect(prisma.guideStep.update.mock.calls).toHaveLength(0);
    expect(prisma.guide.update.mock.calls).toHaveLength(0);
  });
  it('rechecks analysis state under the transaction lock', async () => {
    prisma.makeupSession.findFirst.mockResolvedValue({
      id: 'session',
      status: 'IMAGE_UPLOADED',
      images: [{}],
      preferences: {},
    } as never);
    prisma.$queryRaw.mockResolvedValue([{ status: 'ANALYZING' }]);
    ai.describe.mockReturnValue({
      provider: 'mock',
      model: 'test',
      promptVersion: 'test',
    });
    await expect(
      service.startAnalysis('owner', 'session', 'key'),
    ).rejects.toMatchObject({ status: 409 });
    expect(prisma.aiRun.create.mock.calls).toHaveLength(0);
    expect(queue.enqueue.mock.calls).toHaveLength(0);
  });
  it('returns a matching idempotent analysis retry even after the state changed', async () => {
    prisma.makeupSession.findFirst.mockResolvedValue({
      id: 'session',
      status: 'ANALYZING',
      images: [{}],
      preferences: {},
    } as never);
    const run = {
      id: 'run',
      sessionId: 'session',
      operation: 'PERSONALIZATION',
      stepId: null,
    };
    prisma.aiRun.findUnique.mockResolvedValue(run as never);
    await expect(
      service.startAnalysis('owner', 'session', 'key'),
    ).resolves.toEqual(run);
    expect(queue.enqueue.mock.calls).toHaveLength(0);
  });
  it('rejects cross-resource idempotency key reuse', async () => {
    prisma.aiRun.findUnique.mockResolvedValue({
      operation: 'VISION_CHECK',
      stepId: 'other-step',
    } as never);
    await expect(
      service.checkStep('owner', 'step', 'reused-key'),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('explicit saving does not toggle an already-saved recommendation off', async () => {
    const savedAt = new Date(1);
    prisma.recommendation.findFirst.mockResolvedValue({
      sessionId: 'session',
    } as never);
    prisma.recommendation.findUniqueOrThrow.mockResolvedValue({
      savedAt,
    } as never);
    await service.toggleSaved('owner', 'look', true);
    expect(prisma.recommendation.update.mock.calls[0]?.[0].data).toEqual({
      savedAt,
    });
  });
});
