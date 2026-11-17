import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MAKEUP_AI_QUEUE } from '../../infrastructure/jobs/job-queues';
import {
  JobDispatcher,
  JobInspector,
} from '../../infrastructure/jobs/job.types';
import type { AiOperation } from '../interfaces/makeup.interface';

export interface MakeupAiJob {
  runId: string;
  authId: string;
  sessionId: string;
  stepId?: string;
  imageId?: string;
  question?: string;
  rateLimitDeferrals?: number;
}

export class AiQueueCapacityError extends Error {
  constructor() {
    super('Makeup AI queue has reached its configured backlog limit');
    this.name = 'AiQueueCapacityError';
  }
}

/**
 * Queues makeup AI runs on the selected queue driver. Global concurrency and
 * the provider rate limit (AI_QUEUE_*) are applied by the driver.
 */
@Injectable()
export class MakeupQueueService {
  constructor(
    private readonly jobs: JobDispatcher,
    private readonly inspector: JobInspector,
    private readonly config: ConfigService,
  ) {}

  async enqueue(operation: AiOperation, payload: MakeupAiJob): Promise<void> {
    const backlog = await this.inspector.countBacklog(MAKEUP_AI_QUEUE);
    if (backlog >= this.positiveInteger('AI_QUEUE_MAX_BACKLOG', 1_000)) {
      throw new AiQueueCapacityError();
    }
    await this.jobs.dispatch(MAKEUP_AI_QUEUE, {
      name: operation,
      data: payload,
      // One job per run: a duplicate add is a no-op.
      jobId: payload.runId,
      ownerId: payload.authId,
      attempts: 3,
      backoff: { type: 'exponential', delayMs: 3_000, jitter: 0.5 },
      priority: this.priority(operation),
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  }

  private priority(operation: AiOperation): number {
    return operation === 'VISION_CHECK' || operation === 'GUIDE_QUESTION'
      ? 1
      : operation === 'GUIDE_GENERATION'
        ? 5
        : 10;
  }

  private positiveInteger(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
}
