import { ConfigService } from '@nestjs/config';
import { mock, mockDeep } from 'jest-mock-extended';
import type { Logger } from 'winston';
import type { PrismaService } from '../../common/services/prisma.service';
import {
  JobInspector,
  type JobState,
} from '../../infrastructure/jobs/job.types';
import type { PrivacyExportLifecycleService } from './privacy-export-lifecycle.service';
import { PrivacyExportRecoveryService } from './privacy-export-recovery.service';

const NOW = new Date('2026-09-01T12:00:00.000Z');
const STALE = new Date(NOW.getTime() - 10 * 60_000);

describe('PrivacyExportRecoveryService (privacy export recovery)', () => {
  const prisma = mockDeep<PrismaService>();
  const lifecycle = mock<PrivacyExportLifecycleService>();
  const jobs = mock<JobInspector>();
  const logger = mock<Logger>();
  const service = () =>
    new PrivacyExportRecoveryService(
      prisma,
      lifecycle,
      jobs,
      new ConfigService({}),
      logger,
    );

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.dataExport.findMany.mockResolvedValue([
      { id: 'lost', updatedAt: STALE },
      { id: 'failed-job', updatedAt: STALE },
      { id: 'waiting', updatedAt: STALE },
      { id: 'running', updatedAt: STALE },
    ] as never);
    lifecycle.fail.mockResolvedValue(true);
    const states: Record<string, JobState> = {
      lost: 'unknown',
      'failed-job': 'failed',
      waiting: 'delayed',
      running: 'active',
    };
    jobs.getJobState.mockImplementation((queue, id) =>
      Promise.resolve(queue === 'privacy-export' ? states[id] : 'unknown'),
    );
  });

  it('fails only stale exports whose job is gone or finished, as INTERRUPTED', async () => {
    await service().reconcile(NOW);

    expect(prisma.dataExport.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        status: { in: ['QUEUED', 'PROCESSING'] },
        updatedAt: { lt: new Date(NOW.getTime() - 120_000) },
      },
    });
    // Guarded by updatedAt so an export that moved on is not failed.
    expect(lifecycle.fail.mock.calls).toEqual([
      ['lost', 'INTERRUPTED', { updatedAt: STALE }],
      ['failed-job', 'INTERRUPTED', { updatedAt: STALE }],
    ]);
  });

  it('treats a queue error as "unknown", not as a missing job', async () => {
    jobs.getJobState.mockRejectedValue(new Error('redis unavailable'));

    await service().reconcile(NOW);

    expect(lifecycle.fail.mock.calls).toHaveLength(0);
    expect(logger.warn.mock.calls.length).toBeGreaterThan(0);
  });

  it('leaves file cleanup to the retention sweep', async () => {
    await service().reconcile(NOW);

    expect(lifecycle.retryPendingCleanups.mock.calls).toHaveLength(0);
    expect(lifecycle.expireDueExports.mock.calls).toHaveLength(0);
  });
});
