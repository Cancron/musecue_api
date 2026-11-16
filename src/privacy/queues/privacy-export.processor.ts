import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  DEFAULT_EXPORT_ATTEMPT_TIMING,
  ExportAttempt,
  type ExportAttemptTiming,
} from './privacy-export-attempt';
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
    private readonly config?: ConfigService,
  ) {
    super();
  }

  /** Worker lease and heartbeat (configurable mainly for tests). */
  private timing(): ExportAttemptTiming {
    const read = (key: string, fallback: number) => {
      const value = Number(this.config?.get<string>(key));
      return Number.isInteger(value) && value > 0 ? value : fallback;
    };
    return {
      leaseMs: read(
        'PRIVACY_EXPORT_WORKER_LEASE_MS',
        DEFAULT_EXPORT_ATTEMPT_TIMING.leaseMs,
      ),
      heartbeatMs: read(
        'PRIVACY_EXPORT_WORKER_HEARTBEAT_MS',
        DEFAULT_EXPORT_ATTEMPT_TIMING.heartbeatMs,
      ),
    };
  }

  async process(job: Job<PrivacyExportJob>): Promise<void> {
    const { exportId, authId } = job.data;
    const startedAt = new Date();
    const attempt = new ExportAttempt(
      this.prisma,
      exportId,
      startedAt,
      this.timing(),
    );
    const claim = await this.prisma.dataExport.updateMany({
      // The owner in the job must match the row; a forged or stale job for
      // another user's export cannot claim it.
      // Only while the account is active: once a deletion was approved, no
      // export can start writing files (running ones are cancelled).
      where: {
        id: exportId,
        authId,
        status: { in: ['QUEUED', 'PROCESSING'] },
        authUser: { is: { status: 'ACTIVE' } },
      },
      data: {
        status: 'PROCESSING',
        progress: PROGRESS_STEP,
        startedAt,
        error: null,
        attempts: { increment: 1 },
        workerLeaseUntil: attempt.leaseUntil(startedAt),
      },
    });
    if (!claim.count) return;

    attempt.start();
    let storageKey: string | undefined;
    let failure: unknown = null;
    try {
      const result = await this.archive.build(
        authId,
        exportId,
        this.progressReporter(exportId, startedAt),
        {
          fence: (operation) => attempt.fenced(operation),
          signal: attempt.signal,
        },
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
        // that fails as well, cleanup (failure handling, or account erasure,
        // which re-checks storage) removes it.
        await this.storage.delete(storageKey).catch(() => undefined);
      }
      failure = error;
    } finally {
      // Released only after the attempt's last storage operation, so account
      // erasure never cleans up while this worker can still write.
      await attempt.stop();
    }

    if (failure === null) return;
    if (failure instanceof PrivacyExportSupersededError) {
      this.logger.warn('Superseded personal data export attempt stopped', {
        context: 'PrivacyExportProcessor',
        exportId,
      });
      return;
    }
    throw await this.handleFailure(job, failure, startedAt);
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
