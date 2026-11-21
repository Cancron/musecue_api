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
import { MAKEUP_AI_QUEUE } from '../../infrastructure/jobs/job-queues';
import { JobInspector } from '../../infrastructure/jobs/job.types';
import { MakeupCreditService } from '../makeup-credit.service';
import { failRun, INTERRUPTED_RUN_MESSAGE } from './run-lifecycle';

/**
 * Fails runs that are still waiting or processing long after their job
 * finished or disappeared (for example it was lost with the queue), so
 * clients stop polling. Inspects the selected queue driver; healthy waiting,
 * delayed or active jobs are left alone, and a queue outage postpones
 * recovery. Also settles AI usage that interrupted attempts left pending
 * once their run can no longer publish a result (never charged).
 */
@Injectable()
export class MakeupRecoveryService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobInspector,
    private readonly config: ConfigService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
    private readonly credits: MakeupCreditService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('NODE_ENV') === 'test') return;
    this.timer = setInterval(() => {
      void this.reconcile();
    }, 30_000);
    this.timer.unref();
    void this.reconcile();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const grace = Number(this.config.get<string>('AI_JOB_RECOVERY_GRACE_MS'));
      const graceMs =
        Number.isFinite(grace) && grace >= 120_000 ? grace : 120_000;
      // Cursor pagination prevents healthy old queued jobs from hiding orphans.
      let cursor: string | undefined;
      for (;;) {
        const runs = await this.prisma.aiRun.findMany({
          where: {
            status: { in: ['QUEUED', 'PROCESSING'] },
            updatedAt: { lt: new Date(Date.now() - graceMs) },
          },
          orderBy: { id: 'asc' },
          take: 100,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        for (const run of runs) {
          // Queue errors must abort this pass, not be treated as absent jobs.
          const state = await this.jobs.getJobState(MAKEUP_AI_QUEUE, run.id);
          if (['failed', 'completed', 'unknown'].includes(state)) {
            await failRun(
              this.prisma,
              run.id,
              INTERRUPTED_RUN_MESSAGE,
              run.updatedAt,
            );
          }
        }
        if (runs.length < 100) break;
        cursor = runs[runs.length - 1].id;
      }
      await this.credits.settleInterruptedUsage(new Date(Date.now() - graceMs));
    } catch {
      this.logger.warn('AI job recovery could not complete; it will retry', {
        context: 'MakeupRecovery',
      });
    } finally {
      this.running = false;
    }
  }
}
