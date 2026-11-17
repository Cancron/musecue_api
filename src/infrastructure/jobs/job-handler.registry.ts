import {
  Injectable,
  OnApplicationBootstrap,
  type Provider,
  type Type,
} from '@nestjs/common';
import type { JobQueueName } from './job-queues';
import type { JobExecution, JobHandler } from './job.types';

export class MissingJobHandlerError extends Error {
  constructor(queue: string) {
    super(`No job handler is registered for queue "${queue}"`);
    this.name = 'MissingJobHandlerError';
  }
}

/**
 * Maps each queue to its handler. Feature modules register their handlers
 * (registerJobHandler); the queue drivers only know queue names, so the
 * infrastructure never depends on feature modules. Jobs wait until the
 * application has fully started, so no job runs before its handler exists.
 */
@Injectable()
export class JobHandlerRegistry implements OnApplicationBootstrap {
  private readonly handlers = new Map<string, JobHandler>();
  private markReady!: () => void;
  private readonly ready = new Promise<void>((resolve) => {
    this.markReady = resolve;
  });

  register<T>(queue: JobQueueName, handler: JobHandler<T>): void {
    if (this.handlers.has(queue)) {
      throw new Error(`A job handler is already registered for "${queue}"`);
    }
    this.handlers.set(queue, handler as JobHandler);
  }

  onApplicationBootstrap(): void {
    this.markReady();
  }

  /** Resolves once the application has started (all handlers registered). */
  whenReady(): Promise<void> {
    return this.ready;
  }

  get(queue: string): JobHandler | undefined {
    return this.handlers.get(queue);
  }

  has(queue: string): boolean {
    return this.handlers.has(queue);
  }

  async run(queue: string, job: JobExecution<unknown>): Promise<void> {
    await this.ready;
    const handler = this.handlers.get(queue);
    if (!handler) throw new MissingJobHandlerError(queue);
    await handler.process(job);
  }
}

/** A provider that registers `handler` for `queue` when its module starts. */
export function registerJobHandler(
  queue: JobQueueName,
  handler: Type<JobHandler<never>>,
): Provider {
  return {
    provide: `JOB_HANDLER_REGISTRATION:${queue}`,
    inject: [JobHandlerRegistry, handler],
    useFactory: (registry: JobHandlerRegistry, instance: JobHandler) => {
      registry.register(queue, instance);
      return queue;
    },
  };
}
