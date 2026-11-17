import { ConfigService } from '@nestjs/config';
import { mock, mockDeep } from 'jest-mock-extended';
import type { Prisma } from '@prisma/client';
import type { Logger } from 'winston';
import { PrismaService } from '../../common/services/prisma.service';
import { JobInspector } from '../../infrastructure/jobs/job.types';
import { MakeupRecoveryService } from './makeup-recovery.service';
import { canPublishRun } from './run-lifecycle';

describe('AI job recovery', () => {
  const prisma = mockDeep<PrismaService>();
  const jobs = mock<JobInspector>();
  const service = new MakeupRecoveryService(
    prisma,
    jobs,
    new ConfigService(),
    mock<Logger>(),
  );
  const run = {
    id: 'run',
    authId: 'owner',
    sessionId: 'session',
    operation: 'GUIDE_GENERATION',
    status: 'PROCESSING',
    createdAt: new Date(0),
    updatedAt: new Date(1000),
    startedAt: new Date(1000),
  };
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.aiRun.findMany.mockResolvedValue([run] as never);
    prisma.aiRun.findUnique.mockResolvedValue(run as never);
    prisma.$queryRaw.mockResolvedValue([{ status: 'GUIDE_GENERATING' }]);
    prisma.aiRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation(((
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) => callback(prisma)) as PrismaService['$transaction']);
  });
  it.each(['failed', 'completed', 'unknown'] as const)(
    'settles stranded database runs when queue state is %s',
    async (state) => {
      jobs.getJobState.mockResolvedValue(state);
      await service.reconcile();
      expect(jobs.getJobState.mock.calls[0]).toEqual(['makeup-ai', 'run']);
      expect(prisma.aiRun.updateMany.mock.calls[0]?.[0]).toMatchObject({
        where: { id: 'run', updatedAt: run.updatedAt },
        data: { status: 'FAILED', progress: 100 },
      });
      expect(prisma.makeupSession.updateMany.mock.calls[0]?.[0]).toMatchObject({
        where: { status: 'GUIDE_GENERATING' },
        data: { status: 'GUIDE_FAILED' },
      });
    },
  );
  it('handles a missing queue job', async () => {
    jobs.getJobState.mockResolvedValue('unknown');
    await service.reconcile();
    expect(prisma.aiRun.updateMany.mock.calls).toHaveLength(1);
  });
  it('continues past a full page of healthy jobs to find orphaned runs', async () => {
    const healthy = Array.from({ length: 100 }, (_, index) => ({
      ...run,
      id: `healthy-${index}`,
    }));
    prisma.aiRun.findMany
      .mockResolvedValueOnce(healthy as never)
      .mockResolvedValueOnce([run] as never);
    jobs.getJobState.mockImplementation((_queue, id) =>
      Promise.resolve(id === 'run' ? 'unknown' : 'prioritized'),
    );
    await service.reconcile();
    expect(prisma.aiRun.findMany.mock.calls[1]?.[0]).toMatchObject({
      cursor: { id: 'healthy-99' },
      skip: 1,
    });
    expect(prisma.aiRun.updateMany.mock.calls).toHaveLength(1);
  });
  it.each(['active', 'waiting', 'delayed', 'prioritized'] as const)(
    'does not fail healthy %s jobs because they are old',
    async (state) => {
      jobs.getJobState.mockResolvedValue(state);
      await service.reconcile();
      expect(jobs.getJobState.mock.calls[0]).toEqual(['makeup-ai', 'run']);
      expect(prisma.aiRun.updateMany.mock.calls).toHaveLength(0);
    },
  );
  it('does not interpret queue unavailability as missing jobs', async () => {
    jobs.getJobState.mockRejectedValue(new Error('offline'));
    await service.reconcile();
    expect(prisma.aiRun.updateMany.mock.calls).toHaveLength(0);
  });
  it('does not regress a session when the run changed during recovery', async () => {
    jobs.getJobState.mockResolvedValue('unknown');
    prisma.aiRun.updateMany.mockResolvedValue({ count: 0 });
    await service.reconcile();
    expect(prisma.makeupSession.updateMany.mock.calls).toHaveLength(0);
  });
  it('does not regress a session with a newer job', async () => {
    jobs.getJobState.mockResolvedValue('unknown');
    prisma.aiRun.findFirst.mockResolvedValue({ id: 'newer' } as never);
    await service.reconcile();
    expect(prisma.makeupSession.updateMany.mock.calls).toHaveLength(0);
  });
  it.each(['FAILED', 'COMPLETED'])(
    'prevents %s jobs from publishing late AI responses',
    async (status) => {
      prisma.aiRun.findUnique.mockResolvedValue({ ...run, status } as never);
      await expect(
        canPublishRun(
          prisma,
          { runId: 'run', authId: 'owner', sessionId: 'session' },
          1000,
        ),
      ).resolves.toBe(false);
    },
  );
  it('prevents an earlier stalled attempt from publishing over a newer attempt', async () => {
    await expect(
      canPublishRun(
        prisma,
        { runId: 'run', authId: 'owner', sessionId: 'session' },
        999,
      ),
    ).resolves.toBe(false);
  });
});
