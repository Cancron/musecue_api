import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Worker, type Job, type Queue } from 'bullmq';
import { mock } from 'jest-mock-extended';
import { JobHandlerRegistry } from '../job-handler.registry';
import {
  BullMqJobDispatcher,
  BullMqJobInspector,
  BullMqQueues,
  toBullMqOptions,
} from './bullmq-job.dispatcher';
import { bullMqJobExecution } from './bullmq-job-execution';
import { BullMqQueueLimits } from './bullmq-jobs.module';
import {
  EmailBullMqProcessor,
  MakeupAiBullMqProcessor,
  PrivacyExportBullMqProcessor,
} from './bullmq.processors';

describe('BullMQ queue driver', () => {
  const email = mock<Queue>();
  const makeupAi = mock<Queue>();
  const privacyExport = mock<Queue>();
  const queues = new BullMqQueues(email, makeupAi, privacyExport);

  beforeEach(() => jest.resetAllMocks());

  describe('job options (unchanged from the original queue services)', () => {
    it('maps email jobs to the original options', () => {
      expect(
        toBullMqOptions({
          name: 'send-verification',
          data: {},
          attempts: 3,
          backoff: { type: 'exponential', delayMs: 2000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        }),
      ).toEqual({
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      });
    });

    it('maps makeup AI jobs with their run ID, priority and jitter', () => {
      expect(
        toBullMqOptions({
          name: 'VISION_CHECK',
          data: {},
          jobId: 'run-id',
          attempts: 3,
          backoff: { type: 'exponential', delayMs: 3_000, jitter: 0.5 },
          priority: 1,
          removeOnComplete: 100,
          removeOnFail: 500,
        }),
      ).toEqual({
        jobId: 'run-id',
        attempts: 3,
        backoff: { type: 'exponential', delay: 3_000, jitter: 0.5 },
        priority: 1,
        removeOnComplete: 100,
        removeOnFail: 500,
      });
    });

    it('adds the job to the named BullMQ queue', async () => {
      await new BullMqJobDispatcher(queues).dispatch('privacy-export', {
        name: 'BUILD_ARCHIVE',
        data: { exportId: 'export-id', authId: 'owner' },
        jobId: 'export-id',
        // The owner is a PostgreSQL-driver concept; BullMQ options are unchanged.
        ownerId: 'owner',
        attempts: 3,
        backoff: { type: 'exponential', delayMs: 15_000, jitter: 0.5 },
        removeOnComplete: 100,
        removeOnFail: 500,
      });

      expect(privacyExport.add.mock.calls).toEqual([
        [
          'BUILD_ARCHIVE',
          { exportId: 'export-id', authId: 'owner' },
          {
            jobId: 'export-id',
            attempts: 3,
            backoff: { type: 'exponential', delay: 15_000, jitter: 0.5 },
            removeOnComplete: 100,
            removeOnFail: 500,
          },
        ],
      ]);
      expect(email.add.mock.calls).toHaveLength(0);
    });
  });

  describe('inspection', () => {
    it('counts waiting, active, delayed and prioritized jobs as backlog', async () => {
      makeupAi.getJobCountByTypes.mockResolvedValue(7);
      await expect(
        new BullMqJobInspector(queues).countBacklog('makeup-ai'),
      ).resolves.toBe(7);
      expect(makeupAi.getJobCountByTypes.mock.calls[0]).toEqual([
        'wait',
        'active',
        'delayed',
        'prioritized',
      ]);
    });

    it('reports missing jobs as unknown and passes states through', async () => {
      const inspector = new BullMqJobInspector(queues);
      makeupAi.getJob.mockResolvedValueOnce(undefined);
      await expect(inspector.getJobState('makeup-ai', 'run')).resolves.toBe(
        'unknown',
      );
      const job = mock<Job>();
      job.getState.mockResolvedValue('failed');
      makeupAi.getJob.mockResolvedValueOnce(job);
      await expect(inspector.getJobState('makeup-ai', 'run')).resolves.toBe(
        'failed',
      );
    });

    it('propagates Redis errors instead of reporting a missing job', async () => {
      privacyExport.getJob.mockRejectedValue(new Error('offline'));
      await expect(
        new BullMqJobInspector(queues).getJobState('privacy-export', 'x'),
      ).rejects.toThrow('offline');
    });
  });

  it('applies the makeup AI global concurrency and rate limit at startup', async () => {
    await new BullMqQueueLimits(
      queues,
      new ConfigService({
        AI_QUEUE_GLOBAL_CONCURRENCY: '12',
        AI_QUEUE_RATE_LIMIT_MAX: '90',
        AI_QUEUE_RATE_LIMIT_DURATION_MS: '60000',
      }),
    ).onModuleInit();

    expect(makeupAi.setGlobalConcurrency.mock.calls).toContainEqual([12]);
    expect(makeupAi.setGlobalRateLimit.mock.calls).toContainEqual([90, 60_000]);
  });

  describe('job execution adapter', () => {
    it('exposes the job lazily, as the original processors read it', () => {
      const discard = jest.fn();
      const job = {
        id: 'run',
        name: 'GUIDE_QUESTION',
        data: { runId: 'run' },
        attemptsMade: 1,
        opts: { attempts: 3 },
        discard,
        updateData: jest.fn(),
      } as unknown as Job<{ runId: string }>;
      const execution = bullMqJobExecution(job, () => undefined);

      expect(execution).toMatchObject({
        id: 'run',
        name: 'GUIDE_QUESTION',
        data: { runId: 'run' },
        attemptsMade: 1,
        maxAttempts: 3,
      });
      execution.discard();
      expect(discard.mock.calls).toHaveLength(1);
    });

    it('postpones through the worker rate limit and returns its RateLimitError', async () => {
      const worker = mock<Worker>();
      const execution = bullMqJobExecution(
        { opts: {} } as unknown as Job,
        () => worker,
      );

      const error = await execution.rateLimit(5_000);

      expect(worker.rateLimit.mock.calls).toContainEqual([5_000]);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(Worker.RateLimitError().message);
    });
  });

  it('hands BullMQ jobs to the registered handler of the queue', async () => {
    const registry = new JobHandlerRegistry();
    const process = jest.fn().mockResolvedValue(undefined);
    registry.register('makeup-ai', { process });
    registry.onApplicationBootstrap();
    const job = {
      id: 'run',
      name: 'PERSONALIZATION',
      data: { runId: 'run' },
      opts: { attempts: 3 },
      attemptsMade: 0,
    } as unknown as Job;

    await new MakeupAiBullMqProcessor(registry).process(job);

    expect(process).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'PERSONALIZATION',
        data: { runId: 'run' },
        maxAttempts: 3,
      }),
    );
  });

  it('injects the handler registry into every BullMQ processor', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        JobHandlerRegistry,
        EmailBullMqProcessor,
        MakeupAiBullMqProcessor,
        PrivacyExportBullMqProcessor,
      ],
    }).compile();
    const registry = moduleRef.get(JobHandlerRegistry);
    const handled: string[] = [];
    for (const queue of ['email', 'makeup-ai', 'privacy-export'] as const) {
      registry.register(queue, {
        process: () => {
          handled.push(queue);
          return Promise.resolve();
        },
      });
    }
    registry.onApplicationBootstrap();
    const job = { name: 'job', data: {}, opts: {} } as unknown as Job;

    await moduleRef.get(EmailBullMqProcessor).process(job);
    await moduleRef.get(MakeupAiBullMqProcessor).process(job);
    await moduleRef.get(PrivacyExportBullMqProcessor).process(job);

    expect(handled).toEqual(['email', 'makeup-ai', 'privacy-export']);
  });
});
