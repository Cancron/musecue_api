import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { DataExportErrorCode } from '@prisma/client';
import type { Job } from 'bullmq';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import { PrismaService } from '../../common/services/prisma.service';
import { PrivacyExportStorageService } from '../../storage/privacy-export-storage.service';
import { PrivacyExportArchiveService } from '../export/privacy-export-archive.service';
import {
  PrivacyExportPermanentError,
  PrivacyExportSupersededError,
} from '../export/privacy-export.errors';
import type { PrivacyExportJob } from '../interfaces/privacy-export.interface';
import {
  PRIVACY_EXPORT_QUEUE,
  PRIVACY_EXPORT_RETENTION_MS,
} from '../privacy-export.constants';
import {
  errorCode,
  PrivacyExportLifecycleService,
} from './privacy-export-lifecycle.service';

/** Persist progress in steps of at least this many points. */
const PROGRESS_STEP = 5;

/** Filesystem errors that mean the export storage is out of space. */
const STORAGE_FULL_CODES = new Set(['ENOSPC', 'EDQUOT']);

/**
 * Builds personal-data export archives outside the request cycle.
 *
 * Each attempt claims the export by stamping a new `startedAt`; progress,
 * publication and failure are all conditioned on that stamp, so a stalled
 * attempt that resumes late can neither overwrite nor publish over a newer
 * one.
 */
@Processor(PRIVACY_EXPORT_QUEUE, { concurrency: 2 })
export class PrivacyExportProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly archive: PrivacyExportArchiveService,
    private readonly storage: PrivacyExportStorageService,
    private readonly lifecycle: PrivacyExportLifecycleService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {
    super();
  }

  async process(job: Job<PrivacyExportJob>): Promise<void> {
    const { exportId, authId } = job.data;
    const startedAt = new Date();
    const claim = await this.prisma.dataExport.updateMany({
      // The owner in the job must match the row; a forged or stale job for
      // another user's export cannot claim it.
      where: { id: exportId, authId, status: { in: ['QUEUED', 'PROCESSING'] } },
      data: {
        status: 'PROCESSING',
        progress: PROGRESS_STEP,
        startedAt,
        error: null,
        attempts: { increment: 1 },
      },
    });
    if (!claim.count) return;

    let storageKey: string | undefined;
    try {
      const result = await this.archive.build(
        authId,
        exportId,
        this.progressReporter(exportId, startedAt),
      );
      storageKey = result.storageKey;
      const completedAt = new Date();
      const published = await this.prisma.dataExport.updateMany({
        where: { id: exportId, authId, status: 'PROCESSING', startedAt },
        data: {
          status: 'COMPLETED',
          progress: 100,
          storageKey: result.storageKey,
          sizeBytes: BigInt(result.sizeBytes),
          sha256: result.sha256,
          photoCount: result.photoCount,
          missingPhotoCount: result.missingPhotoCount,
          completedAt,
          expiresAt: new Date(
            completedAt.getTime() + PRIVACY_EXPORT_RETENTION_MS,
          ),
          error: null,
        },
      });
      if (!published.count) throw new PrivacyExportSupersededError();
      // A completed export keeps exactly one file: drop partial archives
      // that earlier (crashed or failed) attempts may have left behind.
      await this.lifecycle.removeStaleAttemptFiles(
        authId,
        exportId,
        result.storageKey,
      );
      this.logger.info('Personal data export completed', {
        context: 'PrivacyExportProcessor',
        exportId,
        sizeBytes: result.sizeBytes,
        photoCount: result.photoCount,
        missingPhotoCount: result.missingPhotoCount,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      });
    } catch (error) {
      if (storageKey) {
        // The archive was built but could not be published: remove it. If
        // that fails as well, the final-failure cleanup removes the whole
        // export directory.
        await this.storage.delete(storageKey).catch(() => undefined);
      }
      if (error instanceof PrivacyExportSupersededError) {
        this.logger.warn('Superseded personal data export attempt stopped', {
          context: 'PrivacyExportProcessor',
          exportId,
        });
        return;
      }
      throw await this.handleFailure(job, error, startedAt);
    }
  }

  private progressReporter(exportId: string, startedAt: Date) {
    let persisted = PROGRESS_STEP;
    return async (progress: number): Promise<void> => {
      const next = Math.min(99, Math.max(0, Math.floor(progress)));
      if (next < persisted + PROGRESS_STEP) return;
      const updated = await this.prisma.dataExport.updateMany({
        where: { id: exportId, status: 'PROCESSING', startedAt },
        data: { progress: next },
      });
      if (!updated.count) throw new PrivacyExportSupersededError();
      persisted = next;
    };
  }

  private async handleFailure(
    job: Job<PrivacyExportJob>,
    error: unknown,
    startedAt: Date,
  ): Promise<Error> {
    const { exportId } = job.data;
    const permanent = error instanceof PrivacyExportPermanentError;
    const maxAttempts = job.opts.attempts ?? 1;
    const finalAttempt = permanent || job.attemptsMade + 1 >= maxAttempts;
    // Log the error class and code only: messages of filesystem errors
    // contain private storage paths.
    const diagnostics = {
      context: 'PrivacyExportProcessor',
      exportId,
      attempt: job.attemptsMade + 1,
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: errorCode(error),
    };

    if (permanent) job.discard();
    if (!finalAttempt) {
      await this.prisma.dataExport.updateMany({
        where: { id: exportId, status: 'PROCESSING', startedAt },
        data: { status: 'QUEUED', progress: 0, startedAt: null },
      });
      this.logger.warn('Personal data export will retry', diagnostics);
    } else {
      const code = this.failureCode(error);
      await this.lifecycle.fail(exportId, code, { startedAt });
      this.logger.error('Personal data export failed', {
        ...diagnostics,
        failureCode: code,
      });
    }
    return error instanceof Error
      ? error
      : new Error('Personal data export failed');
  }

  private failureCode(error: unknown): DataExportErrorCode {
    if (error instanceof PrivacyExportPermanentError) {
      return 'ACCOUNT_UNAVAILABLE';
    }
    const code = errorCode(error);
    return code && STORAGE_FULL_CODES.has(code)
      ? 'STORAGE_FULL'
      : 'GENERATION_FAILED';
  }
}
