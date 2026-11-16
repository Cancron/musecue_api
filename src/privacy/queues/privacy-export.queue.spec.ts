import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { mock } from 'jest-mock-extended';
import type { PrivacyExportJob } from '../interfaces/privacy-export.interface';
import {
  PrivacyExportQueueCapacityError,
  PrivacyExportQueueService,
} from './privacy-export.queue';

describe('PrivacyExportQueueService (privacy export queue)', () => {
  const queue = mock<Queue<PrivacyExportJob>>();
  const job = { exportId: 'export-id', authId: 'owner-id' };

  beforeEach(() => jest.resetAllMocks());

  it('adds one deduplicated job per export with bounded, backed-off retries', async () => {
    queue.getJobCountByTypes.mockResolvedValue(0);

    await new PrivacyExportQueueService(queue, new ConfigService({})).enqueue(
      job,
    );

    expect(queue.add.mock.calls).toContainEqual([
      'BUILD_ARCHIVE',
      job,
      {
        jobId: 'export-id',
        attempts: 3,
        backoff: { type: 'exponential', delay: 15_000, jitter: 0.5 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    ]);
  });

  it('refuses new work once the configured backlog is full', async () => {
    queue.getJobCountByTypes.mockResolvedValue(7);
    const service = new PrivacyExportQueueService(
      queue,
      new ConfigService({ PRIVACY_EXPORT_MAX_BACKLOG: '7' }),
    );

    await expect(service.enqueue(job)).rejects.toBeInstanceOf(
      PrivacyExportQueueCapacityError,
    );
    expect(queue.add.mock.calls).toHaveLength(0);
  });
});
