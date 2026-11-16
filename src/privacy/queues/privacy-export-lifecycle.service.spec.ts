import { mock, mockDeep } from 'jest-mock-extended';
import type { Logger } from 'winston';
import { DataExportTable } from '../../../test/support/data-export-table';
import type { PrismaService } from '../../common/services/prisma.service';
import type { PrivacyExportStorageService } from '../../storage/privacy-export-storage.service';
import { PRIVACY_EXPORT_FAILURES } from '../privacy-export.constants';
import { PrivacyExportLifecycleService } from './privacy-export-lifecycle.service';

const OWNER = '0a0a0a0a-0000-4000-8000-00000000000a';

describe('PrivacyExportLifecycleService (privacy export failure and cleanup)', () => {
  let table: DataExportTable;
  let storage: ReturnType<typeof mock<PrivacyExportStorageService>>;
  let logger: ReturnType<typeof mock<Logger>>;
  let lifecycle: PrivacyExportLifecycleService;

  beforeEach(() => {
    const prisma = mockDeep<PrismaService>();
    table = new DataExportTable().attach(prisma);
    storage = mock<PrivacyExportStorageService>();
    storage.deleteExportScope.mockResolvedValue();
    logger = mock<Logger>();
    lifecycle = new PrivacyExportLifecycleService(prisma, storage, logger);
  });

  const queued = () =>
    table.create({ data: { authId: OWNER, idempotencyKey: 'key-1' } });

  it.each(
    Object.keys(PRIVACY_EXPORT_FAILURES) as Array<
      keyof typeof PRIVACY_EXPORT_FAILURES
    >,
  )(
    'records FAILED with the %s reason the user sees, then deletes the export files',
    async (code) => {
      const row = await queued();

      await expect(lifecycle.fail(row.id, code)).resolves.toBe(true);

      expect(table.get(row.id)).toMatchObject({
        status: 'FAILED',
        errorCode: code,
        error: PRIVACY_EXPORT_FAILURES[code],
        completedAt: expect.any(Date) as unknown,
        storageKey: null,
        filesDeletedAt: expect.any(Date) as unknown,
      });
      expect(storage.deleteExportScope.mock.calls).toEqual([[OWNER, row.id]]);
    },
  );

  it('fails a running export and removes its partial archive files', async () => {
    const row = await queued();
    const startedAt = new Date();
    await table.updateMany({
      where: { id: row.id },
      data: { status: 'PROCESSING', startedAt, progress: 40 },
    });

    await lifecycle.fail(row.id, 'GENERATION_FAILED', { startedAt });

    expect(table.get(row.id).status).toBe('FAILED');
    expect(storage.deleteExportScope.mock.calls).toEqual([[OWNER, row.id]]);
  });

  it('keeps the FAILED status and reason when cleanup fails, and leaves the cleanup pending', async () => {
    const row = await queued();
    storage.deleteExportScope.mockRejectedValueOnce(
      Object.assign(new Error(`EBUSY: /srv/exports/${OWNER}/${row.id}`), {
        code: 'EBUSY',
      }),
    );

    await expect(lifecycle.fail(row.id, 'GENERATION_FAILED')).resolves.toBe(
      true,
    );

    expect(table.get(row.id)).toMatchObject({
      status: 'FAILED',
      errorCode: 'GENERATION_FAILED',
      error: PRIVACY_EXPORT_FAILURES.GENERATION_FAILED,
      filesDeletedAt: null,
    });
    expect((logger.warn.mock.calls[0] as unknown[])[1]).toEqual({
      context: 'PrivacyExportLifecycle',
      exportId: row.id,
      errorName: 'Error',
      errorCode: 'EBUSY',
    });
    // The private path in the error message is never logged.
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('/srv/');
  });

  it('retries pending cleanups until the files are deleted', async () => {
    const row = await queued();
    storage.deleteExportScope
      .mockRejectedValueOnce(new Error('busy'))
      .mockRejectedValueOnce(new Error('still busy'));
    await lifecycle.fail(row.id, 'GENERATION_FAILED');

    await expect(lifecycle.retryPendingCleanups()).resolves.toEqual({
      deleted: 0,
      failed: 1,
    });
    expect(table.get(row.id).filesDeletedAt).toBeNull();

    await expect(lifecycle.retryPendingCleanups()).resolves.toEqual({
      deleted: 1,
      failed: 0,
    });
    expect(table.get(row.id).filesDeletedAt).toBeInstanceOf(Date);
    expect(storage.deleteExportScope.mock.calls).toHaveLength(3);

    // Nothing left to do afterwards.
    await expect(lifecycle.retryPendingCleanups()).resolves.toEqual({
      deleted: 0,
      failed: 0,
    });
    expect(storage.deleteExportScope.mock.calls).toHaveLength(3);
  });

  it('is idempotent: failing an already failed export changes and deletes nothing', async () => {
    const row = await queued();
    await lifecycle.fail(row.id, 'INTERRUPTED');
    const recorded = { ...table.get(row.id) };

    await expect(lifecycle.fail(row.id, 'GENERATION_FAILED')).resolves.toBe(
      false,
    );

    expect(table.get(row.id)).toEqual(recorded);
    expect(storage.deleteExportScope.mock.calls).toHaveLength(1);
  });

  it('never fails a completed export or deletes its archive', async () => {
    const row = await queued();
    const completedAt = new Date();
    await table.updateMany({
      where: { id: row.id },
      data: {
        status: 'COMPLETED',
        progress: 100,
        storageKey: `${OWNER}/${row.id}/archive.zip`,
        completedAt,
        expiresAt: new Date(completedAt.getTime() + 1000),
      },
    });

    await expect(lifecycle.fail(row.id, 'INTERRUPTED')).resolves.toBe(false);

    expect(table.get(row.id).status).toBe('COMPLETED');
    expect(storage.deleteExportScope.mock.calls).toHaveLength(0);
  });

  it('does not fail an export that a newer attempt has claimed', async () => {
    const row = await queued();
    await table.updateMany({
      where: { id: row.id },
      data: { status: 'PROCESSING', startedAt: new Date(2_000) },
    });

    await expect(
      lifecycle.fail(row.id, 'GENERATION_FAILED', {
        startedAt: new Date(1_000),
      }),
    ).resolves.toBe(false);

    expect(table.get(row.id).status).toBe('PROCESSING');
    expect(storage.deleteExportScope.mock.calls).toHaveLength(0);
  });

  it('removes stale attempt files of a published export, keeping the archive', async () => {
    const key = `${OWNER}/export/archive.zip`;

    await lifecycle.removeStaleAttemptFiles(OWNER, 'export', key);
    storage.deleteExportScope.mockRejectedValueOnce(new Error('busy'));
    await expect(
      lifecycle.removeStaleAttemptFiles(OWNER, 'export', key),
    ).resolves.toBeUndefined();

    expect(storage.deleteExportScope.mock.calls[0]).toEqual([
      OWNER,
      'export',
      { keep: key },
    ]);
    expect(logger.warn.mock.calls).toHaveLength(1);
  });
});
