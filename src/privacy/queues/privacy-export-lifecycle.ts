import type { PrismaService } from '../../common/services/prisma.service';
import type { PrivacyExportStorageService } from '../../storage/privacy-export-storage.service';

export interface FailExportGuard {
  /** Only fail the attempt that started at this time. */
  startedAt?: Date;
  /** Only fail if the row has not changed since it was read. */
  updatedAt?: Date;
}

/**
 * Moves a waiting or running export to FAILED with a client-safe message and
 * removes any partial archives. Terminal exports are left untouched. Returns
 * whether this call performed the transition.
 */
export async function failExport(
  prisma: PrismaService,
  storage: PrivacyExportStorageService,
  exportId: string,
  message: string,
  guard: FailExportGuard = {},
): Promise<boolean> {
  const current = await prisma.dataExport.findUnique({
    where: { id: exportId },
    select: { authId: true },
  });
  if (!current) return false;
  const changed = await prisma.dataExport.updateMany({
    where: {
      id: exportId,
      status: { in: ['QUEUED', 'PROCESSING'] },
      ...(guard.startedAt ? { startedAt: guard.startedAt } : {}),
      ...(guard.updatedAt ? { updatedAt: guard.updatedAt } : {}),
    },
    data: { status: 'FAILED', error: message, completedAt: new Date() },
  });
  if (!changed.count) return false;
  await storage
    .deleteExportScope(current.authId, exportId)
    .catch(() => undefined);
  return true;
}
