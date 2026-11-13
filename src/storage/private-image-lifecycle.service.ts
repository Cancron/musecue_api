import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  Prisma,
  PrivateStorageCleanup,
  PrivateStorageCleanupReason,
} from '@prisma/client';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import {
  PrivateImageStorageService,
  type PrivateObjectRef,
  type SupportedImageMime,
} from './private-image-storage.service';
import { PrivateStorageError } from './private-storage.error';

/** Reasons callers may give when a committed reference is removed. */
export type PrivateImageDeletionReason = Exclude<
  PrivateStorageCleanupReason,
  'UPLOAD_PENDING' | 'UPLOAD_ABANDONED'
>;

export type CleanupOutcome =
  /** The provider confirmed the deletion and the ledger row was removed. */
  | 'DELETED'
  /** Deletion failed; the row stays PENDING with a later `nextAttemptAt`. */
  | 'RETRY_SCHEDULED'
  /** Deletion failed permanently; the row stays FAILED for manual recovery. */
  | 'FAILED'
  /** The object is still referenced, so it was kept and the row removed. */
  | 'SKIPPED_REFERENCED'
  /** Not attempted now (not due, owned by another worker, or DB unavailable). */
  | 'NOT_ATTEMPTED';

export const CLEANUP_POLICY = {
  /** Reservations older than this belong to uploads that never committed. */
  uploadGraceMs: 60 * 60_000,
  /**
   * After an ambiguous upload failure (timeout, network error, 5xx) the write
   * may still be in flight at the provider. Deleting immediately could run
   * before it lands and leave an untracked object, so deletion waits.
   */
  ambiguousUploadSettleMs: 10 * 60_000,
  /** A claimed row is invisible to other workers for this long. */
  leaseMs: 5 * 60_000,
  /** 30 s doubling, capped at 6 h: about 26 h of retries before FAILED. */
  maxAttempts: 14,
  baseBackoffMs: 30_000,
  maxBackoffMs: 6 * 60 * 60_000,
  sweepIntervalMs: 60_000,
  batchSize: 50,
} as const;

const CONTEXT = 'PrivateImageLifecycle';

/**
 * Keeps private objects and database references consistent.
 *
 * Every object that is, or may become, unreferenced is recorded in
 * `PrivateStorageCleanup` inside the same transaction that changes the
 * reference, or before the bytes are written for uploads. A row is removed
 * only after the provider confirms the deletion, so a failed deletion is
 * never treated as done: it is retried with backoff and finally kept as
 * FAILED with the provider, key, reason and last error for recovery.
 */
