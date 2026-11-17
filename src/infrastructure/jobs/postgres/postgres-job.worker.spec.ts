import { ConfigService } from '@nestjs/config';
import { mock, type MockProxy } from 'jest-mock-extended';
import type { Logger } from 'winston';
import { SecretDecryptionError } from '../../../common/security/derived-secrets';
import { JobHandlerRegistry } from '../job-handler.registry';
import type { JobExecution, JobHandler } from '../job.types';
import type { ClaimedJob, PostgresJobStore } from './postgres-job.store';
import {
  COMPLETED_JOB_RETENTION_MS,
  FAILED_JOB_RETENTION_MS,
  JOB_LEASE_MS,
  PostgresJobWorker,
} from './postgres-job.worker';

const NOW = new Date('2026-11-20T12:00:00.000Z');

function claimed(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: 'job-1',
    queue: 'email',
    name: 'send-verification',
    jobKey: null,
    payload: JSON.stringify({ type: 'verification' }),
    priority: 0,
    attemptsMade: 0,
    maxAttempts: 3,
    backoff: { type: 'exponential', delayMs: 2_000 },
    removeOnComplete: false,
    removeOnFail: false,
    leaseToken: 'lease',
    ...overrides,
  };
}

describe('PostgresJobWorker', () => {
  let store: MockProxy<PostgresJobStore>;
  let registry: JobHandlerRegistry;
  let worker: PostgresJobWorker;
  let handlers: Record<string, MockProxy<Required<JobHandler>>>;

  function setup(config: Record<string, string> = {}) {
    store = mock<PostgresJobStore>();
    store.decodePayload.mockImplementation(
      (_queue, _id, payload) => JSON.parse(payload) as unknown,
    );
    store.claim.mockResolvedValue([]);
    store.recoverExpiredLeases.mockResolvedValue({
      requeued: 0,
      exhausted: [],
    });
    store.removeFinished.mockResolvedValue(0);
    for (const method of [
      'complete',
      'retry',
      'fail',
      'release',
      'renewLease',
      'updatePayload',
    ] as const) {
      store[method].mockResolvedValue(true);
    }
    registry = new JobHandlerRegistry();
    handlers = {};
    for (const queue of ['email', 'makeup-ai'] as const) {
      handlers[queue] = mock<Required<JobHandler>>();
      registry.register(queue, handlers[queue]);
    }
    registry.onApplicationBootstrap();
    worker = new PostgresJobWorker(
      store,
      registry,
      new ConfigService({ NODE_ENV: 'test', ...config }),
      mock<Logger>(),
    );
    worker.clock = () => NOW;
    worker.random = () => 0;
  }

  /** Claims `job` on the next poll of its queue, then nothing. */
  function nextClaim(job: ClaimedJob) {
    let claimedOnce = false;
    store.claim.mockImplementation((queue) => {
      if (queue !== job.queue || claimedOnce) return Promise.resolve([]);
      claimedOnce = true;
      return Promise.resolve([job]);
    });
  }

  beforeEach(() => setup());

  it('starts polling on its own at bootstrap, even with NODE_ENV=test', async () => {
    // The worker is configured with NODE_ENV=test (see setup()).
    worker.onApplicationBootstrap();
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(store.claim.mock.calls.map(([queue]) => queue)).toEqual([
        'email',
        'makeup-ai',
      ]);
      // start() is idempotent: a second call adds no second poller.
      worker.start();
      await new Promise((resolve) => setImmediate(resolve));
      expect(store.claim.mock.calls).toHaveLength(2);
    } finally {
      await worker.stop(0);
    }
  });

  it('claims only queues with a registered handler, within their concurrency, with a 120 s lease', async () => {
    await worker.pollOnce();

    expect(store.claim.mock.calls.map(([queue]) => queue)).toEqual([
      'email',
      'makeup-ai',
    ]);
    expect(store.claim.mock.calls).toContainEqual([
      'email',
      1,
      JOB_LEASE_MS,
      NOW,
    ]);
    // BullMQ worker concurrency 8, capped by AI_QUEUE_GLOBAL_CONCURRENCY (4).
    expect(store.claim.mock.calls).toContainEqual([
      'makeup-ai',
      4,
      JOB_LEASE_MS,
      NOW,
    ]);
  });

  it('completes a job whose handler succeeded', async () => {
    const job = claimed();
    nextClaim(job);
    handlers.email.process.mockResolvedValue(undefined);

    await worker.runUntilIdle();

    const execution = handlers.email.process.mock.calls[0][0];
    expect(execution).toMatchObject({
      id: 'job-1',
      name: 'send-verification',
      data: { type: 'verification' },
      attemptsMade: 0,
      maxAttempts: 3,
    });
    expect(store.complete.mock.calls).toContainEqual([job, NOW]);
    expect(store.retry.mock.calls).toHaveLength(0);
  });

  it('retries a failed attempt after its exponential backoff', async () => {
    const job = claimed({ attemptsMade: 1 });
    nextClaim(job);
    const error = new Error('SMTP down');
    handlers.email.process.mockRejectedValue(error);

    await worker.runUntilIdle();

    // Second failure: 2 s * 2^(2-1).
    expect(store.retry.mock.calls).toContainEqual([
      job,
      new Date(NOW.getTime() + 4_000),
      error,
      NOW,
    ]);
    expect(store.fail.mock.calls).toHaveLength(0);
  });

  it('fails the job after its last attempt', async () => {
    const job = claimed({ attemptsMade: 2 });
    nextClaim(job);
    handlers.email.process.mockRejectedValue(new Error('SMTP down'));

    await worker.runUntilIdle();

    expect(store.fail.mock.calls).toContainEqual([job, expect.any(Error), NOW]);
    expect(store.retry.mock.calls).toHaveLength(0);
  });

  it('fails a discarded job at once, whatever attempts remain', async () => {
    const job = claimed();
    nextClaim(job);
    handlers.email.process.mockImplementation(
      (execution: JobExecution<unknown>) => {
        execution.discard();
        return Promise.reject(new Error('permanent'));
      },
    );

    await worker.runUntilIdle();

    expect(store.fail.mock.calls).toHaveLength(1);
    expect(store.retry.mock.calls).toHaveLength(0);
  });

  it('persists updated job data', async () => {
    const job = claimed();
    nextClaim(job);
    handlers.email.process.mockImplementation(async (execution) => {
      await execution.updateData({ deferrals: 1 });
      expect(execution.data).toEqual({ deferrals: 1 });
    });

    await worker.runUntilIdle();

    expect(store.updatePayload.mock.calls).toContainEqual([
      job,
      { deferrals: 1 },
    ]);
  });

  it('postpones a rate-limited job without using an attempt and pauses its queue', async () => {
    const job = claimed({ queue: 'makeup-ai', name: 'VISION_CHECK' });
    nextClaim(job);
    handlers['makeup-ai'].process.mockImplementation(async (execution) => {
      throw await execution.rateLimit(30_000);
    });

    await worker.runUntilIdle();

    expect(store.release.mock.calls).toContainEqual([
      job,
      new Date(NOW.getTime() + 30_000),
      NOW,
    ]);
    expect(store.retry.mock.calls).toHaveLength(0);
    expect(store.fail.mock.calls).toHaveLength(0);

    // The queue stays paused until the delay has passed.
    store.claim.mockClear();
    await worker.pollOnce();
    expect(store.claim.mock.calls.map(([queue]) => queue)).toEqual(['email']);
    worker.clock = () => new Date(NOW.getTime() + 30_001);
    await worker.pollOnce();
    expect(store.claim.mock.calls.map(([queue]) => queue)).toContain(
      'makeup-ai',
    );
  });

  it('starts at most the configured number of AI jobs per rate-limit window', async () => {
    setup({
      AI_QUEUE_RATE_LIMIT_MAX: '2',
      AI_QUEUE_RATE_LIMIT_DURATION_MS: '60000',
    });
    let next = 0;
    store.claim.mockImplementation((queue, limit) =>
      Promise.resolve(
        queue === 'makeup-ai'
          ? Array.from({ length: limit }, () =>
              claimed({ id: `ai-${(next += 1)}`, queue: 'makeup-ai' }),
            )
          : [],
      ),
    );
    handlers['makeup-ai'].process.mockResolvedValue(undefined);

    await worker.runUntilIdle();
    expect(store.complete.mock.calls).toHaveLength(2);

    store.claim.mockClear();
    await worker.pollOnce();
    expect(store.claim.mock.calls.map(([queue]) => queue)).toEqual(['email']);

    worker.clock = () => new Date(NOW.getTime() + 60_001);
    await worker.pollOnce();
    expect(store.claim.mock.calls).toContainEqual([
      'makeup-ai',
      2,
      JOB_LEASE_MS,
      expect.any(Date),
    ]);
  });

  it('fails an unreadable payload and hands the job to onAbandoned', async () => {
    const job = claimed({ jobKey: 'run-1', queue: 'makeup-ai' });
    nextClaim(job);
    store.decodePayload.mockImplementation(() => {
      throw new SecretDecryptionError();
    });

    await worker.runUntilIdle();

    expect(handlers['makeup-ai'].process.mock.calls).toHaveLength(0);
    expect(store.fail.mock.calls).toContainEqual([
      job,
      expect.any(SecretDecryptionError),
      NOW,
    ]);
    expect(handlers['makeup-ai'].onAbandoned.mock.calls).toContainEqual([
      {
        id: 'run-1',
        name: job.name,
        data: undefined,
        reason: 'UNREADABLE',
      },
    ]);
  });

  it('recovers expired leases, handing exhausted jobs to onAbandoned', async () => {
    store.recoverExpiredLeases.mockResolvedValue({
      requeued: 1,
      exhausted: [
        {
          id: 'job-9',
          queue: 'makeup-ai',
          name: 'PERSONALIZATION',
          jobKey: 'run-9',
          payload: JSON.stringify({ runId: 'run-9' }),
        },
      ],
    });

    await worker.pollOnce();

    expect(store.recoverExpiredLeases.mock.calls).toContainEqual([
      NOW,
      new Set(),
      100,
      worker.random,
    ]);
    expect(handlers['makeup-ai'].onAbandoned.mock.calls).toContainEqual([
      {
        id: 'run-9',
        name: 'PERSONALIZATION',
        data: { runId: 'run-9' },
        reason: 'INTERRUPTED',
      },
    ]);
  });

  it('removes finished jobs after their retention period', async () => {
    await worker.pollOnce();
    expect(store.removeFinished.mock.calls).toContainEqual([
      new Date(NOW.getTime() - COMPLETED_JOB_RETENTION_MS),
      new Date(NOW.getTime() - FAILED_JOB_RETENTION_MS),
    ]);
  });

  it('never runs overlapping polling cycles', async () => {
    let release!: () => void;
    store.recoverExpiredLeases.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ requeued: 0, exhausted: [] });
      }),
    );

    const first = worker.pollOnce();
    await expect(worker.pollOnce()).resolves.toBe(0);
    release();
    await first;

    expect(store.recoverExpiredLeases.mock.calls).toHaveLength(1);
    expect(store.claim.mock.calls).toHaveLength(2);
  });

  it('renews the leases of running jobs and releases them on shutdown', async () => {
    const job = claimed();
    nextClaim(job);
    let finish!: () => void;
    handlers.email.process.mockReturnValue(
      new Promise<void>((resolve) => (finish = resolve)),
    );

    await worker.pollOnce();
    expect(worker.runningCount('email')).toBe(1);

    await worker.renewLeases();
    expect(store.renewLease.mock.calls).toContainEqual([
      job,
      JOB_LEASE_MS,
      NOW,
    ]);

    // Leases of jobs still running here are never recovered as expired.
    worker.clock = () => new Date(NOW.getTime() + 16_000);
    await worker.pollOnce();
    expect(store.recoverExpiredLeases.mock.calls.at(-1)?.[1]).toEqual(
      new Set(['job-1']),
    );

    await worker.stop(10);
    expect(store.release.mock.calls).toContainEqual([
      job,
      expect.any(Date),
      expect.any(Date),
    ]);
    await expect(worker.pollOnce()).resolves.toBe(0);
    finish();
  });
});
