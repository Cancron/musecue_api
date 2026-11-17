import { ConfigService } from '@nestjs/config';
import { mock } from 'jest-mock-extended';
import {
  JobDispatcher,
  JobInspector,
} from '../../infrastructure/jobs/job.types';
import {
  PrivacyExportQueueCapacityError,
  PrivacyExportQueueService,
} from './privacy-export.queue';

describe('PrivacyExportQueueService (privacy export queue)', () => {
  const jobs = mock<JobDispatcher>();
  const inspector = mock<JobInspector>();
  const job = { exportId: 'export-id', authId: 'owner-id' };

  beforeEach(() => jest.resetAllMocks());

  it('adds one deduplicated job per export with bounded, backed-off retries', async () => {
    inspector.countBacklog.mockResolvedValue(0);

    await new PrivacyExportQueueService(
      jobs,
      inspector,
      new ConfigService({}),
    ).enqueue(job);

    expect(jobs.dispatch.mock.calls).toContainEqual([
      'privacy-export',
      {
        name: 'BUILD_ARCHIVE',
        data: job,
        jobId: 'export-id',
        ownerId: 'owner-id',
        attempts: 3,
        backoff: { type: 'exponential', delayMs: 15_000, jitter: 0.5 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    ]);
  });

  it('refuses new work once the configured backlog is full', async () => {
    inspector.countBacklog.mockResolvedValue(7);
    const service = new PrivacyExportQueueService(
      jobs,
      inspector,
      new ConfigService({ PRIVACY_EXPORT_MAX_BACKLOG: '7' }),
    );

    await expect(service.enqueue(job)).rejects.toBeInstanceOf(
      PrivacyExportQueueCapacityError,
    );
    expect(jobs.dispatch.mock.calls).toHaveLength(0);
  });
});
