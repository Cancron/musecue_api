import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import { PrismaService } from '../../common/services/prisma.service';
import { failRun } from './run-lifecycle';
import type { MakeupAiJob } from './makeup.queue';

@Injectable()
export class MakeupRecoveryService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('makeup-ai') private readonly queue: Queue<MakeupAiJob>,
    private readonly config: ConfigService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
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
          // Redis errors must abort this pass, not be treated as absent jobs.
          const job = await this.queue.getJob(run.id);
          const state = job ? await job.getState() : 'unknown';
          if (['failed', 'completed', 'unknown'].includes(state)) {
            await failRun(
              this.prisma,
              run.id,
              'Processing was interrupted. Please try again.',
              run.updatedAt,
            );
          }
        }
        if (runs.length < 100) break;
        cursor = runs[runs.length - 1].id;
      }
    } catch {
      this.logger.warn('AI job recovery could not complete; it will retry', {
        context: 'MakeupRecovery',
      });
    } finally {
      this.running = false;
    }
  }
}
