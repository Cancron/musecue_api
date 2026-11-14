import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import { PrismaService } from '../../common/services/prisma.service';
import { PrivacyExportStorageService } from '../../storage/privacy-export-storage.service';
import type { PrivacyExportJob } from '../interfaces/privacy-export.interface';
import {
  PRIVACY_EXPORT_INTERRUPTED_MESSAGE,
  PRIVACY_EXPORT_QUEUE,
} from '../privacy-export.constants';
import { failExport } from './privacy-export-lifecycle';

const MIN_GRACE_MS = 120_000;
const BATCH_SIZE = 100;

/**
 * Fails exports whose BullMQ job no longer exists or has already finished,
 * so they stop blocking the owner's next request (only one export may be
 * active per user) and clients stop polling. Healthy waiting, delayed or
 * active jobs are left alone; a Redis outage postpones recovery.
 */
@Injectable()
export class PrivacyExportRecoveryService
  implements OnModuleInit, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: PrivacyExportStorageService,
    @InjectQueue(PRIVACY_EXPORT_QUEUE)
    private readonly queue: Queue<PrivacyExportJob>,
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
          // Redis errors must abort this pass, not be treated as absent jobs.
          const job = await this.queue.getJob(item.id);
          const state = job ? await job.getState() : 'unknown';
          if (['failed', 'completed', 'unknown'].includes(state)) {
            const failed = await failExport(
              this.prisma,
              this.storage,
              item.id,
              PRIVACY_EXPORT_INTERRUPTED_MESSAGE,
              { updatedAt: item.updatedAt },
            );
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
