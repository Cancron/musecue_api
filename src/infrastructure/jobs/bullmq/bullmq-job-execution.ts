import { Worker, type Job } from 'bullmq';
import type { JobExecution } from '../job.types';

/**
 * Adapts a BullMQ job to the driver-independent JobExecution. Properties are
 * read lazily from the job, exactly as the original processors read them.
 */
export function bullMqJobExecution<T>(
  job: Job<T>,
  worker: () => Worker | undefined,
): JobExecution<T> {
  return {
    get id() {
      return job.id;
    },
    get name() {
      return job.name;
    },
    get data() {
      return job.data;
    },
    get attemptsMade() {
      return job.attemptsMade;
    },
    get maxAttempts() {
      return job.opts.attempts ?? 1;
    },
    discard: () => job.discard(),
    updateData: (data: T) => job.updateData(data),
    rateLimit: async (delayMs: number) => {
      const current = worker();
      if (!current) throw new Error('The BullMQ worker is not running');
      // Pauses the queue for every worker; the job returns to the wait list
      // without using an attempt.
      await current.rateLimit(delayMs);
      return Worker.RateLimitError();
    },
  };
}