@Injectable()
export class PrivateImageLifecycleService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: PrivateImageStorageService,
    private readonly config: ConfigService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('NODE_ENV') === 'test') return;
    this.timer = setInterval(() => {
      void this.processDue();
    }, CLEANUP_POLICY.sweepIntervalMs);
    this.timer.unref();
    void this.processDue();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  onApplicationBootstrap(): void {
    if (this.config.get<string>('NODE_ENV') === 'test') return;
    void this.auditReferencedProviders();
  }

  /**
   * Changing the default provider must not strand existing images: every
   * provider still referenced by an image, avatar or pending deletion has to
   * stay registered and configured. Logs an error for each one that is not
   * (never blocks startup) and returns their ids.
   */
  async auditReferencedProviders(): Promise<string[]> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ provider: string }>>`
        SELECT DISTINCT "storageProvider" AS provider FROM "ImageAsset"
        UNION
        SELECT DISTINCT "avatarStorageProvider" FROM "userProfile"
        WHERE "avatarStorageProvider" IS NOT NULL
        UNION
        SELECT DISTINCT provider FROM "PrivateStorageCleanup"
      `;
      const unavailable = rows
        .map((row) => row.provider)
        .filter((provider) => !this.storage.isAvailable(provider))
        .sort();
      for (const provider of unavailable) {
        this.logger.error(
          'Stored images reference a storage provider that is not registered or not configured; they cannot be served or deleted',
          { context: CONTEXT, provider },
        );
      }
      return unavailable;
    } catch {
      this.logger.warn('Storage provider audit could not run', {
        context: CONTEXT,
      });
      return [];
    }
  }

  /**
   * Records a reservation, then writes the bytes. The caller must call
   * `confirmUpload` in the transaction that stores the reference, or
   * `abandonUpload` when that transaction fails.
   */
  async upload(
    authId: string,
    scopeId: string,
    mimeType: SupportedImageMime,
    bytes: Buffer,
  ): Promise<PrivateObjectRef> {
    const ref = this.storage.createRef(authId, scopeId, mimeType);
    try {
      await this.prisma.privateStorageCleanup.create({
        data: {
          provider: ref.provider,
          storageKey: ref.key,
          reason: 'UPLOAD_PENDING',
          nextAttemptAt: new Date(Date.now() + CLEANUP_POLICY.uploadGraceMs),
        },
      });
    } catch (cause) {
      // Without a durable record an object could be orphaned, so do not write.
      this.logger.error(
        'Upload not attempted: reservation could not be saved',
        {
          context: CONTEXT,
          provider: ref.provider,
        },
      );
      throw new PrivateStorageError('STORAGE_UNAVAILABLE', {
        provider: ref.provider,
        operation: 'put',
        cause,
      });
    }

    try {
      await this.storage.put(ref, bytes, mimeType);
    } catch (error) {
      if (error instanceof PrivateStorageError && !error.retryable) {
        // Rejected outright (or the key already belongs to another object):
        // nothing of ours was written, and an existing object must survive.
        await this.forgetReservation(ref);
      } else {
        // Timeouts/5xx are ambiguous: the bytes may be stored now or land
        // later, so the deletion is recorded and runs after a settle period.
        await this.abandonUpload(ref, {
          settleMs: CLEANUP_POLICY.ambiguousUploadSettleMs,
        });
      }
      throw error;
    }
    return ref;
  }

  /**
   * Claims the reservation inside the caller's transaction. Fails (rolling the
   * transaction back) if the cleaner already took over an expired reservation.
   */
  async confirmUpload(
    tx: Prisma.TransactionClient,
    ref: PrivateObjectRef,
  ): Promise<void> {
    const claimed = await tx.privateStorageCleanup.deleteMany({
      where: {
        provider: ref.provider,
        storageKey: ref.key,
        reason: 'UPLOAD_PENDING',
        status: 'PENDING',
      },
    });
    if (claimed.count !== 1) {
      throw AppError.conflict(
        'The image upload expired. Please upload the image again.',
      );
    }
  }

  /**
   * Marks an upload whose reference was never committed for deletion and
   * tries to delete it now, or after `settleMs` when the write may still be in
   * flight. Never throws; if the database is unavailable the reservation
   * remains and is cleaned once it expires.
   */
  async abandonUpload(
    ref: PrivateObjectRef,
    options: { settleMs?: number } = {},
  ): Promise<CleanupOutcome> {
    const settleMs = options.settleMs ?? 0;
    try {
      await this.prisma.privateStorageCleanup.updateMany({
        where: {
          provider: ref.provider,
          storageKey: ref.key,
          reason: 'UPLOAD_PENDING',
          status: 'PENDING',
        },
        data: {
          reason: 'UPLOAD_ABANDONED',
          nextAttemptAt: new Date(Date.now() + settleMs),
        },
      });
    } catch {
      this.logger.warn(
        'Abandoned upload stays reserved; it will be deleted after the reservation expires',
        { context: CONTEXT, provider: ref.provider },
      );
      return 'NOT_ATTEMPTED';
    }
    if (settleMs > 0) return 'NOT_ATTEMPTED';
    const [outcome] = await this.processRefs([ref]);
    return outcome;
  }

  /** Records objects whose references are removed in this transaction. */
  async scheduleDeletion(
    tx: Prisma.TransactionClient,
    refs: PrivateObjectRef[],
    reason: PrivateImageDeletionReason,
  ): Promise<void> {
    if (refs.length === 0) return;
    const now = new Date();
    await tx.privateStorageCleanup.createMany({
      data: refs.map((ref) => ({
        provider: ref.provider,
        storageKey: ref.key,
        reason,
        nextAttemptAt: now,
      })),
      skipDuplicates: true,
    });
  }

  /** Attempts recorded deletions right away. Never throws. */
  async processRefs(refs: PrivateObjectRef[]): Promise<CleanupOutcome[]> {
    const outcomes: CleanupOutcome[] = [];
    for (const ref of refs) {
      try {
        const task = await this.prisma.privateStorageCleanup.findUnique({
          where: {
            provider_storageKey: {
              provider: ref.provider,
              storageKey: ref.key,
            },
          },
        });
        outcomes.push(task ? await this.attempt(task) : 'NOT_ATTEMPTED');
      } catch {
        this.logger.warn('Private image cleanup deferred to the next pass', {
          context: CONTEXT,
          provider: ref.provider,
        });
        outcomes.push('NOT_ATTEMPTED');
      }
    }
    return outcomes;
  }

  /** One cleaner pass over due rows; runs periodically on every instance. */
  async processDue(): Promise<CleanupOutcome[]> {
    if (this.sweeping) return [];
    this.sweeping = true;
    try {
      const tasks = await this.prisma.privateStorageCleanup.findMany({
        where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
        orderBy: { nextAttemptAt: 'asc' },
        take: CLEANUP_POLICY.batchSize,
      });
      const outcomes: CleanupOutcome[] = [];
      for (const task of tasks) {
        try {
          outcomes.push(await this.attempt(task));
        } catch {
          // One row's database error must not stall the rest of the batch;
          // the row keeps its lease and is retried on a later pass.
          this.logger.warn('Private image cleanup deferred to the next pass', {
            context: CONTEXT,
            taskId: task.id,
          });
          outcomes.push('NOT_ATTEMPTED');
        }
      }
      return outcomes;
    } catch {
      this.logger.warn('Private image cleanup pass could not complete', {
        context: CONTEXT,
      });
      return [];
    } finally {
      this.sweeping = false;
    }
  }

  private async attempt(task: PrivateStorageCleanup): Promise<CleanupOutcome> {
    const now = new Date();
    if (task.status !== 'PENDING' || task.nextAttemptAt > now) {
      return 'NOT_ATTEMPTED';
    }
    const reason: PrivateStorageCleanupReason =
      task.reason === 'UPLOAD_PENDING' ? 'UPLOAD_ABANDONED' : task.reason;
    // Optimistic claim: only one worker wins; an expired reservation becomes
    // ABANDONED atomically, so a late confirmUpload can no longer claim it.
    const claim = await this.prisma.privateStorageCleanup.updateMany({
      where: {
        id: task.id,
        status: 'PENDING',
        nextAttemptAt: task.nextAttemptAt,
      },
      data: {
        reason,
        lastAttemptAt: now,
        nextAttemptAt: new Date(now.getTime() + CLEANUP_POLICY.leaseMs),
      },
    });
    if (claim.count !== 1) return 'NOT_ATTEMPTED';

    const ref = { provider: task.provider, key: task.storageKey };
    if (await this.isReferenced(ref)) {
      await this.prisma.privateStorageCleanup.deleteMany({
        where: { id: task.id },
      });
      this.logger.warn('Skipped deleting a private image that is referenced', {
        context: CONTEXT,
        taskId: task.id,
        provider: ref.provider,
        reason,
      });
      return 'SKIPPED_REFERENCED';
    }

    try {
      await this.storage.delete(ref);
    } catch (error) {
      return this.recordFailure({ ...task, reason }, error, now);
    }
    await this.prisma.privateStorageCleanup.deleteMany({
      where: { id: task.id },
    });
    return 'DELETED';
  }

  private async recordFailure(
    task: PrivateStorageCleanup,
    error: unknown,
    now: Date,
  ): Promise<CleanupOutcome> {
    const code =
      error instanceof PrivateStorageError ? error.code : 'UNEXPECTED_ERROR';
    const attempts = task.attempts + 1;
    const permanent =
      code === 'INVALID_STORAGE_KEY' || attempts >= CLEANUP_POLICY.maxAttempts;
    const nextAttemptAt = permanent
      ? now
      : new Date(now.getTime() + backoffMs(attempts));
    await this.prisma.privateStorageCleanup.updateMany({
      where: { id: task.id },
      data: {
        attempts,
        lastErrorCode: code,
        lastAttemptAt: now,
        status: permanent ? 'FAILED' : 'PENDING',
        nextAttemptAt,
      },
    });
    const entry = {
      context: CONTEXT,
      taskId: task.id,
      provider: task.provider,
      reason: task.reason,
      code,
      attempts,
    };
    if (permanent) {
      this.logger.error(
        'Private image deletion failed permanently; manual recovery required',
        entry,
      );
      return 'FAILED';
    }
    this.logger.warn('Private image deletion failed; retry scheduled', {
      ...entry,
      nextAttemptAt: nextAttemptAt.toISOString(),
    });
    return 'RETRY_SCHEDULED';
  }

  /** Safety net: never delete an object a record still points to. */
  private async isReferenced(ref: PrivateObjectRef): Promise<boolean> {
    const [images, avatars] = await Promise.all([
      this.prisma.imageAsset.count({
        where: { storageKey: ref.key, storageProvider: ref.provider },
      }),
      this.prisma.userProfile.count({ where: { avatarUrl: ref.key } }),
    ]);
    return images + avatars > 0;
  }

  private async forgetReservation(ref: PrivateObjectRef): Promise<void> {
    try {
      await this.prisma.privateStorageCleanup.deleteMany({
        where: {
          provider: ref.provider,
          storageKey: ref.key,
          reason: 'UPLOAD_PENDING',
        },
      });
    } catch {
      // Harmless: the expired reservation is processed by the cleaner, which
      // deletes idempotently (and never deletes a referenced object).
    }
  }
}

function backoffMs(attempts: number): number {
  return Math.min(
    CLEANUP_POLICY.baseBackoffMs * 2 ** (attempts - 1),
    CLEANUP_POLICY.maxBackoffMs,
  );
}
