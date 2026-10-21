import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../common/services/prisma.service';
import { lockSession } from '../workflow-lock';
import type { MakeupAiJob } from './makeup.queue';

/** Serialize publication with workflow changes and recovery; terminal runs cannot publish. */
export async function canPublishRun(
  tx: Prisma.TransactionClient,
  data: MakeupAiJob,
  startedAt: number,
): Promise<boolean> {
  await lockSession(tx, data.authId, data.sessionId);
  const run = await tx.aiRun.findUnique({
    where: { id: data.runId },
    select: { status: true, startedAt: true },
  });
  return run?.status === 'PROCESSING' && run.startedAt?.getTime() === startedAt;
}

export async function failRun(
  prisma: PrismaService,
  runId: string,
  message: string,
  expectedUpdatedAt?: Date,
  expectedStartedAt?: Date,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const run = await tx.aiRun.findUnique({ where: { id: runId } });
    if (!run || !['QUEUED', 'PROCESSING'].includes(run.status)) return;
    await lockSession(tx, run.authId, run.sessionId);
    const changed = await tx.aiRun.updateMany({
      where: {
        id: runId,
        status: { in: ['QUEUED', 'PROCESSING'] },
        ...(expectedUpdatedAt ? { updatedAt: expectedUpdatedAt } : {}),
        ...(expectedStartedAt ? { startedAt: expectedStartedAt } : {}),
      },
      data: {
        status: 'FAILED',
        progress: 100,
        error: message,
        completedAt: new Date(),
      },
    });
    if (!changed.count) return;
    if (
      run.operation === 'PERSONALIZATION' ||
      run.operation === 'GUIDE_GENERATION'
    ) {
      const newer = await tx.aiRun.findFirst({
        where: {
          sessionId: run.sessionId,
          operation: run.operation,
          id: { not: runId },
          createdAt: { gte: run.createdAt },
          status: { in: ['QUEUED', 'PROCESSING', 'COMPLETED'] },
        },
        select: { id: true },
      });
      if (newer) return;
      await tx.makeupSession.updateMany({
        where: {
          id: run.sessionId,
          status:
            run.operation === 'PERSONALIZATION'
              ? 'ANALYZING'
              : 'GUIDE_GENERATING',
        },
        data: {
          status:
            run.operation === 'PERSONALIZATION'
              ? 'ANALYSIS_FAILED'
              : 'GUIDE_FAILED',
        },
      });
    }
  });
}
