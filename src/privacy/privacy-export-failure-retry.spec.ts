import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import { mock } from 'jest-mock-extended';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Logger } from 'winston';
import { DataExportTable } from '../../test/support/data-export-table';
import {
  OWNER_AVATAR_KEY,
  OWNER_ID,
  OWNER_PHOTO_KEY,
  PHOTO_BYTES,
  SUBSCRIPTION_STATUS,
  privacyPrismaFake,
  type PrivacyPrismaFake,
} from '../../test/support/privacy-fixtures';
import { readZip } from '../../test/support/read-zip';
import { PrivateImageStorageService } from '../storage/private-image-storage.service';
import { PrivacyExportStorageService } from '../storage/privacy-export-storage.service';
import type { SubscriptionAccessService } from '../subscription/subscription-access.service';
import { PrivacyExportArchiveService } from './export/privacy-export-archive.service';
import { PrivacyExportCollectorService } from './export/privacy-export-collector.service';
import type { PrivacyExportJob } from './interfaces/privacy-export.interface';
import { PRIVACY_EXPORT_FAILURES } from './privacy-export.constants';
import { PrivacyExportService } from './privacy-export.service';
import { PrivacyExportLifecycleService } from './queues/privacy-export-lifecycle.service';
import { PrivacyExportRecoveryService } from './queues/privacy-export-recovery.service';
import { PrivacyExportProcessor } from './queues/privacy-export.processor';
import type { PrivacyExportQueueService } from './queues/privacy-export.queue';

const MAX_ATTEMPTS = 3;
const ioError = (code: string) =>
  Object.assign(new Error(`${code}: simulated`), { code });

/**
 * Failure, cleanup and retry behavior of personal-data exports, exercised
 * with the real worker, archive builder, storage and lifecycle on a real
 * filesystem. BullMQ deliveries are simulated one by one.
 */
