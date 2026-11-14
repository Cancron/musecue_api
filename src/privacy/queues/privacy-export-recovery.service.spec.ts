import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import { mock, mockDeep } from 'jest-mock-extended';
import type { Logger } from 'winston';
import type { PrismaService } from '../../common/services/prisma.service';
import type { PrivacyExportStorageService } from '../../storage/privacy-export-storage.service';
import type { PrivacyExportJob } from '../interfaces/privacy-export.interface';
import { PRIVACY_EXPORT_INTERRUPTED_MESSAGE } from '../privacy-export.constants';
import { PrivacyExportRecoveryService } from './privacy-export-recovery.service';

const NOW = new Date('2026-09-01T12:00:00.000Z');
const anyDate: unknown = expect.any(Date);
const STALE = new Date(NOW.getTime() - 10 * 60_000);

describe('PrivacyExportRecoveryService (privacy export recovery)', () => {
  const prisma = mockDeep<PrismaService>();
  const storage = mock<PrivacyExportStorageService>();
  const queue = mock<Queue<PrivacyExportJob>>();
  const logger = mock<Logger>();
  const service = () =>
    new PrivacyExportRecoveryService(
      prisma,
      storage,
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
    prisma.dataExport.findUnique.mockResolvedValue({
      authId: 'owner',
    } as never);
    prisma.dataExport.updateMany.mockResolvedValue({ count: 1 });
    storage.deleteExportScope.mockResolvedValue();
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

  it('fails only stale exports whose job is gone or finished, and frees the owner', async () => {
    await service().reconcile(NOW);

    expect(prisma.dataExport.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        status: { in: ['QUEUED', 'PROCESSING'] },
        updatedAt: { lt: new Date(NOW.getTime() - 120_000) },
      },
    });
    const failed = prisma.dataExport.updateMany.mock.calls.map(
      ([args]) => args.where?.id,
    );
    expect(failed).toEqual(['lost', 'failed-job']);
    expect(prisma.dataExport.updateMany.mock.calls[0][0]).toEqual({
      where: {
        id: 'lost',
        status: { in: ['QUEUED', 'PROCESSING'] },
        updatedAt: STALE,
      },
      data: {
        status: 'FAILED',
        error: PRIVACY_EXPORT_INTERRUPTED_MESSAGE,
        completedAt: anyDate,
      },
    });
    expect(storage.deleteExportScope.mock.calls).toContainEqual([
      'owner',
      'lost',
    ]);
  });

  it('treats a Redis error as "unknown", not as a missing job', async () => {
    queue.getJob.mockRejectedValue(new Error('redis unavailable'));

    await service().reconcile(NOW);

    expect(prisma.dataExport.updateMany.mock.calls).toHaveLength(0);
    expect(logger.warn.mock.calls.length).toBeGreaterThan(0);
  });
});
