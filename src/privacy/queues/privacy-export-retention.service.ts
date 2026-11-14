import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import { PrismaService } from '../../common/services/prisma.service';
import {
  PrivacyExportStorageService,
  type StoredExportScope,
} from '../../storage/privacy-export-storage.service';
import { PrivacyExportLifecycleService } from './privacy-export-lifecycle.service';

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const MIN_SWEEP_INTERVAL_MS = 10_000;
const DEFAULT_ORPHAN_SCAN_INTERVAL_MS = 60 * 60_000;
/**
 * Export directories without a database record are only removed once they
 * have not changed for this long.
 */
export const ORPHAN_MIN_AGE_MS = 60 * 60_000;
const ORPHAN_LOOKUP_BATCH = 500;

export interface RetentionSweepResult {
  /** COMPLETED exports that reached expiresAt and were marked EXPIRED. */
  expired: number;
  /** FAILED/EXPIRED exports whose files were deleted. */
  filesDeleted: number;
  /** Deletions that failed; those exports stay pending for the next sweep. */
  cleanupFailures: number;
  /** Export directories removed by the storage scan (orphans, stray files). */
  storageScopesRemoved: number;
  /** Whether the storage scan ran in this sweep. */
  storageScanned: boolean;
}

/**
 * Retention of personal-data export archives, independent of user requests.
 *
 * Every sweep (at startup, then every PRIVACY_EXPORT_CLEANUP_INTERVAL_MS):
 * 1. marks COMPLETED exports whose 24-hour retention has passed as EXPIRED
 *    (downloads already stop exactly at `expiresAt`);
 * 2. deletes the files of every FAILED/EXPIRED export not yet recorded as
 *    deleted, one export directory at a time, recording `filesDeletedAt`
 *    only after success, so failed or missed cleanups are retried;
 * 3. periodically scans storage for export directories whose record no
 *    longer exists (for example after account deletion) or whose export is
 *    already cleaned up, and removes them.
 *
 * Sweeps only need PostgreSQL and storage. They are idempotent and safe to
 * run concurrently on several instances: each step is a guarded update or
 * the deletion of one export's own directory, and active or downloadable
 * exports are never touched.
 */
@Injectable()
export class PrivacyExportRetentionService
  implements OnModuleInit, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private lastStorageScanAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: PrivacyExportLifecycleService,
    private readonly storage: PrivacyExportStorageService,
    private readonly config: ConfigService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('NODE_ENV') === 'test') return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.sweepIntervalMs());
    this.timer.unref();
    // Catch up immediately, for example after downtime.
    void this.sweep();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  sweepIntervalMs(): number {
    const value = Number(
      this.config.get<string>('PRIVACY_EXPORT_CLEANUP_INTERVAL_MS'),
    );
    return Number.isInteger(value) && value >= MIN_SWEEP_INTERVAL_MS
      ? value
      : DEFAULT_SWEEP_INTERVAL_MS;
  }

  /** Runs one retention sweep. Returns null if a sweep is already running. */
  async sweep(now: Date = new Date()): Promise<RetentionSweepResult | null> {
    if (this.running) return null;
    this.running = true;
    const result: RetentionSweepResult = {
      expired: 0,
      filesDeleted: 0,
      cleanupFailures: 0,
      storageScopesRemoved: 0,
      storageScanned: false,
    };
    try {
      // Each phase is isolated: a failure in one never skips the others.
      await this.phase('expire', async () => {
        result.expired = await this.lifecycle.expireDueExports(now);
      });
      await this.phase('delete files', async () => {
        const cleanup = await this.lifecycle.retryPendingCleanups();
        result.filesDeleted = cleanup.deleted;
        result.cleanupFailures = cleanup.failed;
      });
      if (
        now.getTime() - this.lastStorageScanAt >=
        this.storageScanIntervalMs()
      ) {
        await this.phase('storage scan', async () => {
          result.storageScopesRemoved = await this.removeUnreferencedFiles(now);
          result.storageScanned = true;
          this.lastStorageScanAt = now.getTime();
        });
      }
      if (
        result.expired ||
        result.filesDeleted ||
        result.cleanupFailures ||
        result.storageScopesRemoved
      ) {
        this.logger.info('Personal data export retention sweep', {
          context: 'PrivacyExportRetention',
          ...result,
        });
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  /**
   * Removes export directories that no record needs: directories whose export
   * record no longer exists (or belongs to another owner), once older than
   * ORPHAN_MIN_AGE_MS, and leftovers of exports whose files were already
   * recorded as deleted. Directories of waiting, running, downloadable and
   * still-pending exports are left to the regular lifecycle.
   */
  async removeUnreferencedFiles(now: Date = new Date()): Promise<number> {
    const scopes = await this.storage.listExportScopes();
    let removed = 0;
    const owners = new Set<string>();
    for (let i = 0; i < scopes.length; i += ORPHAN_LOOKUP_BATCH) {
      const batch = scopes.slice(i, i + ORPHAN_LOOKUP_BATCH);
      const records = await this.prisma.dataExport.findMany({
        where: { id: { in: batch.map((scope) => scope.exportId) } },
        select: { id: true, authId: true, status: true, filesDeletedAt: true },
      });
      const byId = new Map(records.map((record) => [record.id, record]));
      for (const scope of batch) {
        const record = byId.get(scope.exportId);
        const unreferenced = !record || record.authId !== scope.authId;
        const alreadyCleaned =
          !!record &&
          !unreferenced &&
          (record.status === 'FAILED' || record.status === 'EXPIRED') &&
          record.filesDeletedAt !== null;
        if (unreferenced && !this.isOldEnough(scope, now)) continue;
        if (!unreferenced && !alreadyCleaned) continue;
        if (await this.removeScope(scope)) {
          removed += 1;
          owners.add(scope.authId);
        }
      }
    }
    for (const authId of owners) {
      await this.storage.removeEmptyOwnerDirectory(authId);
    }
    return removed;
  }

  private isOldEnough(scope: StoredExportScope, now: Date): boolean {
    return now.getTime() - scope.modifiedAt.getTime() >= ORPHAN_MIN_AGE_MS;
  }

  private async removeScope(scope: StoredExportScope): Promise<boolean> {
    try {
      await this.storage.deleteExportScope(scope.authId, scope.exportId);
      return true;
    } catch (error) {
      this.logger.warn(
        'Unreferenced personal data export files could not be deleted yet',
        {
          context: 'PrivacyExportRetention',
          exportId: scope.exportId,
          errorName: error instanceof Error ? error.name : typeof error,
        },
      );
      return false;
    }
  }

  private storageScanIntervalMs(): number {
    const value = Number(
      this.config.get<string>('PRIVACY_EXPORT_ORPHAN_SCAN_INTERVAL_MS'),
    );
    return Number.isInteger(value) && value >= MIN_SWEEP_INTERVAL_MS
      ? value
      : DEFAULT_ORPHAN_SCAN_INTERVAL_MS;
  }

  private async phase(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.warn(
        'Personal data export retention step failed; it will retry',
        {
          context: 'PrivacyExportRetention',
          step: name,
          errorName: error instanceof Error ? error.name : typeof error,
        },
      );
    }
  }
}