describe('Privacy export failures, cleanup and retries', () => {
  let root: string;
  let exportRoot: string;
  let prisma: PrivacyPrismaFake;
  let table: DataExportTable;
  let images: PrivateImageStorageService;
  let exportStorage: PrivacyExportStorageService;
  let lifecycle: PrivacyExportLifecycleService;
  let archive: PrivacyExportArchiveService;
  let processor: PrivacyExportProcessor;
  let requests: PrivacyExportService;
  let queue: ReturnType<typeof mock<PrivacyExportQueueService>>;
  const env = {
    images: process.env.PRIVATE_UPLOAD_DIR,
    exports: process.env.PRIVATE_EXPORT_DIR,
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'privacy-failure-'));
    exportRoot = join(root, 'exports');
    process.env.PRIVATE_UPLOAD_DIR = join(root, 'images');
    process.env.PRIVATE_EXPORT_DIR = exportRoot;
    for (const [key, bytes] of [
      [OWNER_AVATAR_KEY, PHOTO_BYTES.avatar],
      [OWNER_PHOTO_KEY, PHOTO_BYTES.uploaded],
    ] as const) {
      const path = join(root, 'images', key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }

    prisma = privacyPrismaFake();
    table = new DataExportTable().attach(prisma);
    const subscriptions = mock<SubscriptionAccessService>();
    subscriptions.getStatus.mockResolvedValue(SUBSCRIPTION_STATUS);
    const logger = mock<Logger>();
    images = new PrivateImageStorageService();
    exportStorage = new PrivacyExportStorageService();
    lifecycle = new PrivacyExportLifecycleService(
      prisma,
      exportStorage,
      logger,
    );
    archive = new PrivacyExportArchiveService(
      new PrivacyExportCollectorService(prisma, subscriptions),
      images,
      exportStorage,
    );
    processor = new PrivacyExportProcessor(
      prisma,
      archive,
      exportStorage,
      lifecycle,
      logger,
    );
    queue = mock<PrivacyExportQueueService>();
    queue.enqueue.mockResolvedValue();
    requests = new PrivacyExportService(prisma, queue, lifecycle, logger);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const [key, value] of [
      ['PRIVATE_UPLOAD_DIR', env.images],
      ['PRIVATE_EXPORT_DIR', env.exports],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  /** Requests an export the way the API does and returns its ID. */
  const requestExport = async (key?: string) =>
    (await requests.requestExport(OWNER_ID, key)).id;

  /** One BullMQ delivery of the export's job (attemptsMade starts at 0). */
  const deliver = (exportId: string, attemptsMade = 0) => {
    const discard = jest.fn();
    const run = processor.process({
      data: { exportId, authId: OWNER_ID },
      opts: { attempts: MAX_ATTEMPTS },
      attemptsMade,
      discard,
    } as unknown as Job<PrivacyExportJob>);
    return { run, discard };
  };

  /** Files currently stored for an export (missing directory = none). */
  const filesOf = async (exportId: string): Promise<string[]> => {
    try {
      return (await readdir(join(exportRoot, OWNER_ID, exportId))).sort();
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return [];
      throw error;
    }
  };

  describe('failed processing', () => {
    it('records FAILED with the reason after the last retry and deletes the incomplete archive', async () => {
      const id = await requestExport();
      jest.spyOn(images, 'read').mockRejectedValue(ioError('EIO'));

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        await expect(deliver(id, attempt).run).rejects.toMatchObject({
          code: 'EIO',
        });
        // No incomplete archive survives any attempt.
        expect(await filesOf(id)).toEqual([]);
        if (attempt < MAX_ATTEMPTS - 1) {
          expect(table.get(id)).toMatchObject({
            status: 'QUEUED',
            progress: 0,
            attempts: attempt + 1,
            error: null,
            errorCode: null,
          });
        }
      }

      expect(table.get(id)).toMatchObject({
        status: 'FAILED',
        attempts: MAX_ATTEMPTS,
        errorCode: 'GENERATION_FAILED',
        error: PRIVACY_EXPORT_FAILURES.GENERATION_FAILED,
        storageKey: null,
        completedAt: expect.any(Date) as unknown,
        filesDeletedAt: expect.any(Date) as unknown,
      });
      await expect(requests.getExport(OWNER_ID, id)).resolves.toMatchObject({
        status: 'FAILED',
        errorCode: 'GENERATION_FAILED',
        error: PRIVACY_EXPORT_FAILURES.GENERATION_FAILED,
      });
    });

    it('deletes partial archives that earlier attempts could not remove when the export finally fails', async () => {
      const id = await requestExport();
      jest.spyOn(images, 'read').mockRejectedValue(ioError('EIO'));
      // The per-attempt cleanup fails, so each attempt leaves a .partial file.
      jest.spyOn(exportStorage, 'delete').mockRejectedValue(ioError('EBUSY'));

      await expect(deliver(id, 0).run).rejects.toBeDefined();
      await expect(deliver(id, 1).run).rejects.toBeDefined();
      const leftovers = await filesOf(id);
      expect(leftovers).toHaveLength(2);
      expect(leftovers.every((name) => name.endsWith('.zip.partial'))).toBe(
        true,
      );

      await expect(deliver(id, 2).run).rejects.toBeDefined();

      expect(table.get(id).status).toBe('FAILED');
      expect(await filesOf(id)).toEqual([]);
      expect(table.get(id).filesDeletedAt).toBeInstanceOf(Date);
    });

    it('keeps the FAILED status visible when file cleanup fails, and the recovery sweep deletes the files later', async () => {
      const id = await requestExport();
      jest.spyOn(images, 'read').mockRejectedValue(ioError('EIO'));
      jest.spyOn(exportStorage, 'delete').mockRejectedValue(ioError('EBUSY'));
      const scopeCleanup = jest
        .spyOn(exportStorage, 'deleteExportScope')
        .mockRejectedValueOnce(ioError('EBUSY'));

      await expect(deliver(id, MAX_ATTEMPTS - 1).run).rejects.toBeDefined();

      expect(table.get(id)).toMatchObject({
        status: 'FAILED',
        errorCode: 'GENERATION_FAILED',
        error: PRIVACY_EXPORT_FAILURES.GENERATION_FAILED,
        filesDeletedAt: null,
      });
      expect(await filesOf(id)).toHaveLength(1);

      const recovery = new PrivacyExportRecoveryService(
        prisma,
        lifecycle,
        mock<Queue<PrivacyExportJob>>(),
        new ConfigService({}),
        mock<Logger>(),
      );
      await recovery.reconcile();

      expect(scopeCleanup.mock.calls).toHaveLength(2);
      expect(await filesOf(id)).toEqual([]);
      expect(table.get(id).filesDeletedAt).toBeInstanceOf(Date);
      expect(table.get(id).status).toBe('FAILED');
    });

    it('reports STORAGE_FULL when the export storage runs out of space', async () => {
      const id = await requestExport();
      jest
        .spyOn(exportStorage, 'createArchive')
        .mockRejectedValue(ioError('ENOSPC'));

      await expect(deliver(id, MAX_ATTEMPTS - 1).run).rejects.toMatchObject({
        code: 'ENOSPC',
      });

      expect(table.get(id)).toMatchObject({
        status: 'FAILED',
        errorCode: 'STORAGE_FULL',
        error: PRIVACY_EXPORT_FAILURES.STORAGE_FULL,
      });
    });

    it('fails at once, without retrying, when the account no longer exists', async () => {
      const id = await requestExport();
      prisma.authUser.findUnique.mockResolvedValue(null);

      const { run, discard } = deliver(id, 0);
      await expect(run).rejects.toBeDefined();

      expect(discard).toHaveBeenCalledTimes(1);
      expect(table.get(id)).toMatchObject({
        status: 'FAILED',
        attempts: 1,
        errorCode: 'ACCOUNT_UNAVAILABLE',
        error: PRIVACY_EXPORT_FAILURES.ACCOUNT_UNAVAILABLE,
      });
      expect(await filesOf(id)).toEqual([]);
    });

    it('does not let a failed export block the next request', async () => {
      const id = await requestExport();
      jest.spyOn(images, 'read').mockRejectedValueOnce(ioError('EIO'));
      await expect(deliver(id, MAX_ATTEMPTS - 1).run).rejects.toBeDefined();

      const next = await requestExport();
      await deliver(next).run;

      expect(next).not.toBe(id);
      expect(table.get(next).status).toBe('COMPLETED');
    });
  });

  describe('retries', () => {
    it('completes on retry after a failed attempt, with exactly one archive', async () => {
      const id = await requestExport();
      jest.spyOn(images, 'read').mockRejectedValueOnce(ioError('EIO'));

      await expect(deliver(id, 0).run).rejects.toMatchObject({ code: 'EIO' });
      expect(table.get(id).status).toBe('QUEUED');
      expect(await filesOf(id)).toEqual([]);

      await deliver(id, 1).run;

      const row = table.get(id);
      expect(row).toMatchObject({
        status: 'COMPLETED',
        attempts: 2,
        error: null,
        errorCode: null,
      });
      const published = row.storageKey!.split('/').pop()!;
      expect(await filesOf(id)).toEqual([published]);
      const zip = await readZip(
        await readFile(join(exportRoot, row.storageKey!)),
      );
      expect(zip.names).toContain('data/account.json');
    });

    it('removes a partial archive left by a crashed attempt once the export completes', async () => {
      const id = await requestExport();
      const crashed = join(
        exportRoot,
        OWNER_ID,
        id,
        '5a5a5a5a-0000-4000-8000-000000000000.zip.partial',
      );
      await mkdir(dirname(crashed), { recursive: true });
      await writeFile(crashed, 'half-written');

      await deliver(id, 1).run;

      expect(await filesOf(id)).toEqual([
        table.get(id).storageKey!.split('/').pop(),
      ]);
    });

    it('never gives an incomplete archive its final name', async () => {
      const id = await requestExport();
      const seen: string[][] = [];
      const read = jest.spyOn(images, 'read');
      read.mockImplementation(async (key: string) => {
        seen.push(await filesOf(id));
        read.mockRestore();
        return images.read(key);
      });

      await deliver(id).run;

      // While photos were being copied only a .partial file existed.
      expect(seen[0]).toHaveLength(1);
      expect(seen[0][0]).toMatch(/\.zip\.partial$/);
      expect(await filesOf(id)).toEqual([
        table.get(id).storageKey!.split('/').pop(),
      ]);
    });
  });

  describe('repeated or duplicate work', () => {
    it('does not rebuild or add files when a completed export’s job is delivered again', async () => {
      const id = await requestExport();
      await deliver(id).run;
      const before = { ...table.get(id) };
      const build = jest.spyOn(archive, 'build');

      await deliver(id, 0).run;
      await deliver(id, 1).run;

      expect(build.mock.calls).toHaveLength(0);
      expect(table.get(id)).toEqual(before);
      expect(await filesOf(id)).toHaveLength(1);
    });

    it('does not create files when a failed export’s job is delivered again', async () => {
      const id = await requestExport();
      jest.spyOn(images, 'read').mockRejectedValueOnce(ioError('EIO'));
      await expect(deliver(id, MAX_ATTEMPTS - 1).run).rejects.toBeDefined();
      const before = { ...table.get(id) };

      await deliver(id, 0).run;

      expect(table.get(id)).toEqual(before);
      expect(await filesOf(id)).toEqual([]);
    });

    it('ignores a job for an export whose queueing failed', async () => {
      // The queue add "failed" from the API's point of view (for example a
      // timeout), but the job may still have reached Redis.
      queue.enqueue.mockRejectedValueOnce(new Error('timeout'));
      await expect(requests.requestExport(OWNER_ID)).rejects.toMatchObject({
        status: 503,
      });
      const [failed] = table.rows;
      expect(failed).toMatchObject({
        status: 'FAILED',
        errorCode: 'QUEUE_UNAVAILABLE',
      });

      await deliver(failed.id).run;

      expect(table.get(failed.id).status).toBe('FAILED');
      expect(await filesOf(failed.id)).toEqual([]);
    });

    it('leaves one archive when the same job is delivered twice at once (stalled redelivery)', async () => {
      for (let round = 0; round < 3; round += 1) {
        const id = await requestExport(`concurrent-${round}`);

        const results = await Promise.allSettled([
          deliver(id, 0).run,
          deliver(id, 0).run,
        ]);

        expect(results.some((result) => result.status === 'fulfilled')).toBe(
          true,
        );
        const row = table.get(id);
        expect(row.status).toBe('COMPLETED');
        expect(await filesOf(id)).toEqual([row.storageKey!.split('/').pop()]);
      }
    });

    it('queues one job per export however often the request is repeated or retried', async () => {
      const key = 'client-retry-key';
      const first = await requestExport(key);
      const again = await Promise.all([
        requestExport(key),
        requestExport(key),
        requestExport(),
      ]);

      expect(again).toEqual([first, first, first]);
      expect(queue.enqueue.mock.calls).toEqual([
        [{ exportId: first, authId: OWNER_ID }],
      ]);

      await deliver(first).run;
      // A retried request with the same key after completion: same export,
      // no new job, still one file.
      await expect(requestExport(key)).resolves.toBe(first);
      expect(queue.enqueue.mock.calls).toHaveLength(1);
      expect(await filesOf(first)).toHaveLength(1);
    });
  });
});
