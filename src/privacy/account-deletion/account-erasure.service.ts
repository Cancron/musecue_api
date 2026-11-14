import { Inject, Injectable } from '@nestjs/common';
import type {
  AccountDeletionFile,
  AccountDeletionFileKind,
  AccountDeletionRequest,
  Prisma,
} from '@prisma/client';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import { AuthService } from '../../auth/auth.service';
import { PrismaService } from '../../common/services/prisma.service';
import { PrivateImageStorageService } from '../../storage/private-image-storage.service';
import { isOwnedPrivateImageKey } from '../../storage/private-storage-key';
import { PrivacyExportStorageService } from '../../storage/privacy-export-storage.service';
import { AccountDeletionCodeService } from './account-deletion-code.service';

/** How long one worker may hold a request before another may resume it. */
export const ERASURE_LEASE_MS = 5 * 60_000;
/** Token version cached for an erased account: no token ever matches it. */
const NO_VALID_TOKEN_VERSION = 0;

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
 * Permanently erases an account whose deletion was accepted, in resumable
 * steps recorded on the AccountDeletionRequest:
 *
 * 1. Data (one transaction): records every storage reference of the account
 *    (AccountDeletionFile: each private image, and the owner's image and
 *    export directories), deletes activity-log entries about the account,
 *    anonymizes the account's entries about shared records, and hard-deletes
 *    the authUser row. Foreign keys cascade to every row the account owns;
 *    payments are kept and detached (subscriptionId NULL). Either all of this
 *    commits, with the references, or nothing does.
 * 2. Files: deletes each referenced file or directory and records it, so a
 *    storage failure is retried from the saved references.
 * 3. Completion once sessions are revoked, data erased and files deleted.
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
    private readonly images: PrivateImageStorageService,
    private readonly exports: PrivacyExportStorageService,
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
      if (!request.dataErasedAt) {
        request = await this.eraseData(request, now);
      }
      if (!request.sessionsRevokedAt) {
        request = await this.revokeSessions(request, problems);
      }
      const remainingFiles = await this.deleteFiles(request, problems);
      if (remainingFiles === 0 && !request.filesDeletedAt) {
        request = await this.prisma.accountDeletionRequest.update({
          where: { id: request.id },
          data: { filesDeletedAt: new Date() },
        });
      }
    } catch (error) {
      problems.push(this.describe(error));
    }

    if (
      problems.length === 0 &&
      request.dataErasedAt &&
      request.sessionsRevokedAt &&
      request.filesDeletedAt
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

  /** Step 1: references and hard deletion, atomically. */
  private async eraseData(
    request: AccountDeletionRequest,
    now: Date,
  ): Promise<AccountDeletionRequest> {
    const authId = request.authId;
    let email: string | null = null;
    const erased = await this.prisma.$transaction(async (tx) => {
      const user = await tx.authUser.findUnique({
        where: { id: authId },
        select: { status: true, email: true },
      });
      if (user && user.status !== 'PENDING_DELETION') {
        throw new AccountNotPendingDeletionError();
      }
      email = user?.email ?? null;

      await tx.accountDeletionFile.createMany({
        data: (await this.collectFiles(tx, authId)).map((file) => ({
          requestId: request.id,
          ...file,
        })),
        skipDuplicates: true,
      });

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

  /** Every file the account has in private storage. */
  private async collectFiles(
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
      // Only keys inside the owner's own scope are ever deleted; a corrupted
      // reference can never remove another user's file.
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
    if (
      profile?.avatarUrl &&
      isOwnedPrivateImageKey(profile.avatarUrl, authId, 'profile')
    ) {
      files.push({ kind: 'PRIVATE_IMAGE', storageKey: profile.avatarUrl });
    }
    // The owner's directories catch files no row references any more, and
    // every export archive.
    files.push(
      { kind: 'IMAGE_OWNER_DIRECTORY', storageKey: authId },
      { kind: 'EXPORT_OWNER_DIRECTORY', storageKey: authId },
    );
    return files;
  }

  private async revokeSessions(
    request: AccountDeletionRequest,
    problems: string[],
  ): Promise<AccountDeletionRequest> {
    try {
      await this.auth.revokeAllSessions(request.authId, NO_VALID_TOKEN_VERSION);
    } catch (error) {
      problems.push(`Session revocation failed: ${this.describe(error)}`);
      return request;
    }
    return this.prisma.accountDeletionRequest.update({
      where: { id: request.id },
      data: { sessionsRevokedAt: new Date() },
    });
  }

  /** Step 2: returns how many referenced files are still not deleted. */
  private async deleteFiles(
    request: AccountDeletionRequest,
    problems: string[],
  ): Promise<number> {
    const pending = await this.prisma.accountDeletionFile.findMany({
      where: { requestId: request.id, deletedAt: null },
      orderBy: { kind: 'asc' },
    });
    let remaining = 0;
    for (const file of pending) {
      try {
        await this.deleteFile(file);
        await this.prisma.accountDeletionFile.update({
          where: { id: file.id },
          data: { deletedAt: new Date() },
        });
      } catch (error) {
        remaining += 1;
        problems.push(`File deletion failed: ${this.describe(error)}`);
      }
    }
    return remaining;
  }

  private async deleteFile(file: AccountDeletionFile): Promise<void> {
    switch (file.kind) {
      case 'PRIVATE_IMAGE':
        return this.images.delete(file.storageKey);
      case 'IMAGE_OWNER_DIRECTORY':
        return this.images.deleteOwnerDirectory(file.storageKey);
      case 'EXPORT_OWNER_DIRECTORY':
        return this.exports.deleteOwnerDirectory(file.storageKey);
    }
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
