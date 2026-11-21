import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../common/services/prisma.service';
import { USAGE_NOTE } from '../../credits/credit-usage.service';
import { lockSession } from '../workflow-lock';
import type { MakeupAiJob } from './makeup.queue';

/** Shown on a run whose processing stopped without a result. */
export const INTERRUPTED_RUN_MESSAGE =
  'Processing was interrupted. Please try again.';

/**
 * Operation input of an AI run, recorded on `AiRun.jobInput` when the run is
 * created (immutable). The other job fields (owner, session, step) are
 * columns of the run.
 */
export interface MakeupRunInput {
  imageId?: string;
  question?: string;
}

/** The JSON stored in `AiRun.jobInput` (only the fields that are set). */
export function toRunJobInput(input: MakeupRunInput): Prisma.InputJsonObject {
  return {
    ...(input.imageId !== undefined ? { imageId: input.imageId } : {}),
    ...(input.question !== undefined ? { question: input.question } : {}),
  };
}

/**
 * Reads `AiRun.jobInput`. Returns an empty object for runs created before
 * the input was recorded (null), so the queue payload's fields are used.
 */
export function readRunJobInput(
  value: Prisma.JsonValue | null | undefined,
): MakeupRunInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value;
  const input: MakeupRunInput = {};
  // A recorded input is complete: absent fields are cleared, not taken from
  // the payload.
  input.imageId =
    typeof record.imageId === 'string' ? record.imageId : undefined;
  input.question =
    typeof record.question === 'string' ? record.question : undefined;
  return input;
}

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
    // A run is only charged with its published result: usage its attempts
    // recorded (e.g. an attempt interrupted after the provider answered) is
    // settled as not charged, in the same transaction.
    await tx.aiUsage.updateMany({
      where: { runId, chargeStatus: 'PENDING' },
      data: { chargeStatus: 'NOT_CHARGED', chargeNote: USAGE_NOTE.RUN_FAILED },
    });
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
