import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';

export interface MakeupAiJob {
  runId: string;
  authId: string;
  sessionId: string;
  stepId?: string;
  question?: string;
}

@Injectable()
export class MakeupQueueService {
  constructor(
    @InjectQueue('makeup-ai') private readonly queue: Queue<MakeupAiJob>,
  ) {}

  async enqueue(operation: string, payload: MakeupAiJob): Promise<void> {
    await this.queue.add(operation, payload, {
      jobId: payload.runId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 500 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  }
}
