import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { mock } from 'jest-mock-extended';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Logger } from 'winston';
import { DataExportTable } from '../../../test/support/data-export-table';
import {
  OWNER_AVATAR_KEY,
  OWNER_ID,
  OWNER_PHOTO_KEY,
  PHOTO_BYTES,
  SUBSCRIPTION_STATUS,
  privacyPrismaFake,
  type PrivacyPrismaFake,
} from '../../../test/support/privacy-fixtures';
import { PrivateImageStorageService } from '../../storage/private-image-storage.service';
import { PrivacyExportStorageService } from '../../storage/privacy-export-storage.service';
import type { SubscriptionAccessService } from '../../subscription/subscription-access.service';
import { PrivacyExportArchiveService } from '../export/privacy-export-archive.service';
import { PrivacyExportCollectorService } from '../export/privacy-export-collector.service';
import { PrivacyExportSupersededError } from '../export/privacy-export.errors';
import { PrivacyZipWriter } from '../export/privacy-zip-writer';
import type { PrivacyExportJob } from '../interfaces/privacy-export.interface';
import { ExportAttempt } from './privacy-export-attempt';
import { PrivacyExportLifecycleService } from './privacy-export-lifecycle.service';
import { PrivacyExportProcessor } from './privacy-export.processor';

const TIMING = { leaseMs: 1_000, heartbeatMs: 10 };
const waitFor = async (condition: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** What a cancellation by account erasure does to an export row. */
const cancel = (table: DataExportTable, id: string) =>
  table.updateMany({
    where: { id },
    data: {
      status: 'FAILED',
      error: 'account unavailable',
      errorCode: 'ACCOUNT_UNAVAILABLE',
      completedAt: new Date(),
    },
  });

describe('Export worker coordination (privacy)', () => {
  let prisma: PrivacyPrismaFake;
  let table: DataExportTable;

  beforeEach(() => {
    prisma = privacyPrismaFake();
    table = new DataExportTable().attach(prisma);
  });

  const processingExport = async () => {
    const row = await table.create({
      data: { authId: OWNER_ID, idempotencyKey: `k-${Math.random()}` },
    });
    const startedAt = new Date();
    Object.assign(row, { status: 'PROCESSING', startedAt });
    return { row, startedAt };
  };

  describe('ExportAttempt', () => {
    it('runs a file operation only while the attempt is current (fence)', async () => {
      const { row, startedAt } = await processingExport();
      const attempt = new ExportAttempt(prisma, row.id, startedAt, TIMING);
      const operation = jest.fn(() => Promise.resolve('created'));

      await expect(attempt.fenced(operation)).resolves.toBe('created');

      await cancel(table, row.id);
      await expect(attempt.fenced(operation)).rejects.toBeInstanceOf(
        PrivacyExportSupersededError,
      );
      expect(operation.mock.calls).toHaveLength(1);
      expect(attempt.signal.aborted).toBe(true);
    });

    it('refuses a file operation for a newer attempt or a deleted export', async () => {
      const { row } = await processingExport();
      const stale = new ExportAttempt(prisma, row.id, new Date(0), TIMING);
      const gone = new ExportAttempt(
        prisma,
        'deleted-export',
        new Date(),
        TIMING,
      );
      const operation = jest.fn(() => Promise.resolve());

      await expect(stale.fenced(operation)).rejects.toBeInstanceOf(
        PrivacyExportSupersededError,
      );
      await expect(gone.fenced(operation)).rejects.toBeInstanceOf(
        PrivacyExportSupersededError,
      );
      expect(operation.mock.calls).toHaveLength(0);
    });

    it('renews its lease on every heartbeat and aborts once cancelled', async () => {
      const { row, startedAt } = await processingExport();
      const attempt = new ExportAttempt(prisma, row.id, startedAt, TIMING);
      attempt.start();

      await waitFor(() => row.workerLeaseUntil !== null);
      expect(row.workerLeaseUntil!.getTime()).toBeGreaterThan(Date.now());
      expect(attempt.signal.aborted).toBe(false);

      await cancel(table, row.id);
      await waitFor(() => attempt.signal.aborted);
      // Still alive while winding down: the lease keeps being renewed.
      expect(row.workerLeaseUntil!.getTime()).toBeGreaterThan(Date.now());

      await attempt.stop();
      expect(row.workerLeaseUntil).toBeNull();
    });

    it('releases only its own lease', async () => {
      const { row } = await processingExport();
      const current = new Date(row.startedAt!.getTime());
      row.workerLeaseUntil = new Date(Date.now() + 60_000);
      const stale = new ExportAttempt(prisma, row.id, new Date(0), TIMING);

      await stale.stop();

      expect(row.workerLeaseUntil).not.toBeNull();
      expect(row.startedAt).toEqual(current);
    });
  });

  describe('a worker cancelled by account erasure (real storage)', () => {
    let root: string;
    let exportRoot: string;
    let images: PrivateImageStorageService;
    let exportStorage: PrivacyExportStorageService;
    let processor: PrivacyExportProcessor;
    const env = {
      images: process.env.PRIVATE_UPLOAD_DIR,
      exports: process.env.PRIVATE_EXPORT_DIR,
    };

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'privacy-export-attempt-'));
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
      const subscriptions = mock<SubscriptionAccessService>();
      subscriptions.getStatus.mockResolvedValue(SUBSCRIPTION_STATUS);
      images = new PrivateImageStorageService();
      exportStorage = new PrivacyExportStorageService();
      const logger = mock<Logger>();
      processor = new PrivacyExportProcessor(
        prisma,
        new PrivacyExportArchiveService(
          new PrivacyExportCollectorService(prisma, subscriptions),
          images,
          exportStorage,
        ),
        exportStorage,
        new PrivacyExportLifecycleService(prisma, exportStorage, logger),
        logger,
        new ConfigService({
          PRIVACY_EXPORT_WORKER_LEASE_MS: String(TIMING.leaseMs),
          PRIVACY_EXPORT_WORKER_HEARTBEAT_MS: String(TIMING.heartbeatMs),
        }),
      );
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

    const queuedExport = () =>
      table.create({ data: { authId: OWNER_ID, idempotencyKey: 'export' } });
    const deliver = (exportId: string) =>
      processor.process({
        data: { exportId, authId: OWNER_ID },
        opts: { attempts: 3 },
        attemptsMade: 0,
        discard: jest.fn(),
      } as unknown as Job<PrivacyExportJob>);
    const filesOf = async (exportId: string) => {
      try {
        return await readdir(join(exportRoot, OWNER_ID, exportId));
      } catch {
        return [];
      }
    };

    /** Pauses the worker inside the build (while it reads a photo). */
    const pauseBuild = () => {
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => (resume = resolve));
      let paused = false;
      const reader = new PrivateImageStorageService();
      jest.spyOn(images, 'read').mockImplementation(async (key: string) => {
        paused = true;
        await gate;
        return reader.read(key);
      });
      return { resume, isPaused: () => paused };
    };

    it('holds a worker lease while building, and stops, cleans up and releases it after a cancellation mid-build', async () => {
      const row = await queuedExport();
      const build = pauseBuild();

      const running = deliver(row.id);
      await waitFor(build.isPaused);

      // The worker is mid-build: it holds a live lease and a partial file.
      expect(row.workerLeaseUntil!.getTime()).toBeGreaterThan(Date.now());
      expect((await filesOf(row.id))[0]).toMatch(/\.zip\.partial$/);

      await cancel(table, row.id);
      let filesWhenReleased: string[] | null = null;
      // An arrow-function property: no binding needed.
      const release = table.updateMany;
      prisma.dataExport.updateMany.mockImplementation((async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (
          'workerLeaseUntil' in args.data &&
          args.data.workerLeaseUntil === null
        ) {
          filesWhenReleased = await filesOf(row.id);
        }
        return release(args);
      }) as never);
      build.resume();
      await expect(running).resolves.toBeUndefined();

      // Its own partial file was gone before it released the lease, and no
      // archive was ever published.
      expect(filesWhenReleased).toEqual([]);
      expect(await filesOf(row.id)).toEqual([]);
      expect(row).toMatchObject({ status: 'FAILED', workerLeaseUntil: null });
    });

    it('never creates an archive file once the export was cancelled (fence at creation)', async () => {
      const row = await queuedExport();
      const createArchive = jest.spyOn(exportStorage, 'createArchive');
      // Cancelled between the claim and the file creation: right after the
      // worker collected the data.
      jest
        .spyOn(PrivacyExportCollectorService.prototype, 'collect')
        .mockImplementationOnce(async function (
          this: PrivacyExportCollectorService,
          authId: string,
          exportId: string,
        ) {
          // Within a once-implementation, calling again runs the original.
          const snapshot = await this.collect(authId, exportId);
          await cancel(table, row.id);
          return snapshot;
        });

      await deliver(row.id);

      expect(createArchive.mock.calls).toHaveLength(0);
      expect(await filesOf(row.id)).toEqual([]);
      expect(row.workerLeaseUntil).toBeNull();
    });

    it('never publishes (renames to .zip) once the export was cancelled (fence at commit)', async () => {
      const row = await queuedExport();
      const commitArchive = jest.spyOn(exportStorage, 'commitArchive');
      // Cancelled after the archive was fully written, just before publishing.
      jest
        .spyOn(PrivacyZipWriter.prototype, 'finish')
        .mockImplementationOnce(async function (this: PrivacyZipWriter) {
          const summary = await this.finish();
          await cancel(table, row.id);
          return summary;
        });

      await deliver(row.id);

      expect(commitArchive.mock.calls).toHaveLength(0);
      // The written partial archive was removed, and no .zip ever appeared.
      expect(await filesOf(row.id)).toEqual([]);
      expect(row).toMatchObject({ status: 'FAILED', workerLeaseUntil: null });
    });

    it('registers its worker lease at claim time, before its first heartbeat', async () => {
      const slowHeartbeat = new PrivacyExportProcessor(
        prisma,
        new PrivacyExportArchiveService(
          new PrivacyExportCollectorService(
            prisma,
            mock<SubscriptionAccessService>({
              getStatus: jest.fn().mockResolvedValue(SUBSCRIPTION_STATUS),
            }),
          ),
          images,
          exportStorage,
        ),
        exportStorage,
        new PrivacyExportLifecycleService(
          prisma,
          exportStorage,
          mock<Logger>(),
        ),
        mock<Logger>(),
        new ConfigService({
          PRIVACY_EXPORT_WORKER_LEASE_MS: '60000',
          PRIVACY_EXPORT_WORKER_HEARTBEAT_MS: '3600000',
        }),
      );
      const row = await queuedExport();
      // Pause while collecting data: before any fence could set the lease.
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => (resume = resolve));
      let paused = false;
      jest
        .spyOn(PrivacyExportCollectorService.prototype, 'collect')
        .mockImplementationOnce(async function (
          this: PrivacyExportCollectorService,
          authId: string,
          exportId: string,
        ) {
          paused = true;
          await gate;
          return this.collect(authId, exportId);
        });
      const build = { isPaused: () => paused, resume };

      const running = slowHeartbeat.process({
        data: { exportId: row.id, authId: OWNER_ID },
        opts: { attempts: 3 },
        attemptsMade: 0,
        discard: jest.fn(),
      } as unknown as Job<PrivacyExportJob>);
      await waitFor(build.isPaused);

      // Visible to account erasure from the very start of the attempt.
      expect(row.workerLeaseUntil!.getTime()).toBeGreaterThan(Date.now());

      build.resume();
      await running;
      expect(row.workerLeaseUntil).toBeNull();
    });

    it('releases its lease after a successful export', async () => {
      const row = await queuedExport();

      await deliver(row.id);

      expect(row).toMatchObject({
        status: 'COMPLETED',
        workerLeaseUntil: null,
      });
      expect(await filesOf(row.id)).toHaveLength(1);
    });
  });
});
