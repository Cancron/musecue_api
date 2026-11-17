import type { ConfigService } from '@nestjs/config';

/** Durable background queues (BullMQ queue names / PostgreSQL `queue` values). */
export const EMAIL_QUEUE = 'email';
export const MAKEUP_AI_QUEUE = 'makeup-ai';
export const PRIVACY_EXPORT_QUEUE = 'privacy-export';

export const JOB_QUEUES = [
  EMAIL_QUEUE,
  MAKEUP_AI_QUEUE,
  PRIVACY_EXPORT_QUEUE,
] as const;
export type JobQueueName = (typeof JOB_QUEUES)[number];

/**
 * BullMQ worker options, unchanged from the original processors: one worker
 * per API instance, with the makeup AI queue's effective limits set per queue
 * (global concurrency and rate limit, shared by all instances).
 */
export const BULLMQ_WORKER_CONCURRENCY: Record<JobQueueName, number> = {
  [EMAIL_QUEUE]: 1,
  [MAKEUP_AI_QUEUE]: 8,
  [PRIVACY_EXPORT_QUEUE]: 2,
};

export interface QueueRateLimit {
  /** Jobs started per window. */
  max: number;
  durationMs: number;
}

export interface QueueRuntimeSettings {
  /** Jobs of this queue processed at the same time. */
  concurrency: number;
  /** Jobs started per window (makeup AI provider protection). */
  rateLimit?: QueueRateLimit;
}

function positiveInteger(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const value = Number(config.get<string>(key));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** AI_QUEUE_GLOBAL_CONCURRENCY (default 4). */
export function makeupAiGlobalConcurrency(config: ConfigService): number {
  return positiveInteger(config, 'AI_QUEUE_GLOBAL_CONCURRENCY', 4);
}

/** AI_QUEUE_RATE_LIMIT_MAX per AI_QUEUE_RATE_LIMIT_DURATION_MS (15 / 60 s). */
export function makeupAiRateLimit(config: ConfigService): QueueRateLimit {
  return {
    max: positiveInteger(config, 'AI_QUEUE_RATE_LIMIT_MAX', 15),
    durationMs: positiveInteger(
      config,
      'AI_QUEUE_RATE_LIMIT_DURATION_MS',
      60_000,
    ),
  };
}

/**
 * Limits of the in-process PostgreSQL worker (single API instance): the same
 * effective limits as BullMQ, i.e. the per-worker concurrency capped by the
 * configured global concurrency, and the configured AI rate limit.
 */
export function postgresQueueSettings(
  config: ConfigService,
): Record<JobQueueName, QueueRuntimeSettings> {
  return {
    [EMAIL_QUEUE]: { concurrency: BULLMQ_WORKER_CONCURRENCY[EMAIL_QUEUE] },
    [MAKEUP_AI_QUEUE]: {
      concurrency: Math.min(
        BULLMQ_WORKER_CONCURRENCY[MAKEUP_AI_QUEUE],
        makeupAiGlobalConcurrency(config),
      ),
      rateLimit: makeupAiRateLimit(config),
    },
    [PRIVACY_EXPORT_QUEUE]: {
      concurrency: BULLMQ_WORKER_CONCURRENCY[PRIVACY_EXPORT_QUEUE],
    },
  };
}
