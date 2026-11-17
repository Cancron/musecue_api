import { getQueueToken } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import {
  EMAIL_QUEUE,
  MAKEUP_AI_QUEUE,
  PRIVACY_EXPORT_QUEUE,
  type JobQueueName,
} from '../job-queues';
import {
  JobDispatcher,
  JobInspector,
  type JobRequest,
  type JobState,
} from '../job.types';

/** The BullMQ queue of every JobQueueName. */
@Injectable()
export class BullMqQueues {
  constructor(
    @Inject(getQueueToken(EMAIL_QUEUE)) private readonly email: Queue,
    @Inject(getQueueToken(MAKEUP_AI_QUEUE)) private readonly makeupAi: Queue,
    @Inject(getQueueToken(PRIVACY_EXPORT_QUEUE))
    private readonly privacyExport: Queue,
  ) {}

  get(queue: JobQueueName): Queue {
    switch (queue) {
      case EMAIL_QUEUE:
        return this.email;
      case MAKEUP_AI_QUEUE:
        return this.makeupAi;
      case PRIVACY_EXPORT_QUEUE:
        return this.privacyExport;
    }
  }
}

/** Maps a JobRequest to BullMQ options, including only the options given. */
export function toBullMqOptions(request: JobRequest<unknown>): JobsOptions {
  const options: JobsOptions = {};
  if (request.jobId !== undefined) options.jobId = request.jobId;
  options.attempts = request.attempts;
  if (request.backoff) {
    options.backoff = {
      type: request.backoff.type,
      delay: request.backoff.delayMs,
      ...(request.backoff.jitter !== undefined
        ? { jitter: request.backoff.jitter }
        : {}),
    };
  }
  if (request.priority !== undefined) options.priority = request.priority;
  if (request.removeOnComplete !== undefined) {
    options.removeOnComplete = request.removeOnComplete;
  }
  if (request.removeOnFail !== undefined) {
    options.removeOnFail = request.removeOnFail;
  }
  return options;
}

/** BullMQ queue driver (REDIS_ENABLED=true). */
@Injectable()
export class BullMqJobDispatcher extends JobDispatcher {
  constructor(private readonly queues: BullMqQueues) {
    super();
  }

  async dispatch<T>(queue: JobQueueName, request: JobRequest<T>) {
    await this.queues
      .get(queue)
      .add(request.name, request.data, toBullMqOptions(request));
  }
}

@Injectable()
export class BullMqJobInspector extends JobInspector {
  constructor(private readonly queues: BullMqQueues) {
    super();
  }

  countBacklog(queue: JobQueueName): Promise<number> {
    return this.queues
      .get(queue)
      .getJobCountByTypes('wait', 'active', 'delayed', 'prioritized');
  }

  async getJobState(queue: JobQueueName, jobId: string): Promise<JobState> {
    const job = await this.queues.get(queue).getJob(jobId);
    if (!job) return 'unknown';
    const state = await job.getState();
    switch (state) {
      case 'waiting':
      case 'prioritized':
      case 'delayed':
      case 'active':
      case 'completed':
      case 'failed':
        return state;
      case 'waiting-children':
        return 'waiting';
      default:
        return 'unknown';
    }
  }
}
