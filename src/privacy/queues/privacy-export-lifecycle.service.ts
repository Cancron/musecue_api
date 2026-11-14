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

/**
 * Terminal failure and file cleanup of personal-data exports.
 *
 * Failing an export first records FAILED with a client-safe message and code
 * (so the user always sees why), then deletes every file of the export,
 * including partial archives. `filesDeletedAt` is set only after the deletion
 * succeeded; exports whose cleanup failed are retried by
 * retryPendingCleanups(), which the recovery sweep runs periodically.
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
    await this.deleteFailedExportFiles(exportId, current.authId);
    return true;
  }

  /**
   * Deletes every file of a FAILED export and records it. On error the
   * export stays pending (`filesDeletedAt` null) for a later retry.
   */
  async deleteFailedExportFiles(
    exportId: string,
    authId: string,
  ): Promise<boolean> {
    try {
      await this.storage.deleteExportScope(authId, exportId);
    } catch (error) {
      this.logger.warn(
        'Files of a failed personal data export could not be deleted yet; cleanup will be retried',
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
      where: { id: exportId, status: 'FAILED', filesDeletedAt: null },
      data: { filesDeletedAt: new Date() },
    });
    return true;
  }

  /** Retries cleanup of FAILED exports whose files are not yet deleted. */
  async retryPendingCleanups(): Promise<number> {
    const pending = await this.prisma.dataExport.findMany({
      where: { status: 'FAILED', filesDeletedAt: null },
      select: { id: true, authId: true },
      orderBy: { completedAt: 'asc' },
      take: CLEANUP_BATCH_SIZE,
    });
    let cleaned = 0;
    for (const item of pending) {
      if (await this.deleteFailedExportFiles(item.id, item.authId)) {
        cleaned += 1;
      }
    }
    return cleaned;
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
