import type { Prisma } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../common/services/prisma.service';
import { InsufficientCreditsError } from '../credits/credit-wallet.errors';
import type { SessionUseView } from '../credits/interfaces/credit-wallet.interface';
import { PrivateImageLifecycleService } from '../storage/private-image-lifecycle.service';
import { PrivateImageStorageService } from '../storage/private-image-storage.service';
import type { AiGateway } from './ai/ai.gateway';
import { MakeupCreditService } from './makeup-credit.service';
import { MakeupService } from './makeup.service';
import { MakeupQueueService } from './queues/makeup.queue';
import { ImageValidationService } from './services/image-validation.service';

/** Credits when sessions are created and AI runs are queued. */
describe('MakeupService session credits', () => {
  const prisma = mockDeep<PrismaService>();
  const queue = mock<MakeupQueueService>();
  const ai = mock<AiGateway>();
  const credits = mock<MakeupCreditService>();
  const service = new MakeupService(
    prisma,
    queue,
    mock<ImageValidationService>(),
    mock<PrivateImageStorageService>(),
    mock<PrivateImageLifecycleService>(),
    ai,
    credits,
  );
  let order: string[];

  beforeEach(() => {
    jest.resetAllMocks();
    order = [];
    prisma.$transaction.mockImplementation(((
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) => callback(prisma)) as PrismaService['$transaction']);
    credits.usableSources.mockImplementation(() => {
      order.push('sources');
      return Promise.resolve(['PURCHASE']);
    });
    ai.describe.mockReturnValue({
      provider: 'openrouter',
      model: 'test',
      promptVersion: 'test',
    });
  });

  describe('createSession', () => {
    beforeEach(() => {
      prisma.makeupSession.create.mockImplementation((() => {
        order.push('create');
        return Promise.resolve({ id: 'session-1' });
      }) as never);
      prisma.makeupSession.findUniqueOrThrow.mockResolvedValue({
        id: 'session-1',
      } as never);
    });

    it('creates the session and initializes its credits in one transaction', async () => {
      credits.initializeSession.mockImplementation(() => {
        order.push('initialize');
        return Promise.resolve({} as SessionUseView);
      });

      await expect(service.createSession('owner')).resolves.toEqual({
        id: 'session-1',
      });

      // Sources are read before the transaction holds the wallet lock.
      expect(order).toEqual(['sources', 'create', 'initialize']);
      expect(prisma.$transaction.mock.calls).toHaveLength(1);
      expect(credits.initializeSession.mock.calls).toEqual([
        [prisma, 'owner', 'session-1', ['PURCHASE']],
      ]);
    });

    it('fails with 403 "Insufficient credits" without free credits, rolling the session back', async () => {
      credits.initializeSession.mockRejectedValue(
        new InsufficientCreditsError({ available: '0' }),
      );

      await expect(service.createSession('owner')).rejects.toMatchObject({
        status: 403,
        message: 'Insufficient credits',
      });
      // The error leaves the transaction callback, so nothing is committed.
      expect(prisma.makeupSession.findUniqueOrThrow.mock.calls).toHaveLength(0);
    });
  });

  describe('queueing AI runs', () => {
    const readySession = () => {
      prisma.makeupSession.findFirst.mockResolvedValue({
        id: 'session-1',
        status: 'IMAGE_UPLOADED',
        images: [{}],
        preferences: {},
      } as never);
      prisma.aiRun.findUnique.mockResolvedValue(null);
      prisma.$queryRaw.mockResolvedValue([{ status: 'IMAGE_UPLOADED' }]);
    };

    it('checks the session can pay under the session lock before creating the run', async () => {
      readySession();
      credits.prepareAiRequest.mockImplementation(() => {
        order.push('check-credits');
        return Promise.resolve({} as SessionUseView);
      });
      prisma.aiRun.create.mockImplementation((() => {
        order.push('create-run');
        return Promise.resolve({ id: 'run-1', sessionId: 'session-1' });
      }) as never);

      await service.startAnalysis('owner', 'session-1', 'key-1');

      expect(order).toEqual(['sources', 'check-credits', 'create-run']);
      expect(credits.prepareAiRequest.mock.calls).toEqual([
        [prisma, 'owner', 'session-1', ['PURCHASE']],
      ]);
      expect(queue.enqueue.mock.calls).toHaveLength(1);
    });

    it('refuses with 403 "Insufficient credits" and queues nothing when the session cannot pay', async () => {
      readySession();
      credits.prepareAiRequest.mockRejectedValue(
        new InsufficientCreditsError({ available: '0', overageRemaining: '0' }),
      );

      await expect(
        service.startAnalysis('owner', 'session-1', 'key-1'),
      ).rejects.toMatchObject({ status: 403, message: 'Insufficient credits' });
      expect(prisma.aiRun.create.mock.calls).toHaveLength(0);
      expect(prisma.makeupSession.update.mock.calls).toHaveLength(0);
      expect(queue.enqueue.mock.calls).toHaveLength(0);
    });

    it('returns an existing run for a repeated idempotency key without checking credits again', async () => {
      readySession();
      prisma.aiRun.findUnique.mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        operation: 'PERSONALIZATION',
        stepId: null,
      } as never);

      await expect(
        service.startAnalysis('owner', 'session-1', 'key-1'),
      ).resolves.toMatchObject({ id: 'run-1' });
      expect(credits.prepareAiRequest.mock.calls).toHaveLength(0);
    });
  });
});
