import { Inject, Injectable } from '@nestjs/common';
import type { DataExportErrorCode } from '@prisma/client';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import { PrismaService } from '../../common/services/prisma.service';
import { PrivacyExportStorageService } from '../../storage/privacy-export-storage.service';
import { PRIVACY_EXPORT_FAILURES } from '../privacy-export.constants';

export interface FailExportGuard {
  /** Only fail the attempt that started at this time. */
  startedAt?: Date;
  /** Only fail if the row has not changed since it was read. */
  updatedAt?: Date;
}

const CLEANUP_BATCH_SIZE = 100;
/** Upper bound of exports cleaned up per call, so one sweep stays bounded. */
const CLEANUP_MAX_PER_RUN = 1_000;

export interface PendingCleanupResult {
  /** Exports whose files were deleted (and recorded) in this run. */
  deleted: number;
  /** Exports whose deletion failed; they stay pending for the next run. */
  failed: number;
}

/**
 * Terminal states (FAILED, EXPIRED) and file cleanup of personal-data exports.
 *
 * Failing an export first records FAILED with a client-safe message and code
 * (so the user always sees why), then deletes every file of the export,
 * including partial archives. Expiring an export first records EXPIRED (the
 * archive reference is kept), then its files are deleted. In both cases
 * `filesDeletedAt` is set only after the deletion succeeded, so exports whose
 * cleanup failed or never ran are found and retried by retryPendingCleanups(),
 * which the retention sweep runs periodically. Every deletion is limited to
 * one export's own directory.
 */
@Injectable()
export class PrivacyExportLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: PrivacyExportStorageService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  /**
   * Moves a waiting or running export to FAILED and removes its files.
   * Terminal exports are left untouched. Returns whether this call performed
   * the transition.
   */
  async fail(
    exportId: string,
    code: DataExportErrorCode,
    guard: FailExportGuard = {},
  ): Promise<boolean> {
    const current = await this.prisma.dataExport.findUnique({
      where: { id: exportId },
      select: { authId: true },
    });
    if (!current) return false;
    const changed = await this.prisma.dataExport.updateMany({
      where: {
        id: exportId,
        status: { in: ['QUEUED', 'PROCESSING'] },
        ...(guard.startedAt ? { startedAt: guard.startedAt } : {}),
        ...(guard.updatedAt ? { updatedAt: guard.updatedAt } : {}),
      },
      data: {
        status: 'FAILED',
        error: PRIVACY_EXPORT_FAILURES[code],
        errorCode: code,
        completedAt: new Date(),
        storageKey: null,
        filesDeletedAt: null,
      },
    });
    if (!changed.count) return false;
    await this.deleteExportFiles(exportId, current.authId);
    return true;
  }

  /**
   * Marks every COMPLETED export whose archive has reached `expiresAt` as
   * EXPIRED. Idempotent; the files are deleted by retryPendingCleanups().
   */
  async expireDueExports(now: Date = new Date()): Promise<number> {
    const expired = await this.prisma.dataExport.updateMany({
      where: { status: 'COMPLETED', expiresAt: { lte: now } },
      data: { status: 'EXPIRED' },
    });
    return expired.count;
  }

  /**
   * Deletes every file of a FAILED or EXPIRED export and records it. On error
   * the export stays pending (`filesDeletedAt` null, reference kept) for a
   * later retry.
   */
  async deleteExportFiles(exportId: string, authId: string): Promise<boolean> {
    try {
      await this.storage.deleteExportScope(authId, exportId);
    } catch (error) {
      this.logger.warn(
        'Personal data export files could not be deleted yet; cleanup will be retried',
        {
          context: 'PrivacyExportLifecycle',
          exportId,
          errorName: error instanceof Error ? error.name : typeof error,
          errorCode: errorCode(error),
        },
      );
      return false;
    }
    await this.prisma.dataExport.updateMany({
      where: {
        id: exportId,
        status: { in: ['FAILED', 'EXPIRED'] },
        filesDeletedAt: null,
      },
      data: { filesDeletedAt: new Date() },
    });
    return true;
  }

  /**
   * Deletes the files of FAILED and EXPIRED exports that are not yet
   * recorded as deleted. Walks the pending exports in ID order, so an export
   * whose deletion keeps failing never blocks the others.
   */
  async retryPendingCleanups(): Promise<PendingCleanupResult> {
    const result: PendingCleanupResult = { deleted: 0, failed: 0 };
    let after: string | undefined;
    while (result.deleted + result.failed < CLEANUP_MAX_PER_RUN) {
      const pending = await this.prisma.dataExport.findMany({
        where: {
          status: { in: ['FAILED', 'EXPIRED'] },
          filesDeletedAt: null,
          ...(after ? { id: { gt: after } } : {}),
        },
        select: { id: true, authId: true },
        orderBy: { id: 'asc' },
        take: CLEANUP_BATCH_SIZE,
      });
      for (const item of pending) {
        if (await this.deleteExportFiles(item.id, item.authId)) {
          result.deleted += 1;
        } else {
          result.failed += 1;
        }
      }
      if (pending.length < CLEANUP_BATCH_SIZE) break;
      after = pending[pending.length - 1].id;
    }
    return result;
  }

  /**
   * After an archive is published, removes files left by earlier attempts of
   * the same export (for example a partial archive of a crashed worker), so a
   * completed export has exactly one file. Best effort: a failure is logged
   * and the export's retention cleanup removes the directory later.
   */
  async removeStaleAttemptFiles(
    authId: string,
    exportId: string,
    publishedKey: string,
  ): Promise<void> {
    try {
      await this.storage.deleteExportScope(authId, exportId, {
        keep: publishedKey,
      });
    } catch (error) {
      this.logger.warn('Stale personal data export files were not removed', {
        context: 'PrivacyExportLifecycle',
        exportId,
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode: errorCode(error),
      });
    }
  }
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
