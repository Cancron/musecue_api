import { Injectable } from '@nestjs/common';
import type { InfrastructureJobStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../common/services/prisma.service';
import {
  decryptSecret,
  encryptSecret,
  SECRET_PURPOSES,
} from '../../../common/security/derived-secrets';
import type { JobQueueName } from '../job-queues';
import {
  backoffDelay,
  type JobBackoff,
  type JobRequest,
  type JobState,
} from '../job.types';

/** A job leased by this worker. */
export interface ClaimedJob {
  id: string;
  queue: string;
  name: string;
  jobKey: string | null;
  payload: string;
  priority: number;
  attemptsMade: number;
  maxAttempts: number;
  backoff: JobBackoff | undefined;
  removeOnComplete: boolean;
  removeOnFail: boolean;
  leaseToken: string;
}

/** A job whose lease expired on its last attempt (the worker stopped). */
export interface ExhaustedJob {
  id: string;
  queue: string;
  name: string;
  jobKey: string | null;
  payload: string | null;
}

interface ClaimedRow {
  id: string;
  queue: string;
  name: string;
  jobKey: string | null;
  payload: string | null;
  priority: number;
  attemptsMade: number;
  maxAttempts: number;
  backoffType: string | null;
  backoffDelayMs: number;
  backoffJitter: number;
  removeOnComplete: boolean;
  removeOnFail: boolean;
}

interface ExpiredRow {
  id: string;
  queue: string;
  name: string;
  jobKey: string | null;
  payload: string | null;
  attemptsMade: number;
  maxAttempts: number;
  backoffType: string | null;
  backoffDelayMs: number;
  backoffJitter: number;
  removeOnFail: boolean;
}

const ERROR_MAX_LENGTH = 200;

/** Error class and code only: messages can contain addresses or paths. */
export function describeJobError(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (typeof error.code === 'string' || typeof error.code === 'number')
      ? ` (${String(error.code)})`
      : '';
  return `${name}${code}`.slice(0, ERROR_MAX_LENGTH);
}

function toBackoff(row: {
  backoffType: string | null;
  backoffDelayMs: number;
  backoffJitter: number;
}): JobBackoff | undefined {
  if (row.backoffType !== 'exponential' && row.backoffType !== 'fixed') {
    return undefined;
  }
  return {
    type: row.backoffType,
    delayMs: Number(row.backoffDelayMs),
    jitter: Number(row.backoffJitter),
  };
}

/**
 * Persistence of the PostgreSQL queue driver (InfrastructureJob). Every
 * state change of a leased job is fenced by its lease token, so a worker
 * whose lease expired and was taken over can no longer change the job.
 * Payloads are encrypted (AES-256-GCM, key derived from JWT_REFRESH_SECRET)
 * and bound to their row. A job with an owner is deleted with the owner's
 * account (foreign key ON DELETE CASCADE); a job added for an account that
 * no longer exists is refused.
 */
@Injectable()
export class PostgresJobStore {
  constructor(private readonly prisma: PrismaService) {}

  encodePayload(queue: string, id: string, data: unknown): string {
    return encryptSecret(
      SECRET_PURPOSES.JOB_PAYLOAD,
      JSON.stringify(data ?? null),
      `${queue}:${id}`,
    );
  }

  decodePayload(queue: string, id: string, payload: string): unknown {
    return JSON.parse(
      decryptSecret(SECRET_PURPOSES.JOB_PAYLOAD, payload, `${queue}:${id}`),
    ) as unknown;
  }

  /** Adds a job; returns false when a job with the same key already exists. */
  async enqueue<T>(
    queue: JobQueueName,
    request: JobRequest<T>,
    now: Date = new Date(),
  ): Promise<boolean> {
    const id = randomUUID();
    const { count } = await this.prisma.infrastructureJob.createMany({
      data: [
        {
          id,
          authId: request.ownerId ?? null,
          queue,
          name: request.name,
          jobKey: request.jobId ?? null,
          payload: this.encodePayload(queue, id, request.data),
          priority: request.priority ?? 0,
          maxAttempts: Math.max(1, Math.floor(request.attempts)),
          backoffType: request.backoff?.type ?? null,
          backoffDelayMs: Math.max(
            0,
            Math.round(request.backoff?.delayMs ?? 0),
          ),
          backoffJitter: Math.min(1, Math.max(0, request.backoff?.jitter ?? 0)),
          removeOnComplete: request.removeOnComplete === true,
          removeOnFail: request.removeOnFail === true,
          availableAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ],
      // INSERT ... ON CONFLICT DO NOTHING: the (queue, jobKey) key
      // deduplicates like BullMQ's jobId.
      skipDuplicates: true,
    });
    return count === 1;
  }

  /**
   * Leases up to `limit` due jobs of `queue`, highest priority (lowest
   * number) first. SKIP LOCKED lets concurrent claims take different jobs.
   */
  async claim(
    queue: string,
    limit: number,
    leaseMs: number,
    now: Date = new Date(),
  ): Promise<ClaimedJob[]> {
    if (limit <= 0) return [];
    const leaseToken = randomUUID();
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const rows = await this.prisma.$queryRaw<ClaimedRow[]>`
      UPDATE "InfrastructureJob" AS j
      SET "status" = 'ACTIVE',
          "leaseToken" = ${leaseToken},
          "leaseExpiresAt" = ${leaseUntil},
          "startedAt" = ${now},
          "updatedAt" = ${now}
      FROM (
        SELECT "id" FROM "InfrastructureJob"
        WHERE "queue" = ${queue}
          AND "status" = 'WAITING'
          AND "availableAt" <= ${now}
        ORDER BY "priority" ASC, "availableAt" ASC, "createdAt" ASC, "id" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      ) AS due
      WHERE j."id" = due."id"
      RETURNING j."id", j."queue", j."name", j."jobKey", j."payload",
        j."priority", j."attemptsMade", j."maxAttempts", j."backoffType",
        j."backoffDelayMs", j."backoffJitter", j."removeOnComplete",
        j."removeOnFail"
    `;
    return rows
      .filter((row): row is ClaimedRow & { payload: string } =>
        Boolean(row.payload),
      )
      .map((row) => ({
        id: row.id,
        queue: row.queue,
        name: row.name,
        jobKey: row.jobKey,
        payload: row.payload,
        priority: Number(row.priority),
        attemptsMade: Number(row.attemptsMade),
        maxAttempts: Number(row.maxAttempts),
        backoff: toBackoff(row),
        removeOnComplete: row.removeOnComplete,
        removeOnFail: row.removeOnFail,
        leaseToken,
      }))
      .sort((a, b) => a.priority - b.priority);
  }

  /** Extends a lease; false when it was lost. */
  async renewLease(
    job: Pick<ClaimedJob, 'id' | 'leaseToken'>,
    leaseMs: number,
    now: Date = new Date(),
  ): Promise<boolean> {
    const { count } = await this.prisma.infrastructureJob.updateMany({
      where: { id: job.id, status: 'ACTIVE', leaseToken: job.leaseToken },
      data: {
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        updatedAt: now,
      },
    });
    return count === 1;
  }

  async updatePayload(job: ClaimedJob, data: unknown): Promise<boolean> {
    const { count } = await this.prisma.infrastructureJob.updateMany({
      where: { id: job.id, status: 'ACTIVE', leaseToken: job.leaseToken },
      data: {
        payload: this.encodePayload(job.queue, job.id, data),
        updatedAt: new Date(),
      },
    });
    return count === 1;
  }

  /** The attempt succeeded. The payload is no longer needed and is cleared. */
  async complete(job: ClaimedJob, now: Date = new Date()): Promise<boolean> {
    const where = {
      id: job.id,
      status: 'ACTIVE' as const,
      leaseToken: job.leaseToken,
    };
    if (job.removeOnComplete) {
      const { count } = await this.prisma.infrastructureJob.deleteMany({
        where,
      });
      return count === 1;
    }
    const { count } = await this.prisma.infrastructureJob.updateMany({
      where,
      data: {
        status: 'COMPLETED',
        payload: null,
        leaseToken: null,
        leaseExpiresAt: null,
        finishedAt: now,
        lastError: null,
        updatedAt: now,
      },
    });
    return count === 1;
  }

  /** The attempt failed and another one follows at `availableAt`. */
  async retry(
    job: ClaimedJob,
    availableAt: Date,
    error: unknown,
    now: Date = new Date(),
  ): Promise<boolean> {
    const { count } = await this.prisma.infrastructureJob.updateMany({
      where: { id: job.id, status: 'ACTIVE', leaseToken: job.leaseToken },
      data: {
        status: 'WAITING',
        attemptsMade: { increment: 1 },
        availableAt,
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: describeJobError(error),
        updatedAt: now,
      },
    });
    return count === 1;
  }

  /** The last attempt failed (or the job was discarded). */
  async fail(
    job: ClaimedJob,
    error: unknown,
    now: Date = new Date(),
  ): Promise<boolean> {
    const where = {
      id: job.id,
      status: 'ACTIVE' as const,
      leaseToken: job.leaseToken,
    };
    if (job.removeOnFail) {
      const { count } = await this.prisma.infrastructureJob.deleteMany({
        where,
      });
      return count === 1;
    }
    const { count } = await this.prisma.infrastructureJob.updateMany({
      where,
      data: {
        status: 'FAILED',
        attemptsMade: { increment: 1 },
        leaseToken: null,
        leaseExpiresAt: null,
        finishedAt: now,
        lastError: describeJobError(error),
        updatedAt: now,
      },
    });
    return count === 1;
  }

  /**
   * Returns a leased job to the queue without using an attempt: postponed by
   * a rate limit, or released by a worker that is shutting down.
   */
  async release(
    job: Pick<ClaimedJob, 'id' | 'leaseToken'>,
    availableAt: Date,
    now: Date = new Date(),
  ): Promise<boolean> {
    const { count } = await this.prisma.infrastructureJob.updateMany({
      where: { id: job.id, status: 'ACTIVE', leaseToken: job.leaseToken },
      data: {
        status: 'WAITING',
        availableAt,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      },
    });
    return count === 1;
  }

  /**
   * Jobs whose lease expired were interrupted (their worker stopped). Each
   * interruption uses an attempt: the job is retried after its backoff, or
   * fails when no attempt is left. Jobs in `excludeIds` (still running in
   * this process) are skipped. Returns the jobs that failed, so their domain
   * records can be failed as well.
   */
  async recoverExpiredLeases(
    now: Date = new Date(),
    excludeIds: ReadonlySet<string> = new Set(),
    batchSize = 100,
    random: () => number = Math.random,
  ): Promise<{ requeued: number; exhausted: ExhaustedJob[] }> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<ExpiredRow[]>`
        SELECT "id", "queue", "name", "jobKey", "payload", "attemptsMade",
          "maxAttempts", "backoffType", "backoffDelayMs", "backoffJitter",
          "removeOnFail"
        FROM "InfrastructureJob"
        WHERE "status" = 'ACTIVE' AND "leaseExpiresAt" < ${now}
        ORDER BY "leaseExpiresAt" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `;
      let requeued = 0;
      const exhausted: ExhaustedJob[] = [];
      for (const row of rows) {
        if (excludeIds.has(row.id)) continue;
        const attemptsMade = Number(row.attemptsMade) + 1;
        const error = 'LeaseExpired (INTERRUPTED)';
        if (attemptsMade < Number(row.maxAttempts)) {
          await tx.infrastructureJob.update({
            where: { id: row.id },
            data: {
              status: 'WAITING',
              attemptsMade,
              availableAt: new Date(
                now.getTime() +
                  backoffDelay(toBackoff(row), attemptsMade, random),
              ),
              leaseToken: null,
              leaseExpiresAt: null,
              lastError: error,
              updatedAt: now,
            },
          });
          requeued += 1;
          continue;
        }
        exhausted.push({
          id: row.id,
          queue: row.queue,
          name: row.name,
          jobKey: row.jobKey,
          payload: row.payload,
        });
        if (row.removeOnFail) {
          await tx.infrastructureJob.delete({ where: { id: row.id } });
        } else {
          await tx.infrastructureJob.update({
            where: { id: row.id },
            data: {
              status: 'FAILED',
              attemptsMade,
              leaseToken: null,
              leaseExpiresAt: null,
              finishedAt: now,
              lastError: error,
              updatedAt: now,
            },
          });
        }
      }
      return { requeued, exhausted };
    });
  }

  /** Removes finished jobs older than their retention period. */
  async removeFinished(
    completedBefore: Date,
    failedBefore: Date,
  ): Promise<number> {
    const [completed, failed] = await Promise.all([
      this.prisma.infrastructureJob.deleteMany({
        where: { status: 'COMPLETED', finishedAt: { lt: completedBefore } },
      }),
      this.prisma.infrastructureJob.deleteMany({
        where: { status: 'FAILED', finishedAt: { lt: failedBefore } },
      }),
    ]);
    return completed.count + failed.count;
  }

  countBacklog(queue: string): Promise<number> {
    return this.prisma.infrastructureJob.count({
      where: { queue, status: { in: ['WAITING', 'ACTIVE'] } },
    });
  }

  /** Jobs of any queue that still have to run (used by the startup check). */
  countPending(): Promise<number> {
    return this.prisma.infrastructureJob.count({
      where: { status: { in: ['WAITING', 'ACTIVE'] } },
    });
  }

  async getState(
    queue: string,
    jobKey: string,
    now: Date = new Date(),
  ): Promise<JobState> {
    const job = await this.prisma.infrastructureJob.findUnique({
      where: { queue_jobKey: { queue, jobKey } },
      select: { status: true, availableAt: true, priority: true },
    });
    if (!job) return 'unknown';
    return toJobState(job, now);
  }
}

export function toJobState(
  job: { status: InfrastructureJobStatus; availableAt: Date; priority: number },
  now: Date,
): JobState {
  switch (job.status) {
    case 'WAITING':
      if (job.availableAt.getTime() > now.getTime()) return 'delayed';
      return job.priority > 0 ? 'prioritized' : 'waiting';
    case 'ACTIVE':
      return 'active';
    case 'COMPLETED':
      return 'completed';
    case 'FAILED':
      return 'failed';
  }
}
