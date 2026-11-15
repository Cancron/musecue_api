import { Inject, Injectable } from '@nestjs/common';
import type {
  AccountDeletionFile,
  AccountDeletionFileKind,
  AccountDeletionFileOutcome,
  AccountDeletionRequest,
  Prisma,
} from '@prisma/client';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import { AuthService } from '../../auth/auth.service';
import { PrismaService } from '../../common/services/prisma.service';
import {
  ACCOUNT_EXPORT_FILES,
  ACCOUNT_IMAGE_FILES,
  type PrivateFileStore,
} from '../../storage/private-file-store';
import {
  isOwnedPrivateImageKey,
  isStructurallySafeKey,
} from '../../storage/private-storage-key';
import { PRIVACY_EXPORT_FAILURES } from '../privacy-export.constants';
import { AccountDeletionCodeService } from './account-deletion-code.service';

/** How long one worker may hold a request before another may resume it. */
export const ERASURE_LEASE_MS = 5 * 60_000;
/**
 * Discovery passes per run: files written while the cleanup runs (for
 * example a temporary file of an export that was just stopped) are picked up
 * by the next pass; if files keep appearing, the next run continues.
 */
export const CLEANUP_DISCOVERY_PASSES = 3;
/** Token version cached for an erased account: no token ever matches it. */
const NO_VALID_TOKEN_VERSION = 0;
const FILE_KINDS: AccountDeletionFileKind[] = ['PRIVATE_IMAGE', 'EXPORT_FILE'];
const LEGACY_DIRECTORY_KINDS: AccountDeletionFileKind[] = [
  'IMAGE_OWNER_DIRECTORY',
  'EXPORT_OWNER_DIRECTORY',
];

export type ErasureOutcome =
  | 'COMPLETED'
  /** Some step is still pending (for example a file); it will be retried. */
  | 'PENDING'
  /** Another worker holds the request, or it is already completed. */
  | 'SKIPPED';

/** The account exists but is not pending deletion (for example reactivated). */
export class AccountNotPendingDeletionError extends Error {
  constructor() {
    super('The account is not pending deletion');
    this.name = 'AccountNotPendingDeletionError';
  }
}

/**
 * Permanently deletes an account whose deletion was accepted, in resumable
 * steps recorded on the AccountDeletionRequest. The account stays closed
 * (PENDING_DELETION, no token works) throughout, and is only deleted once
 * every private file is gone:
 *
 * 1. References (one transaction): stops the account's running exports so
 *    no new export file is written, and records every private file its rows
 *    reference (photos, avatar, export archives) as AccountDeletionFile.
 * 2. Files: lists the account's own storage through the private storage
 *    adapters (so unreferenced photos and temporary files are found too),
 *    records each file, then removes it. Before a removal the file must lie
 *    in the account's own scope and must not be referenced by another user;
 *    otherwise it is kept. A file already gone counts as handled. A storage
 *    error leaves the reference pending and the run incomplete; the account
 *    is not deleted and the next run retries from the saved references.
 * 3. Data (one transaction, only after every file is handled): deletes
 *    activity-log entries about the account, anonymizes its entries about
 *    shared records, and hard-deletes the account (cascading to all its
 *    rows; payments are kept, detached).
 * 4. Completion, once sessions are revoked as well.
 *
 * Every step is idempotent; a lease (`lockedUntil`) keeps concurrent workers
 * from processing the same request at once.
 */
