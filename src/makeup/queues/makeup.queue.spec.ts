import { ConfigService } from '@nestjs/config';
import { mock } from 'jest-mock-extended';
import type { Queue } from 'bullmq';
import { MakeupQueueService, type MakeupAiJob } from './makeup.queue';

describe('MakeupQueueService', () => {
  const queue = mock<Queue<MakeupAiJob>>();

  beforeEach(() => jest.clearAllMocks());

  it('sets distributed concurrency and rate limits at startup', async () => {
    const service = new MakeupQueueService(
      queue,
      new ConfigService({
        AI_QUEUE_GLOBAL_CONCURRENCY: '12',
        AI_QUEUE_RATE_LIMIT_MAX: '90',
        AI_QUEUE_RATE_LIMIT_DURATION_MS: '60000',
      }),
    );

    await service.onModuleInit();

    expect(queue.setGlobalConcurrency.mock.calls).toContainEqual([12]);
    expect(queue.setGlobalRateLimit.mock.calls).toContainEqual([90, 60_000]);
  });

  it('prioritizes interactive work and adds jittered bounded retries', async () => {
    queue.getJobCountByTypes.mockResolvedValue(0);
    const service = new MakeupQueueService(queue, new ConfigService({}));
    const payload = {
      runId: 'run-id',
      authId: 'auth-id',
      sessionId: 'session-id',
    };

    await service.enqueue('VISION_CHECK', payload);
    await service.enqueue('PERSONALIZATION', payload);

    expect(queue.add.mock.calls[0]?.[2]).toMatchObject({
      attempts: 3,
      priority: 1,
      backoff: { type: 'exponential', delay: 3_000, jitter: 0.5 },
    });
    expect(queue.add.mock.calls[1]?.[2]).toMatchObject({ priority: 10 });
  });

  it('rejects new work when the configured backlog is full', async () => {
    queue.getJobCountByTypes.mockResolvedValue(25);
    const service = new MakeupQueueService(
      queue,
      new ConfigService({ AI_QUEUE_MAX_BACKLOG: '25' }),
    );

    await expect(
      service.enqueue('PERSONALIZATION', {
        runId: 'run-id',
        authId: 'auth-id',
        sessionId: 'session-id',
      }),
    ).rejects.toThrow('backlog limit');
    expect(queue.add.mock.calls).toHaveLength(0);
  });
});
