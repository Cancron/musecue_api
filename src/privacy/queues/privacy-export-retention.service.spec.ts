import { ConfigService } from '@nestjs/config';
import type { DataExport } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'winston';
import { DataExportTable } from '../../../test/support/data-export-table';
import { freezeTime } from '../../../test/support/freeze-time';
import type { PrismaService } from '../../common/services/prisma.service';
import { PrivacyExportStorageService } from '../../storage/privacy-export-storage.service';
import { PRIVACY_EXPORT_RETENTION_MS } from '../privacy-export.constants';
import { PrivacyExportLifecycleService } from './privacy-export-lifecycle.service';
import {
  ORPHAN_MIN_AGE_MS,
  PrivacyExportRetentionService,
} from './privacy-export-retention.service';

const OWNER = '0a0a0a0a-0000-4000-8000-00000000000a';
const OTHER = '0b0b0b0b-0000-4000-8000-00000000000b';
const T0 = new Date('2026-09-01T12:00:00.000Z');
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

describe('PrivacyExportRetentionService (privacy export expiry and cleanup)', () => {
  let root: string;
  let prisma: ReturnType<typeof mockDeep<PrismaService>>;
  let table: DataExportTable;
  let storage: PrivacyExportStorageService;
  let lifecycle: PrivacyExportLifecycleService;
  let logger: ReturnType<typeof mock<Logger>>;
  let retention: PrivacyExportRetentionService;
  const originalExportDir = process.env.PRIVATE_EXPORT_DIR;

  const newRetention = (settings: Record<string, string> = {}) =>
    new PrivacyExportRetentionService(
      prisma,
      lifecycle,
      storage,
      new ConfigService(settings),
      logger,
    );

  beforeEach(async () => {
    freezeTime(T0);
    root = await mkdtemp(join(tmpdir(), 'privacy-retention-'));
    process.env.PRIVATE_EXPORT_DIR = root;
    prisma = mockDeep<PrismaService>();
    table = new DataExportTable().attach(prisma);
    storage = new PrivacyExportStorageService();
    logger = mock<Logger>();
    lifecycle = new PrivacyExportLifecycleService(prisma, storage, logger);
    retention = newRetention();
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (originalExportDir === undefined) delete process.env.PRIVATE_EXPORT_DIR;
    else process.env.PRIVATE_EXPORT_DIR = originalExportDir;
    await rm(root, { recursive: true, force: true });
  });

  /** Files stored for an export (none if its directory is gone). */
  const filesOf = async (authId: string, exportId: string) => {
    try {
      return await readdir(join(root, authId, exportId));
    } catch {
      return [];
    }
  };

  /** A COMPLETED export with a real archive, completed at `completedAt`. */
  async function completed(authId: string, completedAt: Date, id?: string) {
    const row = await table.create({
      data: { authId, idempotencyKey: randomUUID() },
    });
    if (id) row.id = id;
    const target = await storage.createArchive(authId, row.id);
    await new Promise<void>((resolve) =>
      target.stream.end(Buffer.from('zip'), resolve),
    );
    await storage.commitArchive(target.storageKey);
    Object.assign(row, {
      status: 'COMPLETED',
      progress: 100,
      storageKey: target.storageKey,
      sizeBytes: BigInt(3),
      sha256: 'a'.repeat(64),
      startedAt: completedAt,
      completedAt,
      expiresAt: new Date(completedAt.getTime() + PRIVACY_EXPORT_RETENTION_MS),
    } satisfies Partial<DataExport>);
    return row;
  }

  /** A waiting/running export whose worker is writing a partial archive. */
  async function inProgress(authId: string, status: 'QUEUED' | 'PROCESSING') {
    const row = await table.create({
      data: { authId, idempotencyKey: randomUUID() },
    });
    Object.assign(row, { status });
    await storage
      .createArchive(authId, row.id)
      .then(
        (target) =>
          new Promise<void>((resolve) =>
            target.stream.end(Buffer.from('partial'), resolve),
          ),
      );
    return row;
  }

  const at = (offsetMs: number) => {
    const now = new Date(T0.getTime() + offsetMs);
    jest.setSystemTime(now);
    return now;
  };

  describe('expiration', () => {
    it('keeps an archive for 24 hours after export, then expires and deletes it', async () => {
      const row = await completed(OWNER, T0);
      const { storageKey, sha256 } = row;

      await retention.sweep(at(DAY - 1));
      expect(table.get(row.id)).toMatchObject({
        status: 'COMPLETED',
        filesDeletedAt: null,
      });
      expect(await filesOf(OWNER, row.id)).toHaveLength(1);

      const result = await retention.sweep(at(DAY));

      expect(result).toMatchObject({
        expired: 1,
        filesDeleted: 1,
        cleanupFailures: 0,
      });
      expect(table.get(row.id)).toMatchObject({
        status: 'EXPIRED',
        filesDeletedAt: new Date(T0.getTime() + DAY),
        // The reference to the deleted archive is kept.
        storageKey,
        sha256,
      });
      expect(await filesOf(OWNER, row.id)).toEqual([]);
    });

    it('catches up on every overdue export in one sweep after missed runs (more than one batch)', async () => {
      const rows: DataExport[] = [];
      // More than one cleanup batch (100), with real archive files.
      for (let i = 0; i < 105; i += 1) {
        rows.push(await completed(i % 2 ? OWNER : OTHER, T0));
      }

      // The service was down for three days.
      const result = await retention.sweep(at(3 * DAY));

      expect(result).toMatchObject({ expired: 105, filesDeleted: 105 });
      for (const row of rows) {
        expect(table.get(row.id).status).toBe('EXPIRED');
        expect(await filesOf(row.authId, row.id)).toEqual([]);
      }
    }, 30_000);
  });

  describe('cleanup process', () => {
    it('deletes only the expired archives and leaves every other export untouched', async () => {
      const expiredMine = await completed(OWNER, new Date(T0.getTime() - DAY));
      const expiredTheirs = await completed(
        OTHER,
        new Date(T0.getTime() - DAY),
      );
      const freshMine = await completed(OWNER, new Date(T0.getTime() - HOUR));
      const freshTheirs = await completed(OTHER, T0);
      const queued = await inProgress(OTHER, 'QUEUED');
      const running = await inProgress(OWNER, 'PROCESSING');

      await retention.sweep(at(0));

      for (const row of [expiredMine, expiredTheirs]) {
        expect(table.get(row.id).status).toBe('EXPIRED');
        expect(await filesOf(row.authId, row.id)).toEqual([]);
      }
      for (const row of [freshMine, freshTheirs]) {
        expect(table.get(row.id)).toMatchObject({
          status: 'COMPLETED',
          filesDeletedAt: null,
        });
        expect(await filesOf(row.authId, row.id)).toEqual([
          row.storageKey!.split('/').pop(),
        ]);
      }
      for (const row of [queued, running]) {
        expect(table.get(row.id).status).toBe(row.status);
        expect(await filesOf(row.authId, row.id)).toHaveLength(1);
      }
    });

    it('also finishes pending cleanups of failed exports', async () => {
      const row = await inProgress(OWNER, 'PROCESSING');
      Object.assign(row, {
        status: 'FAILED',
        error: 'failed',
        errorCode: 'GENERATION_FAILED',
        completedAt: T0,
      });

      await retention.sweep(at(0));

      expect(table.get(row.id).filesDeletedAt).toBeInstanceOf(Date);
      expect(await filesOf(OWNER, row.id)).toEqual([]);
    });

    it('records the cleanup even if the archive file was already gone', async () => {
      const row = await completed(OWNER, new Date(T0.getTime() - DAY));
      await storage.deleteExportScope(OWNER, row.id);

      const result = await retention.sweep(at(0));

      expect(result).toMatchObject({ expired: 1, filesDeleted: 1 });
      expect(table.get(row.id).filesDeletedAt).toBeInstanceOf(Date);
    });

    it('removes the owner directory once the last export is gone, but not before', async () => {
      const old = await completed(OWNER, new Date(T0.getTime() - DAY));
      const theirs = await completed(OTHER, new Date(T0.getTime() - DAY));
      await completed(OTHER, T0);

      await retention.sweep(at(0));

      expect(await readdir(root)).toEqual([OTHER]);
      expect(table.get(old.id).status).toBe('EXPIRED');
      expect(await filesOf(OTHER, theirs.id)).toEqual([]);
    });
  });

  describe('failed cleanup', () => {
    it('keeps the export EXPIRED with its archive reference and retries until the files are deleted', async () => {
      const row = await completed(OWNER, new Date(T0.getTime() - DAY));
      const { storageKey, sha256 } = row;
      const deleteScope = jest
        .spyOn(storage, 'deleteExportScope')
        .mockRejectedValueOnce(
          Object.assign(new Error(`EBUSY: ${root}/${storageKey}`), {
            code: 'EBUSY',
          }),
        )
        .mockRejectedValueOnce(
          Object.assign(new Error('EBUSY'), { code: 'EBUSY' }),
        );

      const first = await retention.sweep(at(0));
      const second = await retention.sweep(at(10 * 60_000));

      for (const result of [first, second]) {
        expect(result).toMatchObject({ filesDeleted: 0, cleanupFailures: 1 });
      }
      // Nothing is lost while cleanup keeps failing: the export is expired,
      // still references its archive, and is still pending cleanup.
      expect(table.get(row.id)).toMatchObject({
        status: 'EXPIRED',
        storageKey,
        sha256,
        filesDeletedAt: null,
      });
      expect(await filesOf(OWNER, row.id)).toHaveLength(1);
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(root);

      const third = await retention.sweep(at(20 * 60_000));

      expect(third).toMatchObject({ filesDeleted: 1, cleanupFailures: 0 });
      expect(table.get(row.id).filesDeletedAt).toEqual(
        new Date(T0.getTime() + 20 * 60_000),
      );
      expect(await filesOf(OWNER, row.id)).toEqual([]);
      expect(
        deleteScope.mock.calls.filter(([, id]) => id === row.id),
      ).toHaveLength(3);
    });

    it('does not let one failing cleanup block other users’ cleanups', async () => {
      const stuck = await completed(OWNER, new Date(T0.getTime() - DAY));
      const others = [
        await completed(OTHER, new Date(T0.getTime() - DAY)),
        await completed(OTHER, new Date(T0.getTime() - DAY)),
      ];
      // A second instance over the same root performs the real deletions.
      const real = new PrivacyExportStorageService();
      jest
        .spyOn(storage, 'deleteExportScope')
        .mockImplementation((authId, exportId, options) =>
          exportId === stuck.id
            ? Promise.reject(new Error('EBUSY'))
            : real.deleteExportScope(authId, exportId, options),
        );

      const result = await retention.sweep(at(0));

      expect(result).toMatchObject({
        expired: 3,
        filesDeleted: 2,
        cleanupFailures: 1,
      });
      for (const row of others) {
        expect(table.get(row.id).filesDeletedAt).toBeInstanceOf(Date);
        expect(await filesOf(OTHER, row.id)).toEqual([]);
      }
      expect(table.get(stuck.id).filesDeletedAt).toBeNull();
    });

    it('keeps cleaning healthy exports when more than a whole batch keeps failing', async () => {
      const id = (prefix: string, n: number) =>
        `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
      const day = new Date(T0.getTime() - DAY);
      // 101 stuck exports sort before the healthy ones (IDs are walked in order).
      const stuck = new Set<string>();
      for (let n = 0; n < 101; n += 1) {
        stuck.add((await completed(OWNER, day, id('00000000', n))).id);
      }
      const healthy = await completed(OTHER, day, id('ffffffff', 1));
      // A second instance over the same root performs the real deletions.
      const real = new PrivacyExportStorageService();
      jest
        .spyOn(storage, 'deleteExportScope')
        .mockImplementation((authId, exportId, options) =>
          stuck.has(exportId)
            ? Promise.reject(new Error('EBUSY'))
            : real.deleteExportScope(authId, exportId, options),
        );

      const result = await retention.sweep(at(0));

      expect(result).toMatchObject({ filesDeleted: 1, cleanupFailures: 101 });
      expect(table.get(healthy.id).filesDeletedAt).toBeInstanceOf(Date);
      expect(await filesOf(OTHER, healthy.id)).toEqual([]);
    }, 30_000);

    it('still deletes pending files when marking exports as expired fails', async () => {
      const failed = await inProgress(OWNER, 'PROCESSING');
      Object.assign(failed, {
        status: 'FAILED',
        error: 'failed',
        errorCode: 'GENERATION_FAILED',
        completedAt: T0,
      });
      jest
        .spyOn(lifecycle, 'expireDueExports')
        .mockRejectedValueOnce(new Error('database unavailable'));

      const result = await retention.sweep(at(0));

      expect(result).toMatchObject({ expired: 0, filesDeleted: 1 });
      expect((logger.warn.mock.calls[0] as unknown[])[1]).toMatchObject({
        step: 'expire',
      });
    });

    it('never makes an expired export downloadable again while its cleanup is pending', async () => {
      const row = await completed(OWNER, new Date(T0.getTime() - DAY));
      jest
        .spyOn(storage, 'deleteExportScope')
        .mockRejectedValue(new Error('EBUSY'));

      await retention.sweep(at(0));
      await retention.sweep(at(HOUR));

      // Only a guarded COMPLETED -> EXPIRED transition exists; nothing moves
      // an export back.
      expect(table.get(row.id).status).toBe('EXPIRED');
      await expect(lifecycle.expireDueExports(at(2 * HOUR))).resolves.toBe(0);
    });
  });

  describe('repeated cleanup', () => {
    it('is a no-op the second time and leaves every other export as it was', async () => {
      const expired = await completed(OWNER, new Date(T0.getTime() - DAY));
      const fresh = await completed(OTHER, T0);
      const active = await inProgress(OTHER, 'QUEUED');
      await retention.sweep(at(0));
      const snapshot = table.rows.map((row) => ({ ...row }));
      const deleteScope = jest.spyOn(storage, 'deleteExportScope');

      const again = await retention.sweep(at(60_000));
      const andAgain = await retention.sweep(at(120_000));

      for (const result of [again, andAgain]) {
        expect(result).toMatchObject({
          expired: 0,
          filesDeleted: 0,
          cleanupFailures: 0,
          storageScopesRemoved: 0,
        });
      }
      expect(deleteScope.mock.calls).toHaveLength(0);
      expect(table.rows).toEqual(snapshot);
      expect(await filesOf(OTHER, fresh.id)).toHaveLength(1);
      expect(await filesOf(OTHER, active.id)).toHaveLength(1);
      expect(table.get(expired.id).status).toBe('EXPIRED');
    });

    it('gives the same result when two instances sweep at the same time', async () => {
      const expired = [
        await completed(OWNER, new Date(T0.getTime() - DAY)),
        await completed(OTHER, new Date(T0.getTime() - DAY)),
      ];
      const fresh = await completed(OTHER, T0);
      const otherInstance = newRetention();

      const results = await Promise.all([
        retention.sweep(at(0)),
        otherInstance.sweep(at(0)),
      ]);

      expect(
        results.reduce((sum, result) => sum + (result?.expired ?? 0), 0),
      ).toBe(2);
      expect(
        results.reduce(
          (sum, result) => sum + (result?.cleanupFailures ?? 0),
          0,
        ),
      ).toBe(0);
      for (const row of expired) {
        expect(table.get(row.id)).toMatchObject({ status: 'EXPIRED' });
        expect(table.get(row.id).filesDeletedAt).toBeInstanceOf(Date);
        expect(await filesOf(row.authId, row.id)).toEqual([]);
      }
      expect(await filesOf(OTHER, fresh.id)).toHaveLength(1);
    });

    it('skips a sweep while the previous one on this instance is still running', async () => {
      await completed(OWNER, new Date(T0.getTime() - DAY));

      const [first, overlapping] = await Promise.all([
        retention.sweep(at(0)),
        retention.sweep(at(0)),
      ]);

      expect(first?.expired).toBe(1);
      expect(overlapping).toBeNull();
    });
  });

  describe('storage scan (files without a usable reference)', () => {
    const plantScope = async (
      authId: string,
      exportId: string,
      modifiedAt: Date,
    ) => {
      const directory = join(root, authId, exportId);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${randomUUID()}.zip`), 'zip');
      await utimes(directory, modifiedAt, modifiedAt);
    };

    it('removes files whose export record is gone (e.g. the account was deleted) once they are old enough', async () => {
      const deletedAccount = '0c0c0c0c-0000-4000-8000-00000000000c';
      const oldOrphan = randomUUID();
      const youngOrphan = randomUUID();
      await plantScope(
        deletedAccount,
        oldOrphan,
        new Date(T0.getTime() - ORPHAN_MIN_AGE_MS),
      );
      await plantScope(
        deletedAccount,
        youngOrphan,
        new Date(T0.getTime() - ORPHAN_MIN_AGE_MS + 60_000),
      );
      const fresh = await completed(OTHER, T0);
      const active = await inProgress(OWNER, 'PROCESSING');

      const result = await retention.sweep(at(0));

      expect(result).toMatchObject({
        storageScanned: true,
        storageScopesRemoved: 1,
      });
      expect(await readdir(join(root, deletedAccount))).toEqual([youngOrphan]);
      expect(await filesOf(OTHER, fresh.id)).toHaveLength(1);
      expect(await filesOf(OWNER, active.id)).toHaveLength(1);

      // The young orphan is removed by a later scan.
      await retention.sweep(at(2 * HOUR));
      await expect(readdir(join(root, deletedAccount))).rejects.toThrow();
    });

    it('treats a directory filed under the wrong owner as unreferenced, without touching the real owner’s files', async () => {
      const theirs = await completed(OTHER, T0);
      await plantScope(
        OWNER,
        theirs.id,
        new Date(T0.getTime() - ORPHAN_MIN_AGE_MS),
      );

      await retention.sweep(at(0));

      expect(await filesOf(OWNER, theirs.id)).toEqual([]);
      expect(await filesOf(OTHER, theirs.id)).toHaveLength(1);
    });

    it('removes leftovers that reappeared after an export was already cleaned up', async () => {
      const row = await completed(OWNER, new Date(T0.getTime() - DAY));
      await retention.sweep(at(0));
      await plantScope(OWNER, row.id, T0);

      const result = await retention.sweep(at(2 * HOUR));

      expect(result?.storageScopesRemoved).toBe(1);
      expect(await filesOf(OWNER, row.id)).toEqual([]);
    });

    it('ignores anything that does not have the export directory layout', async () => {
      await writeFile(join(root, 'README.txt'), 'keep');
      await mkdir(join(root, '.hidden', 'x'), { recursive: true });
      await mkdir(join(root, OWNER), { recursive: true });
      await writeFile(join(root, OWNER, 'note.txt'), 'keep');

      await retention.sweep(at(0));

      expect((await readdir(root)).sort()).toEqual(
        ['.hidden', OWNER, 'README.txt'].sort(),
      );
      expect(await readdir(join(root, OWNER))).toEqual(['note.txt']);
    });

    it('scans storage at most once per PRIVACY_EXPORT_ORPHAN_SCAN_INTERVAL_MS', async () => {
      const list = jest.spyOn(storage, 'listExportScopes');
      const service = newRetention({
        PRIVACY_EXPORT_ORPHAN_SCAN_INTERVAL_MS: String(HOUR),
      });

      expect((await service.sweep(at(0)))?.storageScanned).toBe(true);
      expect((await service.sweep(at(HOUR - 1)))?.storageScanned).toBe(false);
      expect((await service.sweep(at(HOUR)))?.storageScanned).toBe(true);
      expect(list.mock.calls).toHaveLength(2);
    });
  });

  describe('scheduling (independent of user requests)', () => {
    it('sweeps at startup and then on an interval outside the test environment', () => {
      const interval = jest.spyOn(global, 'setInterval');
      const service = newRetention({
        NODE_ENV: 'production',
        PRIVACY_EXPORT_CLEANUP_INTERVAL_MS: '30000',
      });
      const sweep = jest.spyOn(service, 'sweep').mockResolvedValue(null);

      service.onModuleInit();
      service.onModuleDestroy();

      expect(sweep.mock.calls).toHaveLength(1);
      expect(interval.mock.calls.at(-1)?.[1]).toBe(30_000);
    });

    it.each([
      [undefined, 60_000],
      ['5000', 60_000],
      ['not-a-number', 60_000],
      ['120000', 120_000],
    ])(
      'uses PRIVACY_EXPORT_CLEANUP_INTERVAL_MS=%s as %i ms',
      (setting, expected) => {
        const service = newRetention(
          setting ? { PRIVACY_EXPORT_CLEANUP_INTERVAL_MS: setting } : {},
        );
        expect(service.sweepIntervalMs()).toBe(expected);
      },
    );

    it('does not schedule sweeps in the test environment', () => {
      const interval = jest.spyOn(global, 'setInterval');
      const service = newRetention({ NODE_ENV: 'test' });
      const sweep = jest.spyOn(service, 'sweep');

      service.onModuleInit();

      expect(sweep.mock.calls).toHaveLength(0);
      expect(interval.mock.calls).toHaveLength(0);
    });
  });
});