@Injectable()
export class AccountErasureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly codes: AccountDeletionCodeService,
    @Inject(ACCOUNT_IMAGE_FILES) private readonly images: PrivateFileStore,
    @Inject(ACCOUNT_EXPORT_FILES)
    private readonly exportFiles: PrivateFileStore,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async process(
    requestId: string,
    now: Date = new Date(),
  ): Promise<ErasureOutcome> {
    const claimed = await this.prisma.accountDeletionRequest.updateMany({
      where: {
        id: requestId,
        status: { in: ['PENDING', 'PROCESSING'] },
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      data: {
        status: 'PROCESSING',
        lockedUntil: new Date(now.getTime() + ERASURE_LEASE_MS),
        attempts: { increment: 1 },
      },
    });
    if (!claimed.count) return 'SKIPPED';
    await this.prisma.accountDeletionRequest.updateMany({
      where: { id: requestId, processingStartedAt: null },
      data: { processingStartedAt: now },
    });

    let request = await this.prisma.accountDeletionRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    const problems: string[] = [];
    try {
      // Requests started before per-file cleanup erased their data first.
      if (!request.referencesRecordedAt && !request.dataErasedAt) {
        request = await this.recordReferences(request, now);
      }
      if (!request.sessionsRevokedAt) {
        request = await this.revokeSessions(request, problems);
      }
      if (!request.filesDeletedAt) {
        request = await this.cleanUpFiles(request, problems);
      }
      // Never delete the account before its private files are gone.
      if (request.filesDeletedAt && !request.dataErasedAt) {
        request = await this.eraseData(request, now);
      }
    } catch (error) {
      problems.push(this.describe(error));
    }

    if (
      problems.length === 0 &&
      request.sessionsRevokedAt &&
      request.filesDeletedAt &&
      request.dataErasedAt
    ) {
      await this.prisma.accountDeletionRequest.update({
        where: { id: request.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          lockedUntil: null,
          lastError: null,
        },
      });
      this.logger.info('Account deletion completed', {
        context: 'AccountErasure',
        requestId: request.id,
      });
      return 'COMPLETED';
    }

    // Release the lease so the next sweep resumes where this attempt stopped.
    await this.prisma.accountDeletionRequest.update({
      where: { id: request.id },
      data: {
        lockedUntil: null,
        lastError: (problems[0] ?? 'Waiting for a pending step').slice(0, 500),
      },
    });
    this.logger.warn('Account deletion will be resumed', {
      context: 'AccountErasure',
      requestId: request.id,
      problems,
    });
    return 'PENDING';
  }

  /** Step 1: stop exports and save the file references, atomically. */
  private recordReferences(
    request: AccountDeletionRequest,
    now: Date,
  ): Promise<AccountDeletionRequest> {
    const authId = request.authId;
    return this.prisma.$transaction(async (tx) => {
      await this.assertPendingDeletion(tx, authId);
      // A running export would write new files into the account's storage.
      // Its worker stops (and removes its own temporary file) once the export
      // is no longer waiting or running.
      await tx.dataExport.updateMany({
        where: { authId, status: { in: ['QUEUED', 'PROCESSING'] } },
        data: {
          status: 'FAILED',
          error: PRIVACY_EXPORT_FAILURES.ACCOUNT_UNAVAILABLE,
          errorCode: 'ACCOUNT_UNAVAILABLE',
          completedAt: now,
          storageKey: null,
        },
      });
      await tx.accountDeletionFile.createMany({
        data: (await this.referencedFiles(tx, authId)).map((file) => ({
          requestId: request.id,
          ...file,
        })),
        skipDuplicates: true,
      });
      return tx.accountDeletionRequest.update({
        where: { id: request.id },
        data: { referencesRecordedAt: now },
      });
    });
  }

  /** Private files the account's rows reference, inside its own scope. */
  private async referencedFiles(
    tx: Prisma.TransactionClient,
    authId: string,
  ): Promise<Array<{ kind: AccountDeletionFileKind; storageKey: string }>> {
    const files: Array<{ kind: AccountDeletionFileKind; storageKey: string }> =
      [];
    const images = await tx.imageAsset.findMany({
      where: { session: { authId } },
      select: { sessionId: true, storageKey: true, source: true },
    });
    for (const image of images) {
      if (
        image.source === 'PRIVATE_UPLOAD' &&
        isOwnedPrivateImageKey(image.storageKey, authId, image.sessionId)
      ) {
        files.push({ kind: 'PRIVATE_IMAGE', storageKey: image.storageKey });
      }
    }
    const profile = await tx.userProfile.findUnique({
      where: { authId },
      select: { avatarUrl: true },
    });
    // External avatars (URLs) are not private storage and never touched.
    if (
      profile?.avatarUrl &&
      isOwnedPrivateImageKey(profile.avatarUrl, authId, 'profile')
    ) {
      files.push({ kind: 'PRIVATE_IMAGE', storageKey: profile.avatarUrl });
    }
    const exports = await tx.dataExport.findMany({
      where: { authId, storageKey: { not: null } },
      select: { storageKey: true },
    });
    for (const { storageKey } of exports) {
      if (storageKey && this.isInOwnerScope(storageKey, authId)) {
        files.push({ kind: 'EXPORT_FILE', storageKey });
      }
    }
    return files;
  }

  /**
   * Step 2: finds, records and removes every private file of the account.
   * Returns the request with `filesDeletedAt` set only when all are handled.
   */
  private async cleanUpFiles(
    request: AccountDeletionRequest,
    problems: string[],
  ): Promise<AccountDeletionRequest> {
    const authId = request.authId;
    let settled = false;
    for (let pass = 0; pass < CLEANUP_DISCOVERY_PASSES && !settled; pass += 1) {
      const found = await this.discover(request, authId);
      const pending = await this.prisma.accountDeletionFile.findMany({
        where: {
          requestId: request.id,
          resolvedAt: null,
          kind: { in: FILE_KINDS },
        },
        orderBy: { storageKey: 'asc' },
      });
      for (const file of pending) {
        await this.resolveFile(file, authId, problems);
      }
      if (problems.length) return request;
      // Settled when a pass found nothing new to handle.
      settled = found === 0 && pending.length === 0;
    }
    if (!settled) {
      problems.push('New files kept appearing; the cleanup will continue');
      return request;
    }
    await this.images.removeEmptyOwnerDirectories(authId);
    await this.exportFiles.removeEmptyOwnerDirectories(authId);
    const now = new Date();
    // Legacy directory references are covered by the per-file cleanup.
    await this.prisma.accountDeletionFile.updateMany({
      where: {
        requestId: request.id,
        resolvedAt: null,
        kind: { in: LEGACY_DIRECTORY_KINDS },
      },
      data: { resolvedAt: now, outcome: 'DELETED' },
    });
    return this.prisma.accountDeletionRequest.update({
      where: { id: request.id },
      data: { filesDeletedAt: now },
    });
  }

  /**
   * Lists the account's storage and records every file not yet pending.
   * Returns how many files need handling because of this pass.
   */
  private async discover(
    request: AccountDeletionRequest,
    authId: string,
  ): Promise<number> {
    const stored = [
      ...(await this.images.listOwnerFiles(authId)).map((storageKey) => ({
        kind: 'PRIVATE_IMAGE' as const,
        storageKey,
      })),
      ...(await this.exportFiles.listOwnerFiles(authId)).map((storageKey) => ({
        kind: 'EXPORT_FILE' as const,
        storageKey,
      })),
    ];
    const created = await this.prisma.accountDeletionFile.createMany({
      data: stored.map((file) => ({ requestId: request.id, ...file })),
      skipDuplicates: true,
    });
    // A file that is back although it was handled (for example written
    // again) is handled again, unless it is kept on purpose.
    let reopened = 0;
    for (const kind of FILE_KINDS) {
      const keys = stored
        .filter((file) => file.kind === kind)
        .map((file) => file.storageKey);
      if (!keys.length) continue;
      const result = await this.prisma.accountDeletionFile.updateMany({
        where: {
          requestId: request.id,
          kind,
          storageKey: { in: keys },
          outcome: { in: ['DELETED', 'ALREADY_MISSING'] },
        },
        data: { resolvedAt: null, outcome: null },
      });
      reopened += result.count;
    }
    return created.count + reopened;
  }

  /** Removes one file, unless it is not the account's own or is shared. */
  private async resolveFile(
    file: AccountDeletionFile,
    authId: string,
    problems: string[],
  ): Promise<void> {
    if (!this.isInOwnerScope(file.storageKey, authId)) {
      return this.markResolved(file, 'RETAINED_NOT_OWNED');
    }
    if (await this.isSharedWithAnotherUser(file, authId)) {
      return this.markResolved(file, 'RETAINED_SHARED');
    }
    const store = file.kind === 'EXPORT_FILE' ? this.exportFiles : this.images;
    try {
      const removal = await store.remove(file.storageKey);
      await this.markResolved(
        file,
        removal === 'DELETED' ? 'DELETED' : 'ALREADY_MISSING',
      );
    } catch (error) {
      const reason = this.describe(error);
      problems.push(`File removal failed: ${reason}`);
      await this.prisma.accountDeletionFile.update({
        where: { id: file.id },
        data: { attempts: { increment: 1 }, lastError: reason.slice(0, 500) },
      });
    }
  }

  private async markResolved(
    file: AccountDeletionFile,
    outcome: AccountDeletionFileOutcome,
  ): Promise<void> {
    await this.prisma.accountDeletionFile.update({
      where: { id: file.id },
      data: {
        resolvedAt: new Date(),
        outcome,
        attempts: { increment: 1 },
        lastError: null,
      },
    });
  }

  /** Whether another user's record references the same stored file. */
  private async isSharedWithAnotherUser(
    file: AccountDeletionFile,
    authId: string,
  ): Promise<boolean> {
    const key = file.storageKey;
    if (file.kind === 'EXPORT_FILE') {
      return (
        (await this.prisma.dataExport.count({
          where: { storageKey: key, authId: { not: authId } },
        })) > 0
      );
    }
    const [images, avatars] = await Promise.all([
      this.prisma.imageAsset.count({
        where: { storageKey: key, session: { authId: { not: authId } } },
      }),
      this.prisma.userProfile.count({
        where: { avatarUrl: key, authId: { not: authId } },
      }),
    ]);
    return images + avatars > 0;
  }

  /** A structurally safe key inside `<authId>/`. */
  private isInOwnerScope(storageKey: string, authId: string): boolean {
    return (
      isStructurallySafeKey(storageKey) &&
      storageKey.split('/').length >= 2 &&
      storageKey.split('/')[0] === authId
    );
  }

  /** Step 3: hard deletion, only after every private file is handled. */
  private async eraseData(
    request: AccountDeletionRequest,
    now: Date,
  ): Promise<AccountDeletionRequest> {
    const authId = request.authId;
    let email: string | null = null;
    const erased = await this.prisma.$transaction(async (tx) => {
      email = await this.assertPendingDeletion(tx, authId);

      // Activity-log entries about the account itself are personal data.
      const subscription = await tx.userSubscription.findUnique({
        where: { authId },
        select: { id: true },
      });
      await tx.activityLogEvent.deleteMany({
        where: {
          OR: [
            { tableName: 'authUser', recordId: authId },
            ...(subscription
              ? [{ tableName: 'UserSubscription', recordId: subscription.id }]
              : []),
          ],
        },
      });
      // Entries the account made about shared records (for example an
      // administrator changing the subscription plan) stay as the platform's
      // audit trail, without anything that identifies the person.
      await tx.activityLogEvent.updateMany({
        where: { actionedBy: authId },
        data: {
          actionedBy: null,
          ipAddress: null,
          userAgent: null,
          device: null,
        },
      });

      // Hard delete. Foreign keys cascade to everything the account owns and
      // detach its payments (ON DELETE SET NULL).
      await tx.authUser.deleteMany({
        where: { id: authId, status: 'PENDING_DELETION' },
      });

      return tx.accountDeletionRequest.update({
        where: { id: request.id },
        data: { dataErasedAt: now },
      });
    });

    await this.auth.forgetDeletedAccount(authId, email).catch(() => undefined);
    await this.codes.forget(authId).catch(() => undefined);
    return erased;
  }

  /** Returns the account's email, or null if the account row is gone. */
  private async assertPendingDeletion(
    tx: Prisma.TransactionClient,
    authId: string,
  ): Promise<string | null> {
    const user = await tx.authUser.findUnique({
      where: { id: authId },
      select: { status: true, email: true },
    });
    if (user && user.status !== 'PENDING_DELETION') {
      throw new AccountNotPendingDeletionError();
    }
    return user?.email ?? null;
  }

  private async revokeSessions(
    request: AccountDeletionRequest,
    problems: string[],
  ): Promise<AccountDeletionRequest> {
    const user = await this.prisma.authUser.findUnique({
      where: { id: request.authId },
      select: { tokenVersion: true },
    });
    try {
      await this.auth.revokeAllSessions(
        request.authId,
        user?.tokenVersion ?? NO_VALID_TOKEN_VERSION,
      );
    } catch (error) {
      problems.push(`Session revocation failed: ${this.describe(error)}`);
      return request;
    }
    return this.prisma.accountDeletionRequest.update({
      where: { id: request.id },
      data: { sessionsRevokedAt: new Date() },
    });
  }

  /** Error class and code only: messages can contain private paths. */
  private describe(error: unknown): string {
    if (error instanceof AccountNotPendingDeletionError) return error.message;
    const name = error instanceof Error ? error.name : typeof error;
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? ` (${error.code})`
        : '';
    return `${name}${code}`;
  }
}
