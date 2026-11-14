import type { Job } from 'bullmq';
import { mock, mockDeep } from 'jest-mock-extended';
import type { Logger } from 'winston';
import type { PrismaService } from '../../common/services/prisma.service';
import type { PrivacyExportStorageService } from '../../storage/privacy-export-storage.service';
import type { PrivacyExportArchiveService } from '../export/privacy-export-archive.service';
import { PrivacyExportPermanentError } from '../export/privacy-export.errors';
import type {
  PrivacyExportJob,
  PrivacyExportProgress,
} from '../interfaces/privacy-export.interface';
import {
  PRIVACY_EXPORT_FAILURE_MESSAGE,
  PRIVACY_EXPORT_RETENTION_MS,
} from '../privacy-export.constants';
import { PrivacyExportProcessor } from './privacy-export.processor';

const OWNER = 'owner-id';
const EXPORT_ID = 'export-id';
const NOW = new Date('2026-09-01T12:00:00.000Z');
const ARCHIVE = {
  storageKey: `${OWNER}/${EXPORT_ID}/archive.zip`,
  sizeBytes: 4096,
  sha256: 'a'.repeat(64),
  photoCount: 3,
  missingPhotoCount: 1,
};

type UpdateManyArgs = {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
};

describe('PrivacyExportProcessor (privacy export worker)', () => {
  let prisma: ReturnType<typeof mockDeep<PrismaService>>;
  let archive: ReturnType<typeof mock<PrivacyExportArchiveService>>;
  let storage: ReturnType<typeof mock<PrivacyExportStorageService>>;
  let logger: ReturnType<typeof mock<Logger>>;
  let processor: PrivacyExportProcessor;

  const job = (attemptsMade = 0, data: Partial<PrivacyExportJob> = {}) => {
    const discard = jest.fn();
    return {
      job: {
        data: { exportId: EXPORT_ID, authId: OWNER, ...data },
        opts: { attempts: 3 },
        attemptsMade,
        discard,
      } as unknown as Job<PrivacyExportJob>,
      discard,
    };
  };
  const updates = () =>
    prisma.dataExport.updateMany.mock.calls.map(
      ([args]) => args as unknown as UpdateManyArgs,
    );

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
    prisma = mockDeep<PrismaService>();
    archive = mock<PrivacyExportArchiveService>();
    storage = mock<PrivacyExportStorageService>();
    logger = mock<Logger>();
    prisma.dataExport.updateMany.mockResolvedValue({ count: 1 });
    prisma.dataExport.findUnique.mockResolvedValue({
      authId: OWNER,
    } as never);
    storage.delete.mockResolvedValue();
    storage.deleteExportScope.mockResolvedValue();
    processor = new PrivacyExportProcessor(prisma, archive, storage, logger);
  });

  afterEach(() => jest.useRealTimers());

  it('claims only the job owner’s waiting export, then publishes the archive with a 24-hour expiry', async () => {
    archive.build.mockResolvedValue(ARCHIVE);

    await processor.process(job().job);

    const [claim, publish] = updates();
    expect(claim).toEqual({
      where: {
        id: EXPORT_ID,
        authId: OWNER,
        status: { in: ['QUEUED', 'PROCESSING'] },
      },
      data: {
        status: 'PROCESSING',
        progress: 5,
        startedAt: NOW,
        error: null,
        attempts: { increment: 1 },
      },
    });
    expect(archive.build.mock.calls).toContainEqual([
      OWNER,
      EXPORT_ID,
      expect.any(Function),
    ]);
    expect(publish).toEqual({
      where: {
        id: EXPORT_ID,
        authId: OWNER,
        status: 'PROCESSING',
        startedAt: NOW,
      },
      data: {
        status: 'COMPLETED',
        progress: 100,
        storageKey: ARCHIVE.storageKey,
        sizeBytes: BigInt(ARCHIVE.sizeBytes),
        sha256: ARCHIVE.sha256,
        photoCount: 3,
        missingPhotoCount: 1,
        completedAt: NOW,
        expiresAt: new Date(NOW.getTime() + PRIVACY_EXPORT_RETENTION_MS),
        error: null,
      },
    });
    expect(PRIVACY_EXPORT_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('does nothing when the export is missing, finished, or owned by someone else', async () => {
    prisma.dataExport.updateMany.mockResolvedValueOnce({ count: 0 });

    await processor.process(job(0, { authId: 'someone-else' }).job);

    expect(updates()[0].where).toMatchObject({ authId: 'someone-else' });
    expect(archive.build.mock.calls).toHaveLength(0);
  });

  it('persists progress in coarse steps and only for the current attempt', async () => {
    archive.build.mockImplementation(
      async (_owner, _id, onProgress: PrivacyExportProgress) => {
        for (const value of [15, 16, 17, 21, 55, 90, 95])
          await onProgress(value);
        return ARCHIVE;
      },
    );

    await processor.process(job().job);

    const progress = updates().filter(
      (args) => Object.keys(args.data).join() === 'progress',
    );
    expect(progress.map((args) => args.data.progress)).toEqual([
      15, 21, 55, 90, 95,
    ]);
    for (const args of progress) {
      expect(args.where).toEqual({
        id: EXPORT_ID,
        status: 'PROCESSING',
        startedAt: NOW,
      });
    }
  });

  it('stops quietly when a newer attempt took over during progress', async () => {
    archive.build.mockImplementation(
      async (_owner, _id, onProgress: PrivacyExportProgress) => {
        await onProgress(50);
        return ARCHIVE;
      },
    );
    prisma.dataExport.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    // build() rejects through the superseded progress callback (the archive
    // service removes its own partial file); the stale attempt neither fails
    // the export nor asks BullMQ to retry.
    await expect(processor.process(job().job)).resolves.toBeUndefined();
    expect(updates().some((args) => args.data.status === 'FAILED')).toBe(false);
    expect(updates().some((args) => args.data.status === 'COMPLETED')).toBe(
      false,
    );
    expect(logger.warn.mock.calls).toContainEqual([
      'Superseded personal data export attempt stopped',
      expect.objectContaining({ exportId: EXPORT_ID }),
    ]);
  });

  it('discards its archive when a newer attempt owns the export at publication', async () => {
    archive.build.mockResolvedValue(ARCHIVE);
    prisma.dataExport.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await processor.process(job().job);

    expect(storage.delete.mock.calls).toContainEqual([ARCHIVE.storageKey]);
    expect(updates().some((args) => args.data.status === 'FAILED')).toBe(false);
  });

  it('returns a retryable failure to the queue and rethrows for BullMQ backoff', async () => {
    const error = Object.assign(new Error('disk hiccup'), { code: 'EIO' });
    archive.build.mockRejectedValue(error);
    const { job: first, discard } = job(0);

    await expect(processor.process(first)).rejects.toBe(error);

    expect(discard).not.toHaveBeenCalled();
    expect(updates().at(-1)).toEqual({
      where: { id: EXPORT_ID, status: 'PROCESSING', startedAt: NOW },
      data: { status: 'QUEUED', progress: 0, startedAt: null },
    });
    expect(storage.deleteExportScope.mock.calls).toHaveLength(0);
  });

  it('fails the export with a generic message on the final attempt and removes partial files', async () => {
    const error = Object.assign(
      new Error(`EACCES: permission denied, open '/srv/${OWNER}/secret.jpg'`),
      { code: 'EACCES' },
    );
    archive.build.mockRejectedValue(error);

    await expect(processor.process(job(2).job)).rejects.toBe(error);

    expect(updates().at(-1)).toEqual({
      where: {
        id: EXPORT_ID,
        status: { in: ['QUEUED', 'PROCESSING'] },
        startedAt: NOW,
      },
      data: {
        status: 'FAILED',
        error: PRIVACY_EXPORT_FAILURE_MESSAGE,
        completedAt: NOW,
      },
    });
    expect(storage.deleteExportScope.mock.calls).toContainEqual([
      OWNER,
      EXPORT_ID,
    ]);
    expect(logger.error.mock.calls).toContainEqual([
      'Personal data export failed',
      {
        context: 'PrivacyExportProcessor',
        exportId: EXPORT_ID,
        attempt: 3,
        errorName: 'Error',
        errorCode: 'EACCES',
      },
    ]);
    // Private paths from error messages never reach the logs.
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('/srv/');
  });

  it('does not retry a permanent failure', async () => {
    archive.build.mockRejectedValue(
      new PrivacyExportPermanentError('The account no longer exists'),
    );
    const { job: first, discard } = job(0);

    await expect(processor.process(first)).rejects.toBeInstanceOf(
      PrivacyExportPermanentError,
    );

    expect(discard).toHaveBeenCalledTimes(1);
    expect(updates().at(-1)?.data.status).toBe('FAILED');
  });

  it('removes the published archive if completion cannot be recorded', async () => {
    archive.build.mockResolvedValue(ARCHIVE);
    const error = new Error('database unavailable');
    prisma.dataExport.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(error);

    await expect(processor.process(job().job)).rejects.toBe(error);

    expect(storage.delete.mock.calls).toContainEqual([ARCHIVE.storageKey]);
  });
});
