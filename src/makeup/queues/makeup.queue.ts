import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
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

@Injectable()
export class MakeupQueueService implements OnModuleInit {
  constructor(
    @InjectQueue('makeup-ai') private readonly queue: Queue<MakeupAiJob>,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await Promise.all([
      this.queue.setGlobalConcurrency(
        this.positiveInteger('AI_QUEUE_GLOBAL_CONCURRENCY', 4),
      ),
      this.queue.setGlobalRateLimit(
        this.positiveInteger('AI_QUEUE_RATE_LIMIT_MAX', 15),
        this.positiveInteger('AI_QUEUE_RATE_LIMIT_DURATION_MS', 60_000),
      ),
    ]);
  }

  async enqueue(operation: AiOperation, payload: MakeupAiJob): Promise<void> {
    const backlog = await this.queue.getJobCountByTypes(
      'wait',
      'active',
      'delayed',
      'prioritized',
    );
    if (backlog >= this.positiveInteger('AI_QUEUE_MAX_BACKLOG', 1_000)) {
      throw new AiQueueCapacityError();
    }
    await this.queue.add(operation, payload, {
      jobId: payload.runId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 3_000, jitter: 0.5 },
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
