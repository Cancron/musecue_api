import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import { JobHandlerRegistry } from '../job-handler.registry';
import {
  JOB_QUEUES,
  postgresQueueSettings,
  type JobQueueName,
  type QueueRuntimeSettings,
} from '../job-queues';
import {
  backoffDelay,
  JobRateLimitedError,
  type AbandonedJob,
  type JobExecution,
} from '../job.types';
import {
  describeJobError,
  PostgresJobStore,
  type ClaimedJob,
  type ExhaustedJob,
} from './postgres-job.store';

/** How often the worker looks for due jobs. */
export const POLL_INTERVAL_MS = 1_000;
/** A claimed job's lease lasts this long without renewal... */
export const JOB_LEASE_MS = 120_000;
/** ...and is renewed this often while the job runs. */
export const JOB_LEASE_RENEW_MS = 30_000;
/** Jobs with expired leases are recovered at most this often. */
export const LEASE_RECOVERY_INTERVAL_MS = 15_000;
/** Finished jobs are removed at most this often... */
export const JOB_CLEANUP_INTERVAL_MS = 10 * 60_000;
/** ...once completed for an hour... */
export const COMPLETED_JOB_RETENTION_MS = 60 * 60_000;
/** ...or failed for seven days (kept for operational diagnosis). */
export const FAILED_JOB_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** On shutdown, running jobs get this long to finish before they are released. */
const SHUTDOWN_GRACE_MS = 5_000;

interface RunningJob {
  job: ClaimedJob;
  done: Promise<void>;
}

/**
 * The in-process worker of the PostgreSQL queue driver (REDIS_ENABLED=false,
 * one API instance).
 *
 * Every second (never overlapping) it leases due jobs of each queue that has
 * a registered handler, within the queue's concurrency and rate limit, and
 * runs them with the same handlers as the BullMQ processors. Leases last 120
 * seconds and are renewed every 30 seconds; a job whose lease expired (the
 * process stopped) is retried or, after its last attempt, failed and handed
 * to the handler's onAbandoned. Retries use the job's backoff; a handler's
 * rate limit postpones the job without using an attempt and pauses its
 * queue. Finished jobs are removed after their retention period.
 */
