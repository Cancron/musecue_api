import type { PrismaService } from '../../common/services/prisma.service';
import { PrivacyExportSupersededError } from '../export/privacy-export.errors';

export interface ExportAttemptTiming {
  /** How long a worker lease lasts without renewal. */
  leaseMs: number;
  /** How often a running worker renews its lease and checks cancellation. */
  heartbeatMs: number;
}

export const DEFAULT_EXPORT_ATTEMPT_TIMING: ExportAttemptTiming = {
  leaseMs: 60_000,
  heartbeatMs: 15_000,
};

/**
 * One worker's attempt at building an export, coordinated with anything that
 * may cancel it (failure handling, recovery, account erasure):
 *
 * - Lease: while the attempt runs, `DataExport.workerLeaseUntil` is renewed
 *   by a heartbeat, so others can tell a live worker from a crashed one. The
 *   lease is released only after the worker's last storage operation.
 * - Cancellation: each heartbeat checks that the export is still PROCESSING
 *   by this attempt; otherwise `signal` is aborted and the build stops at the
 *   next entry.
 * - Fence: file creation and publication run under `fenced()`, which holds
 *   the export row lock (through a guarded update, no raw SQL) and verifies
 *   the attempt is still current. A
 *   cancellation (which updates, and so locks, the same row) therefore
 *   either happens before the file operation, which is then refused, or
 *   after it, when the file already exists for cleanup to find.
 */
export class ExportAttempt {
  private readonly controller = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private beating?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly exportId: string,
    private readonly startedAt: Date,
    private readonly timing: ExportAttemptTiming = DEFAULT_EXPORT_ATTEMPT_TIMING,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** The lease expiry to store when the attempt claims or renews. */
  leaseUntil(now: Date = new Date()): Date {
    return new Date(now.getTime() + this.timing.leaseMs);
  }

  start(): void {
    this.timer = setInterval(() => {
      this.beating ??= this.heartbeat().finally(() => {
        this.beating = undefined;
      });
    }, this.timing.heartbeatMs);
    this.timer.unref?.();
  }

  /** Renews the lease and aborts the build if the attempt was cancelled. */
  async heartbeat(): Promise<void> {
    try {
      await this.prisma.dataExport.updateMany({
        where: { id: this.exportId, startedAt: this.startedAt },
        data: { workerLeaseUntil: this.leaseUntil() },
      });
      const current = await this.prisma.dataExport.findUnique({
        where: { id: this.exportId },
        select: { status: true, startedAt: true },
      });
      if (!this.isCurrent(current)) this.controller.abort();
    } catch {
      // A transient database error must not kill the build; the lease simply
      // is not renewed this time.
    }
  }

  /**
   * Runs a file operation only while this attempt is still current. The
   * guarded update takes the export row's lock until the transaction ends
   * (and renews the lease): a concurrent cancellation either commits first,
   * so the update matches nothing and the operation is refused, or waits
   * until the operation is done.
   */
  fenced<T>(operation: () => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.dataExport.updateMany({
        where: {
          id: this.exportId,
          status: 'PROCESSING',
          startedAt: this.startedAt,
        },
        data: { workerLeaseUntil: this.leaseUntil() },
      });
      if (!locked.count) {
        this.controller.abort();
        throw new PrivacyExportSupersededError();
      }
      return operation();
    });
  }

  /** Stops the heartbeat and releases the lease (after the last file operation). */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.beating;
    await this.prisma.dataExport
      .updateMany({
        where: { id: this.exportId, startedAt: this.startedAt },
        data: { workerLeaseUntil: null },
      })
      .catch(() => undefined);
  }

  private isCurrent(
    row: { status: string; startedAt: Date | null } | null | undefined,
  ): boolean {
    return (
      row?.status === 'PROCESSING' &&
      row.startedAt?.getTime() === this.startedAt.getTime()
    );
  }
}
