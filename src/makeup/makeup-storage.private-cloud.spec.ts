import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { Job } from 'bullmq';
import { mock, mockDeep } from 'jest-mock-extended';
import type { Logger } from 'winston';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import { PrivateImageLifecycleService } from '../storage/private-image-lifecycle.service';
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

describe('MakeupService private cloud storage lifecycle', () => {
  const prisma = mockDeep<PrismaService>();
  /** Separate client handed to transaction callbacks. */
  const tx = mockDeep<PrismaService>();
  const imageValidation = mock<ImageValidationService>();
  const imageStorage = mock<PrivateImageStorageService>();
  const lifecycle = mock<PrivateImageLifecycleService>();
  const service = new MakeupService(
    prisma,
    mock<MakeupQueueService>(),
    imageValidation,
    imageStorage,
    lifecycle,
    mock<AiGateway>(),
  );
  let committed: boolean;

  beforeEach(() => {
    jest.resetAllMocks();
    committed = false;
    imageValidation.validate.mockResolvedValue(VALIDATED);
    lifecycle.upload.mockResolvedValue(STORED);
    lifecycle.processRefs.mockResolvedValue([]);
    lifecycle.scheduleDeletion.mockImplementation((_tx, refs) =>
      Promise.resolve(refs),
    );
    lifecycle.abandonUpload.mockResolvedValue('DELETED');
    prisma.makeupSession.findFirst.mockResolvedValue({
      id: 'session-id',
      status: 'CREATED',
    } as never);
    tx.$queryRaw.mockResolvedValue([{ status: 'CREATED' }]);
    tx.imageAsset.findMany.mockResolvedValue([]);
    tx.imageAsset.create.mockResolvedValue({ id: 'image-id' } as never);
    prisma.$transaction.mockImplementation((async (
      callback: (client: Prisma.TransactionClient) => Promise<unknown>,
    ) => {
      const result = await callback(tx);
      committed = true;
      return result;
    }) as PrismaService['$transaction']);
  });

  describe('uploadInitialImage', () => {
    it('confirms the upload and records replaced images in the same transaction, then deletes them', async () => {
      const legacy = {
        storageKey: 'owner/session-id/old.jpg',
        storageProvider: 'local',
      };
      tx.imageAsset.findMany.mockResolvedValue([legacy] as never);
      lifecycle.processRefs.mockImplementation(() => {
        expect(committed).toBe(true);
        return Promise.resolve(['DELETED']);
      });

      await service.uploadInitialImage('owner', 'session-id', FILE);

      expect(lifecycle.upload.mock.calls).toEqual([
        ['owner', 'session-id', 'image/jpeg', FILE.buffer],
      ]);
      expect(tx.imageAsset.create.mock.calls[0]?.[0]).toEqual({
        data: {
          sessionId: 'session-id',
          purpose: 'INITIAL_ANALYSIS',
          source: 'PRIVATE_UPLOAD',
          storageKey: STORED.key,
          storageProvider: 'supabase',
          ...VALIDATED,
        },
      });
      const replaced = { provider: 'local', key: legacy.storageKey };
      expect(lifecycle.confirmUpload.mock.calls).toEqual([[tx, STORED]]);
      expect(lifecycle.scheduleDeletion.mock.calls).toEqual([
        [tx, [replaced], 'IMAGE_REPLACED', 'owner'],
      ]);
      expect(lifecycle.processRefs.mock.calls).toEqual([[[replaced]]]);
      expect(lifecycle.abandonUpload.mock.calls).toHaveLength(0);
    });

    it('still succeeds when deleting the replaced image fails, leaving it in the ledger', async () => {
      tx.imageAsset.findMany.mockResolvedValue([
        { storageKey: 'owner/session-id/old.jpg', storageProvider: 'supabase' },
      ] as never);
      lifecycle.processRefs.mockResolvedValue(['RETRY_SCHEDULED']);

      await expect(
        service.uploadInitialImage('owner', 'session-id', FILE),
      ).resolves.toBeDefined();
      expect(lifecycle.scheduleDeletion.mock.calls).toHaveLength(1);
    });

    it('validates the image and ownership before touching storage', async () => {
      imageValidation.validate.mockRejectedValueOnce(
        AppError.badRequest('Unsupported image'),
      );
      await expect(
        service.uploadInitialImage('owner', 'session-id', FILE),
      ).rejects.toThrow('Unsupported image');

      prisma.makeupSession.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.uploadInitialImage('intruder', 'session-id', FILE),
      ).rejects.toThrow('Makeup session not found');
      expect(
        prisma.makeupSession.findFirst.mock.calls.at(-1)?.[0],
      ).toMatchObject({ where: { id: 'session-id', authId: 'intruder' } });
      expect(lifecycle.upload.mock.calls).toHaveLength(0);
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
        lifecycle.upload.mockRejectedValue(new PrivateStorageError(code));

        const error = await rejection(
          service.uploadInitialImage('owner', 'session-id', FILE),
        );

        expect(httpError(error)).toEqual({ status, message });
        expect(prisma.$transaction.mock.calls).toHaveLength(0);
      },
    );

    it('abandons the upload and rethrows the database error when the transaction fails', async () => {
      const databaseError = new Error('Database unavailable');
      tx.imageAsset.create.mockRejectedValue(databaseError);
      lifecycle.abandonUpload.mockResolvedValue('RETRY_SCHEDULED');

      await expect(
        service.uploadInitialImage('owner', 'session-id', FILE),
      ).rejects.toBe(databaseError);
      expect(lifecycle.abandonUpload.mock.calls).toEqual([[STORED]]);
      expect(lifecycle.processRefs.mock.calls).toHaveLength(0);
    });

    it('rejects with 409 and abandons the upload when its reservation expired', async () => {
      lifecycle.confirmUpload.mockRejectedValue(
        AppError.conflict(
          'The image upload expired. Please upload the image again.',
        ),
      );

      const error = await rejection(
        service.uploadInitialImage('owner', 'session-id', FILE),
      );

      expect(httpError(error).status).toBe(409);
      expect(lifecycle.abandonUpload.mock.calls).toEqual([[STORED]]);
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

    it('confirms the snapshot upload with its image row', async () => {
      tx.guideStep.findUnique.mockResolvedValue({ status: 'CURRENT' } as never);
      prisma.makeupSession.findFirst.mockResolvedValue({
        id: 'session-id',
      } as never);

      await service.saveStepSnapshot('owner', 'step-id', FILE);

      expect(tx.imageAsset.create.mock.calls[0]?.[0].data).toMatchObject({
        storageKey: STORED.key,
        storageProvider: 'supabase',
        guideStepId: 'step-id',
      });
      expect(lifecycle.confirmUpload.mock.calls).toEqual([[tx, STORED]]);
    });

    it('abandons the stored snapshot when the step is no longer current', async () => {
      tx.guideStep.findUnique.mockResolvedValue({
        status: 'COMPLETED',
      } as never);

      await expect(
        service.saveStepSnapshot('owner', 'step-id', FILE),
      ).rejects.toThrow('Only the current step can save a snapshot');
      expect(lifecycle.abandonUpload.mock.calls).toEqual([[STORED]]);
      expect(tx.imageAsset.create.mock.calls).toHaveLength(0);
    });
  });

  describe('checkStep', () => {
    beforeEach(() => {
      prisma.aiRun.findUnique.mockResolvedValue(null);
      prisma.guideStep.findFirst.mockResolvedValue({
        id: 'step-id',
        status: 'CURRENT',
        guide: { sessionId: 'session-id', steps: [] },
      } as never);
    });

    it('abandons the upload when the image row cannot be stored', async () => {
      const failure = new Error('insert failed');
      tx.imageAsset.create.mockRejectedValue(failure);

      await expect(
        service.checkStep('owner', 'step-id', 'key-1', FILE),
      ).rejects.toBe(failure);
      expect(lifecycle.abandonUpload.mock.calls).toEqual([[STORED]]);
    });

    it('discards the image row and records its deletion atomically when the run cannot be created', async () => {
      const failure = new Error('Queue unavailable');
      let call = 0;
      prisma.$transaction.mockImplementation((async (
        callback: (client: Prisma.TransactionClient) => Promise<unknown>,
      ) => {
        call += 1;
        if (call === 2) throw failure; // createRun
        return callback(tx);
      }) as PrismaService['$transaction']);

      await expect(
        service.checkStep('owner', 'step-id', 'key-1', FILE),
      ).rejects.toBe(failure);
      expect(lifecycle.confirmUpload.mock.calls).toEqual([[tx, STORED]]);
      expect(tx.imageAsset.deleteMany.mock.calls).toEqual([
        [{ where: { id: 'image-id' } }],
      ]);
      expect(lifecycle.scheduleDeletion.mock.calls).toEqual([
        [tx, [STORED], 'IMAGE_DISCARDED', 'owner'],
      ]);
      expect(lifecycle.processRefs.mock.calls).toEqual([[[STORED]]]);
    });

    it('keeps the image row (so nothing is orphaned) when discarding it fails', async () => {
      const failure = new Error('Queue unavailable');
      let call = 0;
      prisma.$transaction.mockImplementation((async (
        callback: (client: Prisma.TransactionClient) => Promise<unknown>,
      ) => {
        call += 1;
        if (call >= 2) throw failure; // createRun and the discard both fail
        return callback(tx);
      }) as PrismaService['$transaction']);

      await expect(
        service.checkStep('owner', 'step-id', 'key-1', FILE),
      ).rejects.toBe(failure);
      expect(lifecycle.processRefs.mock.calls).toHaveLength(0);
      expect(imageStorage.delete.mock.calls).toHaveLength(0);
    });
  });

  describe('deleteSession', () => {
    beforeEach(() => {
      prisma.makeupSession.findFirst.mockResolvedValue({
        id: 'session-id',
        status: 'COMPLETED',
      } as never);
      tx.$queryRaw.mockResolvedValue([{ status: 'COMPLETED' }]);
    });

    it('records every image from its own provider in the deleting transaction', async () => {
      tx.imageAsset.findMany.mockResolvedValue([
        { storageKey: 'owner/session-id/a.jpg', storageProvider: 'supabase' },
        { storageKey: 'owner/session-id/b.jpg', storageProvider: 'local' },
      ] as never);
      tx.makeupSession.deleteMany.mockResolvedValue({ count: 1 });
      lifecycle.processRefs.mockResolvedValue(['DELETED', 'RETRY_SCHEDULED']);

      await expect(
        service.deleteSession('owner', 'session-id'),
      ).resolves.toEqual({ id: 'session-id' });

      const refs = [
        { provider: 'supabase', key: 'owner/session-id/a.jpg' },
        { provider: 'local', key: 'owner/session-id/b.jpg' },
      ];
      expect(tx.makeupSession.deleteMany.mock.calls[0]?.[0]).toEqual({
        where: { id: 'session-id', authId: 'owner', status: 'COMPLETED' },
      });
      expect(lifecycle.scheduleDeletion.mock.calls).toEqual([
        [tx, refs, 'SESSION_DELETED', 'owner'],
      ]);
      expect(lifecycle.processRefs.mock.calls).toEqual([[refs]]);
    });

    it('records nothing when the session changed concurrently', async () => {
      tx.makeupSession.deleteMany.mockResolvedValue({ count: 0 });

      await expect(
        service.deleteSession('owner', 'session-id'),
      ).rejects.toThrow('The session changed and could not be deleted');
      expect(lifecycle.scheduleDeletion.mock.calls).toHaveLength(0);
      expect(lifecycle.processRefs.mock.calls).toHaveLength(0);
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
    ] as const)(
      'maps %s to the expected status',
      async (_label, code, status, message) => {
        imageStorage.readImage.mockRejectedValue(new PrivateStorageError(code));

        const error = await rejection(
          service.getImageContent('owner', 'image-id'),
        );

        expect(httpError(error)).toEqual({ status, message });
      },
    );
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
    prisma.imageAsset.findFirst.mockResolvedValue({
      source: 'PRIVATE_UPLOAD',
      storageKey: 'owner/session/photo.jpg',
      storageProvider: 'supabase',
      mimeType: 'image/jpeg',
    } as never);
    storage.readImage.mockRejectedValue(readError);
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

    expect(prisma.imageAsset.findFirst.mock.calls[0]?.[0]).toEqual({
      where: { id: 'photo', session: { authId: 'owner' } },
      select: {
        storageKey: true,
        storageProvider: true,
        mimeType: true,
        source: true,
      },
    });
    expect(storage.readImage.mock.calls[0]).toEqual([
      { provider: 'supabase', key: 'owner/session/photo.jpg' },
      'image/jpeg',
    ]);
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

  it.each([
    ['the image record is gone (or belongs to someone else)', null],
    [
      'the image is not a private upload',
      {
        source: 'MOCK_CAPTURE',
        storageKey: 'mock',
        storageProvider: 'supabase',
        mimeType: 'image/jpeg',
      },
    ],
    [
      'the stored type is not a supported image',
      {
        source: 'PRIVATE_UPLOAD',
        storageKey: 'owner/session/photo.gif',
        storageProvider: 'supabase',
        mimeType: 'image/gif',
      },
    ],
  ])(
    'fails the run immediately, without reading storage, when %s',
    async (_label, record) => {
      const { prisma, ai, storage, processor, job, discard } = setup(
        new PrivateStorageError('STORAGE_UNAVAILABLE'),
      );
      prisma.imageAsset.findFirst.mockResolvedValue(record as never);

      await expect(processor.process(job)).rejects.toMatchObject({
        code: 'IMAGE_NOT_FOUND',
        retryable: false,
      });
      expect(storage.readImage.mock.calls).toHaveLength(0);
      expect(discard.mock.calls).toHaveLength(1);
      expect(ai.evaluateStep.mock.calls).toHaveLength(0);
    },
  );

  it('keeps a database failure while loading the image retryable, without persisting its text', async () => {
    const { prisma, ai, storage, processor, job, discard } = setup(
      new PrivateStorageError('STORAGE_UNAVAILABLE'),
    );
    prisma.imageAsset.findFirst.mockRejectedValue(
      Object.assign(
        new Error("Can't reach database server at `db.internal:5432`"),
        { code: 'P1001' },
      ),
    );
    const finalAttempt = { ...job, attemptsMade: 2 } as typeof job;

    await expect(processor.process(finalAttempt)).rejects.toMatchObject({
      code: 'IMAGE_LOAD_FAILED',
      retryable: true,
    });
    expect(storage.readImage.mock.calls).toHaveLength(0);
    expect(ai.evaluateStep.mock.calls).toHaveLength(0);
    expect(discard.mock.calls).toHaveLength(0);
    const failed = prisma.aiRun.updateMany.mock.calls.find(
      ([args]) => args.data.status === 'FAILED',
    );
    expect(failed?.[0].data.error).toBe(
      'Your photo could not be loaded right now. Please try again.',
    );
    expect(JSON.stringify(prisma.aiRun.updateMany.mock.calls)).not.toContain(
      'db.internal',
    );
  });

  it.each([
    ['a corrupted or mismatched object', 'INVALID_PROVIDER_RESPONSE'],
    ['an unregistered provider', 'UNKNOWN_STORAGE_PROVIDER'],
    ['rejected storage credentials', 'STORAGE_ACCESS_DENIED'],
  ] as const)(
    'fails the run without retrying on %s, with a message that names no provider',
    async (_label, code) => {
      const { prisma, ai, processor, job, discard } = setup(
        new PrivateStorageError(code, { provider: 'supabase' }),
      );

      await expect(processor.process(job)).rejects.toMatchObject({
        code: 'IMAGE_STORAGE_FAILED',
        retryable: false,
      });
      expect(discard.mock.calls).toHaveLength(1);
      expect(ai.evaluateStep.mock.calls).toHaveLength(0);
      const failed = prisma.aiRun.updateMany.mock.calls.find(
        ([args]) => args.data.status === 'FAILED',
      );
      expect(failed?.[0].data.error).toBe(
        'Your photo could not be loaded right now. Please try again.',
      );
    },
  );
});
