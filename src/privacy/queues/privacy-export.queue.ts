import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  JobDispatcher,
  JobInspector,
} from '../../infrastructure/jobs/job.types';
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

/** Queues export archive builds on the selected queue driver. */
@Injectable()
export class PrivacyExportQueueService {
  constructor(
    private readonly jobs: JobDispatcher,
    private readonly inspector: JobInspector,
    private readonly config: ConfigService,
  ) {}

  async enqueue(job: PrivacyExportJob): Promise<void> {
    const backlog = await this.inspector.countBacklog(PRIVACY_EXPORT_QUEUE);
    if (backlog >= this.positiveInteger('PRIVACY_EXPORT_MAX_BACKLOG', 500)) {
      throw new PrivacyExportQueueCapacityError();
    }
    await this.jobs.dispatch(PRIVACY_EXPORT_QUEUE, {
      name: PRIVACY_EXPORT_JOB,
      data: job,
      // One job per export: a duplicate add is a no-op.
      jobId: job.exportId,
      ownerId: job.authId,
      attempts: PRIVACY_EXPORT_MAX_ATTEMPTS,
      backoff: { type: 'exponential', delayMs: 15_000, jitter: 0.5 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  }

  private positiveInteger(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
}
