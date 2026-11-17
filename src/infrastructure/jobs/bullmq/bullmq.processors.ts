import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  BULLMQ_WORKER_CONCURRENCY,
  EMAIL_QUEUE,
  MAKEUP_AI_QUEUE,
  PRIVACY_EXPORT_QUEUE,
  type JobQueueName,
} from '../job-queues';
import { JobHandlerRegistry } from '../job-handler.registry';
import { bullMqJobExecution } from './bullmq-job-execution';

/**
 * Thin BullMQ workers: each hands its jobs to the queue's registered handler
 * (the same handler the PostgreSQL worker calls). Worker options are those of
 * the original processors.
 *
 * @Injectable() emits the constructor metadata the subclasses inherit, so
 * Nest injects the registry into each of them.
 */
@Injectable()
abstract class RegisteredHandlerProcessor extends WorkerHost {
  protected abstract readonly queue: JobQueueName;

  constructor(private readonly registry: JobHandlerRegistry) {
    super();
  }

  async process(job: Job<unknown>): Promise<void> {
    await this.registry.run(
      this.queue,
      bullMqJobExecution(job, () => this.worker),
    );
  }
}

@Processor(EMAIL_QUEUE, {
  concurrency: BULLMQ_WORKER_CONCURRENCY[EMAIL_QUEUE],
})
export class EmailBullMqProcessor extends RegisteredHandlerProcessor {
  protected readonly queue = EMAIL_QUEUE;
}

@Processor(MAKEUP_AI_QUEUE, {
  concurrency: BULLMQ_WORKER_CONCURRENCY[MAKEUP_AI_QUEUE],
  // The effective limit is the queue's global rate limit (set at startup);
  // a worker limiter is required for Worker.rateLimit() on provider 429s.
  limiter: { max: 1_000_000, duration: 1_000 },
})
export class MakeupAiBullMqProcessor extends RegisteredHandlerProcessor {
  protected readonly queue = MAKEUP_AI_QUEUE;
}

@Processor(PRIVACY_EXPORT_QUEUE, {
  concurrency: BULLMQ_WORKER_CONCURRENCY[PRIVACY_EXPORT_QUEUE],
})
export class PrivacyExportBullMqProcessor extends RegisteredHandlerProcessor {
  protected readonly queue = PRIVACY_EXPORT_QUEUE;
}
