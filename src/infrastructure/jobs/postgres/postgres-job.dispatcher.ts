import { Injectable } from '@nestjs/common';
import type { JobQueueName } from '../job-queues';
import {
  JobDispatcher,
  JobInspector,
  type JobRequest,
  type JobState,
} from '../job.types';
import { PostgresJobStore } from './postgres-job.store';

/** PostgreSQL queue driver (REDIS_ENABLED=false). */
@Injectable()
export class PostgresJobDispatcher extends JobDispatcher {
  constructor(private readonly store: PostgresJobStore) {
    super();
  }

  async dispatch<T>(queue: JobQueueName, request: JobRequest<T>) {
    // A duplicate key is a no-op, like BullMQ's jobId.
    await this.store.enqueue(queue, request);
  }
}

@Injectable()
export class PostgresJobInspector extends JobInspector {
  constructor(private readonly store: PostgresJobStore) {
    super();
  }

  countBacklog(queue: JobQueueName): Promise<number> {
    return this.store.countBacklog(queue);
  }

  getJobState(queue: JobQueueName, jobId: string): Promise<JobState> {
    return this.store.getState(queue, jobId);
  }
}
