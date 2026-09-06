import type { MakeupSessionStatus, Prisma } from '@prisma/client';
import AppError from '../common/errors/app.error';

/** All workflow writers lock the session first; never hold this during AI/storage I/O. */
export async function lockSession(
  tx: Prisma.TransactionClient,
  authId: string,
  sessionId: string,
): Promise<MakeupSessionStatus> {
  const rows = await tx.$queryRaw<Array<{ status: MakeupSessionStatus }>>`
    SELECT status FROM "MakeupSession"
    WHERE id = ${sessionId} AND "authId" = ${authId} FOR UPDATE
  `;
  if (!rows[0]) throw AppError.notFound('Makeup session not found');
  return rows[0].status;
}

export function requireSessionStatus(
  status: MakeupSessionStatus,
  allowed: MakeupSessionStatus[],
): void {
  if (!allowed.includes(status))
    throw AppError.conflict('The session changed; refresh before trying again');
}