@Injectable()
export class PostgresJobWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  /** Clock and randomness (replaceable in tests). */
  clock: () => Date = () => new Date();
  random: () => number = Math.random;

  private readonly settings: Record<JobQueueName, QueueRuntimeSettings>;
  private readonly running = new Map<string, Map<string, RunningJob>>();
  private readonly starts = new Map<string, number[]>();
  private readonly pausedUntil = new Map<string, number>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private renewTimer?: ReturnType<typeof setInterval>;
  private polling = false;
  private stopping = false;
  private lastRecovery = 0;
  private lastCleanup = 0;
  private lastPollFailureLog = 0;

  constructor(
    private readonly store: PostgresJobStore,
    private readonly registry: JobHandlerRegistry,
    config: ConfigService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {
    this.settings = postgresQueueSettings(config);
    for (const queue of JOB_QUEUES) this.running.set(queue, new Map());
  }

  /**
   * Starts polling once the application is up, in every environment
   * (including NODE_ENV=test), like the BullMQ workers in Redis mode: queued
   * jobs must never be left unprocessed because of the environment name.
   */
  onApplicationBootstrap(): void {
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** Starts polling (idempotent). */
  start(): void {
    if (this.pollTimer) return;
    this.stopping = false;
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref();
    this.renewTimer = setInterval(() => {
      void this.renewLeases();
    }, JOB_LEASE_RENEW_MS);
    this.renewTimer.unref();
    void this.pollOnce();
  }

  /**
   * Stops polling, gives running jobs a moment to finish, then releases the
   * rest back to the queue (without using an attempt).
   */
  async stop(graceMs: number = SHUTDOWN_GRACE_MS): Promise<void> {
    this.stopping = true;
    clearInterval(this.pollTimer);
    clearInterval(this.renewTimer);
    this.pollTimer = undefined;
    this.renewTimer = undefined;
    const running = this.allRunning();
    if (!running.length) return;
    await Promise.race([
      Promise.allSettled(running.map((item) => item.done)),
      new Promise((resolve) => setTimeout(resolve, graceMs).unref()),
    ]);
    const now = this.clock();
    await Promise.allSettled(
      this.allRunning().map((item) => this.store.release(item.job, now, now)),
    );
  }

  /**
   * One polling cycle: recovers expired leases (periodically), starts due
   * jobs and removes old finished jobs (periodically). Cycles never overlap.
   * Returns the number of jobs started.
   */
  async pollOnce(): Promise<number> {
    if (this.polling || this.stopping) return 0;
    this.polling = true;
    let started = 0;
    try {
      const now = this.clock();
      if (now.getTime() - this.lastRecovery >= LEASE_RECOVERY_INTERVAL_MS) {
        this.lastRecovery = now.getTime();
        await this.recoverExpiredLeases(now);
      }
      for (const queue of JOB_QUEUES) {
        started += await this.startDueJobs(queue);
      }
      if (now.getTime() - this.lastCleanup >= JOB_CLEANUP_INTERVAL_MS) {
        this.lastCleanup = now.getTime();
        await this.store.removeFinished(
          new Date(now.getTime() - COMPLETED_JOB_RETENTION_MS),
          new Date(now.getTime() - FAILED_JOB_RETENTION_MS),
        );
      }
    } catch (error) {
      // E.g. the database is briefly unreachable: try again next cycle.
      const now = Date.now();
      if (now - this.lastPollFailureLog > 60_000) {
        this.lastPollFailureLog = now;
        this.logger.warn('PostgreSQL job polling failed; it will retry', {
          context: 'PostgresJobWorker',
          error: describeJobError(error),
        });
      }
    } finally {
      this.polling = false;
    }
    return started;
  }

  /**
   * Polls until no job is running and none is due (for tests and scripts).
   * Delayed retries that are not due yet are left waiting.
   */
  async runUntilIdle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const started = await this.pollOnce();
      const running = this.allRunning();
      if (!started && !running.length) return;
      if (Date.now() > deadline) {
        throw new Error('Background jobs did not finish in time');
      }
      if (running.length) {
        await Promise.race([
          Promise.allSettled(running.map((item) => item.done)),
          new Promise((resolve) => setTimeout(resolve, 50)),
        ]);
      }
    }
  }

  /** Jobs currently running in this process, per queue. */
  runningCount(queue: JobQueueName): number {
    return this.running.get(queue)?.size ?? 0;
  }

  /** Renews the lease of every running job (every 30 seconds). */
  async renewLeases(): Promise<void> {
    const now = this.clock();
    await Promise.all(
      this.allRunning().map(async ({ job }) => {
        try {
          const renewed = await this.store.renewLease(job, JOB_LEASE_MS, now);
          if (!renewed) {
            this.logger.warn('A running job lost its lease', {
              context: 'PostgresJobWorker',
              queue: job.queue,
              jobId: job.id,
            });
          }
        } catch (error) {
          this.logger.warn('A job lease could not be renewed; will retry', {
            context: 'PostgresJobWorker',
            queue: job.queue,
            jobId: job.id,
            error: describeJobError(error),
          });
        }
      }),
    );
  }

  private allRunning(): RunningJob[] {
    return [...this.running.values()].flatMap((jobs) => [...jobs.values()]);
  }

  private async recoverExpiredLeases(now: Date): Promise<void> {
    const local = new Set(this.allRunning().map(({ job }) => job.id));
    const { requeued, exhausted } = await this.store.recoverExpiredLeases(
      now,
      local,
      100,
      this.random,
    );
    if (requeued) {
      this.logger.warn('Requeued interrupted background jobs', {
        context: 'PostgresJobWorker',
        count: requeued,
      });
    }
    for (const job of exhausted) {
      this.logger.error('An interrupted background job used its last attempt', {
        context: 'PostgresJobWorker',
        queue: job.queue,
        jobId: job.id,
      });
      await this.abandon(job, 'INTERRUPTED');
    }
  }

  /** Starts as many due jobs of `queue` as its limits allow. */
  private async startDueJobs(queue: JobQueueName): Promise<number> {
    // A cycle that was already running when stop() began claims no more.
    if (this.stopping || !this.registry.has(queue)) return 0;
    const settings = this.settings[queue];
    const running = this.running.get(queue)!;
    const nowMs = this.clock().getTime();
    if ((this.pausedUntil.get(queue) ?? 0) > nowMs) return 0;
    let slots = settings.concurrency - running.size;
    if (settings.rateLimit) {
      const windowStart = nowMs - settings.rateLimit.durationMs;
      const recent = (this.starts.get(queue) ?? []).filter(
        (time) => time > windowStart,
      );
      this.starts.set(queue, recent);
      slots = Math.min(slots, settings.rateLimit.max - recent.length);
    }
    if (slots <= 0) return 0;
    const claimed = await this.store.claim(
      queue,
      slots,
      JOB_LEASE_MS,
      this.clock(),
    );
    for (const job of claimed) {
      if (settings.rateLimit) this.starts.get(queue)!.push(nowMs);
      const entry: RunningJob = {
        job,
        done: Promise.resolve(),
      };
      running.set(job.id, entry);
      entry.done = this.execute(queue, job).finally(() => {
        running.delete(job.id);
      });
    }
    return claimed.length;
  }

  private async execute(queue: JobQueueName, job: ClaimedJob): Promise<void> {
    let data: unknown;
    try {
      data = this.store.decodePayload(queue, job.id, job.payload);
    } catch (error) {
      this.logger.error('A background job payload could not be read', {
        context: 'PostgresJobWorker',
        queue,
        jobId: job.id,
        error: describeJobError(error),
      });
      await this.settle(() => this.store.fail(job, error, this.clock()));
      await this.abandon(job, 'UNREADABLE');
      return;
    }

    let discarded = false;
    const execution: JobExecution<unknown> = {
      id: job.jobKey ?? job.id,
      name: job.name,
      get data() {
        return data;
      },
      attemptsMade: job.attemptsMade,
      maxAttempts: job.maxAttempts,
      discard: () => {
        discarded = true;
      },
      updateData: async (next: unknown) => {
        data = next;
        await this.store.updatePayload(job, next);
      },
      rateLimit: (delayMs: number) =>
        Promise.resolve(new JobRateLimitedError(delayMs)),
    };

    try {
      await this.registry.run(queue, execution);
    } catch (error) {
      const now = this.clock();
      if (error instanceof JobRateLimitedError) {
        const until = now.getTime() + Math.max(0, error.delayMs);
        this.pausedUntil.set(
          queue,
          Math.max(this.pausedUntil.get(queue) ?? 0, until),
        );
        await this.settle(() => this.store.release(job, new Date(until), now));
        return;
      }
      const attemptsMade = job.attemptsMade + 1;
      if (discarded || attemptsMade >= job.maxAttempts) {
        await this.settle(() => this.store.fail(job, error, now));
        return;
      }
      const delay = backoffDelay(job.backoff, attemptsMade, this.random);
      await this.settle(() =>
        this.store.retry(job, new Date(now.getTime() + delay), error, now),
      );
      return;
    }
    await this.settle(() => this.store.complete(job, this.clock()));
  }

  /**
   * Records a job outcome. If that fails (e.g. the database is unreachable),
   * the lease expires and the job is recovered as interrupted.
   */
  private async settle(write: () => Promise<boolean>): Promise<void> {
    try {
      await write();
    } catch (error) {
      this.logger.warn('A job outcome could not be recorded', {
        context: 'PostgresJobWorker',
        error: describeJobError(error),
      });
    }
  }

  private async abandon(
    job: ExhaustedJob | ClaimedJob,
    reason: AbandonedJob<unknown>['reason'],
  ): Promise<void> {
    const handler = this.registry.get(job.queue);
    if (!handler?.onAbandoned) return;
    let data: unknown;
    if (reason === 'INTERRUPTED' && job.payload) {
      try {
        data = this.store.decodePayload(job.queue, job.id, job.payload);
      } catch {
        data = undefined;
      }
    }
    try {
      await this.registry.whenReady();
      await handler.onAbandoned({
        id: job.jobKey ?? job.id,
        name: job.name,
        data,
        reason,
      });
    } catch (error) {
      // The domain recovery sweeps fail the record later.
      this.logger.warn('An abandoned job could not be settled', {
        context: 'PostgresJobWorker',
        queue: job.queue,
        jobId: job.id,
        error: describeJobError(error),
      });
    }
  }
}
