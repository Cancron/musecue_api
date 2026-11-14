import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { PrivacyExportJob } from '../interfaces/privacy-export.interface';
import {
  PRIVACY_EXPORT_JOB,
  PRIVACY_EXPORT_MAX_ATTEMPTS,
  PRIVACY_EXPORT_QUEUE,
} from '../privacy-export.constants';

export class PrivacyExportQueueCapacityError extends Error {
  constructor() {
    super('Privacy export queue has reached its configured backlog limit');
    this.name = 'PrivacyExportQueueCapacityError';
  }
}

@Injectable()
export class PrivacyExportQueueService {
  constructor(
    @InjectQueue(PRIVACY_EXPORT_QUEUE)
    private readonly queue: Queue<PrivacyExportJob>,
    private readonly config: ConfigService,
  ) {}

  async enqueue(job: PrivacyExportJob): Promise<void> {
    const backlog = await this.queue.getJobCountByTypes(
      'wait',
      'active',
      'delayed',
      'prioritized',
    );
    if (backlog >= this.positiveInteger('PRIVACY_EXPORT_MAX_BACKLOG', 500)) {
      throw new PrivacyExportQueueCapacityError();
    }
    await this.queue.add(PRIVACY_EXPORT_JOB, job, {
      // One BullMQ job per export: a duplicate add is a no-op.
      jobId: job.exportId,
      attempts: PRIVACY_EXPORT_MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: 15_000, jitter: 0.5 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  }

  private positiveInteger(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
}
