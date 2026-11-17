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
import { JobInspector } from '../../infrastructure/jobs/job.types';
import { PRIVACY_EXPORT_QUEUE } from '../privacy-export.constants';
import { PrivacyExportLifecycleService } from './privacy-export-lifecycle.service';

const MIN_GRACE_MS = 120_000;
const BATCH_SIZE = 100;

/**
 * Fails exports whose job (on the selected queue driver) no longer exists or
 * has already finished, so they stop blocking the owner's next request (only
 * one export may be active per user) and clients stop polling. Healthy
 * waiting, delayed or active jobs are left alone; a queue outage postpones
 * recovery.
 *
 * File cleanup of failed and expired exports is done by
 * PrivacyExportRetentionService, which needs no queue.
 */
@Injectable()
export class PrivacyExportRecoveryService
  implements OnModuleInit, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: PrivacyExportLifecycleService,
    private readonly jobs: JobInspector,
    private readonly config: ConfigService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('NODE_ENV') === 'test') return;
    this.timer = setInterval(() => {
      void this.reconcile();
    }, 60_000);
    this.timer.unref();
    void this.reconcile();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async reconcile(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const grace = Number(
        this.config.get<string>('PRIVACY_EXPORT_RECOVERY_GRACE_MS'),
      );
      const graceMs =
        Number.isFinite(grace) && grace >= MIN_GRACE_MS ? grace : MIN_GRACE_MS;
      let cursor: string | undefined;
      for (;;) {
        const exports = await this.prisma.dataExport.findMany({
          where: {
            status: { in: ['QUEUED', 'PROCESSING'] },
            updatedAt: { lt: new Date(now.getTime() - graceMs) },
          },
          select: { id: true, updatedAt: true },
          orderBy: { id: 'asc' },
          take: BATCH_SIZE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        for (const item of exports) {
          // Queue errors must abort this pass, not be treated as absent jobs.
          const state = await this.jobs.getJobState(
            PRIVACY_EXPORT_QUEUE,
            item.id,
          );
          if (['failed', 'completed', 'unknown'].includes(state)) {
            const failed = await this.lifecycle.fail(item.id, 'INTERRUPTED', {
              updatedAt: item.updatedAt,
            });
            if (failed) {
              this.logger.warn(
                'Recovered an interrupted personal data export',
                {
                  context: 'PrivacyExportRecovery',
                  exportId: item.id,
                  jobState: state,
                },
              );
            }
          }
        }
        if (exports.length < BATCH_SIZE) break;
        cursor = exports[exports.length - 1].id;
      }
    } catch {
      this.logger.warn(
        'Personal data export recovery could not complete; it will retry',
        { context: 'PrivacyExportRecovery' },
      );
    } finally {
      this.running = false;
    }
  }
}
