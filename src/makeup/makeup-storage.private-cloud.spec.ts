import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { Job } from 'bullmq';
import { mock, mockDeep } from 'jest-mock-extended';
import type { Logger } from 'winston';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import { PrivateImageStorageService } from '../storage/private-image-storage.service';
import { PrivateStorageError } from '../storage/private-storage.error';
import type { AiGateway } from './ai/ai.gateway';
import { MakeupService } from './makeup.service';
import { MakeupProcessor } from './queues/makeup.processor';
import type { MakeupAiJob } from './queues/makeup.queue';
import { MakeupQueueService } from './queues/makeup.queue';
import { ImageValidationService } from './services/image-validation.service';

const STORED = { provider: 'supabase', key: 'owner/session-id/new.jpg' };
const VALIDATED = {
  mimeType: 'image/jpeg' as const,
  width: 640,
  height: 640,
  sizeBytes: 5,
};
const FILE = { buffer: Buffer.from('photo') } as Express.Multer.File;

/** Runs interactive transaction callbacks against the mocked client. */
function runTransactionInline(prisma: PrismaService) {
  return ((callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
    callback(prisma)) as PrismaService['$transaction'];
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to fail');
}

function httpError(error: unknown) {
  expect(error).toBeInstanceOf(AppError);
  const appError = error as AppError;
  return {
    status: appError.getStatus(),
    message: (appError.getResponse() as { message: string }).message,
  };
}

describe('MakeupService private cloud storage integration', () => {
  const prisma = mockDeep<PrismaService>();
  const imageValidation = mock<ImageValidationService>();
  const imageStorage = mock<PrivateImageStorageService>();
  const service = new MakeupService(
    prisma,
    mock<MakeupQueueService>(),
    imageValidation,
    imageStorage,
    mock<AiGateway>(),
  );

  beforeEach(() => {
    jest.resetAllMocks();
    imageValidation.validate.mockResolvedValue(VALIDATED);
    imageStorage.deleteQuietly.mockResolvedValue(true);
    prisma.makeupSession.findFirst.mockResolvedValue({
      id: 'session-id',
      status: 'CREATED',
    } as never);
    prisma.$queryRaw.mockResolvedValue([{ status: 'CREATED' }]);
    prisma.$transaction.mockImplementation(runTransactionInline(prisma));
  });

  describe('uploadInitialImage', () => {
    it('persists the storage key and provider with the image metadata', async () => {
      imageStorage.save.mockResolvedValue(STORED);
      prisma.imageAsset.findMany.mockResolvedValue([]);

      await service.uploadInitialImage('owner', 'session-id', FILE);

      expect(imageStorage.save.mock.calls[0]).toEqual([
        'owner',
        'session-id',
        'image/jpeg',
        FILE.buffer,
      ]);
      expect(prisma.imageAsset.create.mock.calls[0]?.[0]).toEqual({
        data: {
          sessionId: 'session-id',
          purpose: 'INITIAL_ANALYSIS',
          source: 'PRIVATE_UPLOAD',
          storageKey: STORED.key,
          storageProvider: 'supabase',
          ...VALIDATED,
        },
      });
    });

    it('validates the image before touching storage', async () => {
      imageValidation.validate.mockRejectedValue(
        AppError.badRequest('Unsupported image'),
      );

      await expect(
        service.uploadInitialImage('owner', 'session-id', FILE),
      ).rejects.toThrow('Unsupported image');
      expect(imageStorage.save.mock.calls).toHaveLength(0);
    });

    it('does not write to storage for a session the user does not own', async () => {
      prisma.makeupSession.findFirst.mockResolvedValue(null);

      await expect(
        service.uploadInitialImage('intruder', 'session-id', FILE),
      ).rejects.toThrow('Makeup session not found');
      expect(prisma.makeupSession.findFirst.mock.calls[0]?.[0]).toMatchObject({
        where: { id: 'session-id', authId: 'intruder' },
      });
      expect(imageStorage.save.mock.calls).toHaveLength(0);
    });

    it.each([
      [
        'a transient outage',
        'STORAGE_UNAVAILABLE',
        503,
        'Image storage is temporarily unavailable. Please try again.',
      ],
      [
        'a timeout',
        'STORAGE_TIMEOUT',
        503,
        'Image storage is temporarily unavailable. Please try again.',
      ],
      [
        'a misconfiguration',
        'STORAGE_MISCONFIGURED',
        500,
        'Image storage is unavailable',
      ],
      [
        'rejected credentials',
        'STORAGE_ACCESS_DENIED',
        500,
        'Image storage is unavailable',
      ],
    ] as const)(
      'maps %s during upload to a safe %i without writing the database',
      async (_label, code, status, message) => {
        imageStorage.save.mockRejectedValue(
          new PrivateStorageError(code, { provider: 'supabase' }),
        );

        const error = await rejection(
          service.uploadInitialImage('owner', 'session-id', FILE),
        );

        expect(httpError(error)).toEqual({ status, message });
        expect(prisma.$transaction.mock.calls).toHaveLength(0);
        expect(prisma.imageAsset.create.mock.calls).toHaveLength(0);
      },
    );

    it('removes the new object and rethrows the database error even if cleanup fails', async () => {
      imageStorage.save.mockResolvedValue(STORED);
      imageStorage.deleteQuietly.mockResolvedValue(false);
      const databaseError = new Error('Database unavailable');
      prisma.$transaction.mockRejectedValue(databaseError);

      await expect(
        service.uploadInitialImage('owner', 'session-id', FILE),
      ).rejects.toBe(databaseError);
      expect(imageStorage.deleteQuietly.mock.calls).toEqual([
        [STORED, 'initial image upload rolled back'],
      ]);
    });

    it('deletes replaced images from the provider that stored them after commit', async () => {
      imageStorage.save.mockResolvedValue(STORED);
      prisma.imageAsset.findMany.mockResolvedValue([
        { storageKey: 'owner/session-id/legacy.jpg', storageProvider: 'local' },
      ] as never);
      imageStorage.deleteQuietly.mockResolvedValue(false);

      await expect(
        service.uploadInitialImage('owner', 'session-id', FILE),
      ).resolves.toBeDefined();
      expect(imageStorage.deleteQuietly.mock.calls).toEqual([
        [
          { provider: 'local', key: 'owner/session-id/legacy.jpg' },
          'initial image replaced',
        ],
      ]);
    });
  });

  describe('saveStepSnapshot', () => {
    beforeEach(() => {
      prisma.guideStep.findFirst.mockResolvedValue({
        id: 'step-id',
        status: 'CURRENT',
        guide: { sessionId: 'session-id', steps: [] },
      } as never);
    });

    it('cleans up the stored snapshot when the step is no longer current', async () => {
      imageStorage.save.mockResolvedValue(STORED);
      prisma.guideStep.findUnique.mockResolvedValue({
        status: 'COMPLETED',
      } as never);

      await expect(
        service.saveStepSnapshot('owner', 'step-id', FILE),
      ).rejects.toThrow('Only the current step can save a snapshot');
      expect(imageStorage.deleteQuietly.mock.calls).toEqual([
        [STORED, 'step snapshot upload rolled back'],
      ]);
      expect(prisma.imageAsset.create.mock.calls).toHaveLength(0);
    });

    it('maps storage outages to 503', async () => {
      imageStorage.save.mockRejectedValue(
        new PrivateStorageError('STORAGE_UNAVAILABLE'),
      );

      expect(
        httpError(
          await rejection(service.saveStepSnapshot('owner', 'step-id', FILE)),
        ).status,
      ).toBe(503);
    });
  });

  describe('checkStep', () => {
    it('persists the provider and cleans up on failure without queueing AI work', async () => {
      prisma.aiRun.findUnique.mockResolvedValue(null);
      prisma.guideStep.findFirst.mockResolvedValue({
        id: 'step-id',
        status: 'CURRENT',
        guide: { sessionId: 'session-id', steps: [] },
      } as never);
      imageStorage.save.mockResolvedValue(STORED);
      prisma.imageAsset.create.mockResolvedValue({ id: 'image-id' } as never);
      prisma.imageAsset.deleteMany.mockResolvedValue({ count: 1 });
      const failure = new Error('Queue unavailable');
      prisma.$transaction.mockRejectedValue(failure);

      await expect(
        service.checkStep('owner', 'step-id', 'key-1', FILE),
      ).rejects.toBe(failure);
      expect(prisma.imageAsset.create.mock.calls[0]?.[0].data).toMatchObject({
        storageKey: STORED.key,
        storageProvider: 'supabase',
      });
      expect(imageStorage.deleteQuietly.mock.calls).toEqual([
        [STORED, 'visual check upload rolled back'],
      ]);
    });
  });

  describe('getImageContent', () => {
    beforeEach(() => {
      prisma.imageAsset.findFirst.mockResolvedValue({
        storageKey: 'owner/session-id/image.jpg',
        storageProvider: 'supabase',
        mimeType: 'image/jpeg',
        source: 'PRIVATE_UPLOAD',
      } as never);
    });

    it.each([
      [
        'a missing object',
        'OBJECT_NOT_FOUND',
        404,
        'Image content is unavailable',
      ],
      [
        'an invalid stored key',
        'INVALID_STORAGE_KEY',
        404,
        'Image content is unavailable',
      ],
      [
        'a storage outage',
        'STORAGE_UNAVAILABLE',
        503,
        'Image storage is temporarily unavailable. Please try again.',
      ],
      [
        'an unregistered provider',
        'UNKNOWN_STORAGE_PROVIDER',
        500,
        'Image storage is unavailable',
      ],
    ] as const)('maps %s to %i', async (_label, code, status, message) => {
      imageStorage.read.mockRejectedValue(new PrivateStorageError(code));

      const error = await rejection(
        service.getImageContent('owner', 'image-id'),
      );

      expect(httpError(error)).toEqual({ status, message });
    });
  });

  describe('deleteSession', () => {
    it('removes every image from its own provider and tolerates cleanup failures', async () => {
      prisma.makeupSession.findFirst.mockResolvedValue({
        id: 'session-id',
        status: 'COMPLETED',
        images: [
          { storageKey: 'owner/session-id/a.jpg', storageProvider: 'supabase' },
          { storageKey: 'owner/session-id/b.jpg', storageProvider: 'local' },
        ],
      } as never);
      prisma.makeupSession.deleteMany.mockResolvedValue({ count: 1 });
      imageStorage.deleteQuietly.mockResolvedValueOnce(false);

      await expect(
        service.deleteSession('owner', 'session-id'),
      ).resolves.toEqual({ id: 'session-id' });
      expect(imageStorage.deleteQuietly.mock.calls.map(([ref]) => ref)).toEqual(
        [
          { provider: 'supabase', key: 'owner/session-id/a.jpg' },
          { provider: 'local', key: 'owner/session-id/b.jpg' },
        ],
      );
    });
  });
});

describe('MakeupProcessor private cloud storage reads', () => {
  function setup(readError: PrivateStorageError) {
    const prisma = mockDeep<PrismaService>();
    const ai = mock<AiGateway>();
    const storage = mock<PrivateImageStorageService>();
    prisma.$queryRaw.mockResolvedValue([{ status: 'IN_PROGRESS' }]);
    prisma.aiRun.findUnique.mockResolvedValue({
      id: 'run',
      authId: 'owner',
      sessionId: 'session',
      operation: 'VISION_CHECK',
      status: 'PROCESSING',
      startedAt: new Date(1000),
      createdAt: new Date(0),
    } as never);
    prisma.aiRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation(runTransactionInline(prisma));
    ai.describe.mockReturnValue({
      provider: 'mock',
      model: 'test',
      promptVersion: 'test',
    });
    prisma.guideStep.findFirstOrThrow.mockResolvedValue({
      id: 'step',
      attempts: [],
      guide: {
        recommendation: { name: 'Natural', tagline: 'Soft' },
        session: { preferences: null },
      },
    } as never);
    prisma.imageAsset.findFirstOrThrow.mockResolvedValue({
      storageKey: 'owner/session/photo.jpg',
      storageProvider: 'supabase',
      mimeType: 'image/jpeg',
    } as never);
    storage.read.mockRejectedValue(readError);
    const processor = new MakeupProcessor(
      prisma,
      ai,
      storage,
      mock<Logger>(),
      new ConfigService(),
    );
    const discard = jest.fn();
    const job = {
      name: 'VISION_CHECK',
      data: {
        runId: 'run',
        authId: 'owner',
        sessionId: 'session',
        stepId: 'step',
        imageId: 'photo',
      },
      opts: { attempts: 3 },
      attemptsMade: 0,
      discard,
    } as unknown as Job<MakeupAiJob>;
    return { prisma, ai, storage, processor, job, discard };
  }

  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(1000));
  afterEach(() => jest.restoreAllMocks());

  it('reads the owned image from the provider recorded on the asset', async () => {
    const { prisma, storage, processor, job } = setup(
      new PrivateStorageError('STORAGE_UNAVAILABLE'),
    );

    await processor.process(job).catch(() => undefined);

    expect(prisma.imageAsset.findFirstOrThrow.mock.calls[0]?.[0]).toEqual({
      where: { id: 'photo', session: { authId: 'owner' } },
      select: { storageKey: true, storageProvider: true, mimeType: true },
    });
    expect(storage.read.mock.calls[0]?.[0]).toEqual({
      provider: 'supabase',
      key: 'owner/session/photo.jpg',
    });
  });

  it('fails the run immediately with a safe message when the image is gone', async () => {
    const { prisma, ai, processor, job, discard } = setup(
      new PrivateStorageError('OBJECT_NOT_FOUND'),
    );

    await expect(processor.process(job)).rejects.toMatchObject({
      code: 'IMAGE_NOT_FOUND',
      retryable: false,
    });
    expect(discard.mock.calls).toHaveLength(1);
    expect(ai.evaluateStep.mock.calls).toHaveLength(0);
    const failed = prisma.aiRun.updateMany.mock.calls.find(
      ([args]) => args.data.status === 'FAILED',
    );
    expect(failed?.[0].data.error).toBe(
      'The photo for this request is no longer available. Please upload it again.',
    );
  });

  it('keeps transient storage failures retryable within the job budget', async () => {
    const { prisma, ai, processor, job, discard } = setup(
      new PrivateStorageError('STORAGE_TIMEOUT'),
    );

    await expect(processor.process(job)).rejects.toMatchObject({
      code: 'IMAGE_STORAGE_UNAVAILABLE',
      retryable: true,
    });
    expect(discard.mock.calls).toHaveLength(0);
    expect(ai.evaluateStep.mock.calls).toHaveLength(0);
    expect(
      prisma.aiRun.updateMany.mock.calls.some(
        ([args]) => args.data.status === 'QUEUED',
      ),
    ).toBe(true);
  });
});
