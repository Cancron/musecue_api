import type { JobQueueName } from './job-queues';

/** Retry delay between attempts (BullMQ semantics). */
export interface JobBackoff {
  type: 'exponential' | 'fixed';
  /** Base delay in milliseconds. */
  delayMs: number;
  /** 0-1: the delay is randomly reduced by up to this fraction. */
  jitter?: number;
}

/** A job to run in the background, independent of the queue driver. */
export interface JobRequest<T> {
  /** Job type, e.g. `send-verification` or an AI operation. */
  name: string;
  data: T;
  /** Deduplication key: adding a job whose key already exists is a no-op. */
  jobId?: string;
  /**
   * The account the job belongs to. The PostgreSQL driver deletes the job
   * together with the account (account erasure), waiting or finished.
   */
  ownerId?: string;
  /** Total attempts, including the first. */
  attempts: number;
  backoff?: JobBackoff;
  /** Lower runs first (BullMQ semantics); omitted = no priority. */
  priority?: number;
  /**
   * Retention once the job completed / finally failed. `true` removes it at
   * once (for jobs carrying secrets); a number keeps that many (BullMQ). The
   * PostgreSQL driver keeps other jobs for a retention period instead.
   */
  removeOnComplete?: boolean | number;
  removeOnFail?: boolean | number;
}

/**
 * One attempt at running a job, as seen by a job handler. Both drivers (the
 * BullMQ processors and the PostgreSQL worker) provide it, so handlers decide
 * retries and domain transitions the same way in both modes.
 */
export interface JobExecution<T> {
  readonly id: string | undefined;
  readonly name: string;
  readonly data: T;
  /** Attempts that already failed before this one. */
  readonly attemptsMade: number;
  /** Total attempts allowed. */
  readonly maxAttempts: number;
  /** Do not retry this job, even if attempts remain. */
  discard(): void;
  /** Persists new job data (e.g. a counter) for later attempts. */
  updateData(data: T): Promise<void>;
  /**
   * Postpones the job for `delayMs` without using an attempt and pauses the
   * queue for that long (e.g. after a provider 429). Returns the error the
   * handler must throw to end this attempt.
   */
  rateLimit(delayMs: number): Promise<Error>;
}

/** Business processing of one queue, shared by both queue drivers. */
export interface JobHandler<T = unknown> {
  /** Runs one attempt. Throwing fails the attempt (retried while attempts remain). */
  process(job: JobExecution<T>): Promise<void>;
  /**
   * Called by the PostgreSQL driver when a job's last attempt ended without
   * the handler finishing it (the worker stopped while leasing it, or its
   * payload could not be read), so the domain record can be failed at once.
   */
  onAbandoned?(job: AbandonedJob<T>): Promise<void>;
}

export interface AbandonedJob<T> {
  id: string;
  name: string;
  /** Undefined when the payload could not be decrypted. */
  data: T | undefined;
  reason: 'INTERRUPTED' | 'UNREADABLE';
}

export type JobState =
  | 'waiting'
  | 'prioritized'
  | 'delayed'
  | 'active'
  | 'completed'
  | 'failed'
  | 'unknown';

/** Adds jobs to the selected queue driver. */
export abstract class JobDispatcher {
  abstract dispatch<T>(
    queue: JobQueueName,
    request: JobRequest<T>,
  ): Promise<void>;
}

/** Inspects jobs of the selected queue driver (backpressure and recovery). */
export abstract class JobInspector {
  /** Waiting, delayed, prioritized and active jobs of a queue. */
  abstract countBacklog(queue: JobQueueName): Promise<number>;

  /**
   * State of the job with `jobId`: `unknown` when it does not exist (never
   * added, or already removed). Throws when the driver is unavailable, so
   * callers never mistake an outage for a missing job.
   */
  abstract getJobState(queue: JobQueueName, jobId: string): Promise<JobState>;
}

/** Thrown by a handler (via JobExecution.rateLimit) to postpone a job. */
export class JobRateLimitedError extends Error {
  constructor(readonly delayMs: number) {
    super('The job was postponed by a rate limit');
    this.name = 'JobRateLimitedError';
  }
}

/** Delay before retry number `attemptsMade` (1 = first retry), as BullMQ computes it. */
export function backoffDelay(
  backoff: JobBackoff | undefined,
  attemptsMade: number,
  random: () => number = Math.random,
): number {
  if (!backoff || backoff.delayMs <= 0) return 0;
  const raw =
    backoff.type === 'exponential'
      ? Math.round(Math.pow(2, Math.max(0, attemptsMade - 1)) * backoff.delayMs)
      : backoff.delayMs;
  const jitter = Math.min(1, Math.max(0, backoff.jitter ?? 0));
  if (jitter === 0) return raw;
  const minimum = raw * (1 - jitter);
  return Math.floor(random() * raw * jitter + minimum);
}
