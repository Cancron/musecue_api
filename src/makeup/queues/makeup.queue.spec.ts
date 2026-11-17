import { ConfigService } from '@nestjs/config';
import { mock } from 'jest-mock-extended';
import {
  JobDispatcher,
  JobInspector,
} from '../../infrastructure/jobs/job.types';
import { MakeupQueueService, type MakeupAiJob } from './makeup.queue';

describe('MakeupQueueService', () => {
  const jobs = mock<JobDispatcher>();
  const inspector = mock<JobInspector>();
  const payload: MakeupAiJob = {
    runId: 'run-id',
    authId: 'auth-id',
    sessionId: 'session-id',
  };

  beforeEach(() => jest.clearAllMocks());

  it('prioritizes interactive work and adds jittered bounded retries', async () => {
    inspector.countBacklog.mockResolvedValue(0);
    const service = new MakeupQueueService(
      jobs,
      inspector,
      new ConfigService({}),
    );

    await service.enqueue('VISION_CHECK', payload);
    await service.enqueue('PERSONALIZATION', payload);
    await service.enqueue('GUIDE_GENERATION', payload);

    expect(inspector.countBacklog.mock.calls[0]).toEqual(['makeup-ai']);
    expect(jobs.dispatch.mock.calls[0]).toEqual([
      'makeup-ai',
      {
        name: 'VISION_CHECK',
        data: payload,
        // Deduplicated per run, and deleted with the owner's account.
        jobId: 'run-id',
        ownerId: 'auth-id',
        attempts: 3,
        backoff: { type: 'exponential', delayMs: 3_000, jitter: 0.5 },
        priority: 1,
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    ]);
    expect(jobs.dispatch.mock.calls[1]?.[1]).toMatchObject({ priority: 10 });
    expect(jobs.dispatch.mock.calls[2]?.[1]).toMatchObject({ priority: 5 });
  });

  it('rejects new work when the configured backlog is full', async () => {
    inspector.countBacklog.mockResolvedValue(25);
    const service = new MakeupQueueService(
      jobs,
      inspector,
      new ConfigService({ AI_QUEUE_MAX_BACKLOG: '25' }),
    );

    await expect(service.enqueue('PERSONALIZATION', payload)).rejects.toThrow(
      'backlog limit',
    );
    expect(jobs.dispatch.mock.calls).toHaveLength(0);
  });
});
