import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import { mock, mockDeep } from 'jest-mock-extended';
import type { Logger } from 'winston';
import type { PrismaService } from '../../common/services/prisma.service';
import type { PrivacyExportJob } from '../interfaces/privacy-export.interface';
import type { PrivacyExportLifecycleService } from './privacy-export-lifecycle.service';
import { PrivacyExportRecoveryService } from './privacy-export-recovery.service';

const NOW = new Date('2026-09-01T12:00:00.000Z');
const STALE = new Date(NOW.getTime() - 10 * 60_000);

describe('PrivacyExportRecoveryService (privacy export recovery)', () => {
  const prisma = mockDeep<PrismaService>();
  const lifecycle = mock<PrivacyExportLifecycleService>();
  const queue = mock<Queue<PrivacyExportJob>>();
  const logger = mock<Logger>();
  const service = () =>
    new PrivacyExportRecoveryService(
      prisma,
      lifecycle,
      queue,
      new ConfigService({}),
      logger,
    );
  const jobIn = (state: string) =>
    ({ getState: () => Promise.resolve(state) }) as unknown as Job;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.dataExport.findMany.mockResolvedValue([
      { id: 'lost', updatedAt: STALE },
      { id: 'failed-job', updatedAt: STALE },
      { id: 'waiting', updatedAt: STALE },
      { id: 'running', updatedAt: STALE },
    ] as never);
    lifecycle.fail.mockResolvedValue(true);
    queue.getJob.mockImplementation((id: string) =>
      Promise.resolve(
        id === 'lost'
          ? undefined
          : jobIn(
              { 'failed-job': 'failed', waiting: 'delayed', running: 'active' }[
                id
              ] as string,
            ),
      ),
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

  it('treats a Redis error as "unknown", not as a missing job', async () => {
    queue.getJob.mockRejectedValue(new Error('redis unavailable'));

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
