import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
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
  PRIVACY_EXPORT_FAILURE_MESSAGE,
  PRIVACY_EXPORT_QUEUE,
  PRIVACY_EXPORT_RETENTION_MS,
} from '../privacy-export.constants';
import { failExport } from './privacy-export-lifecycle';

/** Persist progress in steps of at least this many points. */
const PROGRESS_STEP = 5;

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
      errorCode: this.errorCode(error),
    };

    if (permanent) job.discard();
    if (!finalAttempt) {
      await this.prisma.dataExport.updateMany({
        where: { id: exportId, status: 'PROCESSING', startedAt },
        data: { status: 'QUEUED', progress: 0, startedAt: null },
      });
      this.logger.warn('Personal data export will retry', diagnostics);
    } else {
      await failExport(
        this.prisma,
        this.storage,
        exportId,
        PRIVACY_EXPORT_FAILURE_MESSAGE,
        { startedAt },
      );
      this.logger.error('Personal data export failed', diagnostics);
    }
    return error instanceof Error
      ? error
      : new Error('Personal data export failed');
  }

  private errorCode(error: unknown): string | undefined {
    return typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
      ? error.code
      : undefined;
  }
}
