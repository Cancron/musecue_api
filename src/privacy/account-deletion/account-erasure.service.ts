import { Inject, Injectable } from '@nestjs/common';
import type {
  AccountDeletionFile,
  AccountDeletionFileKind,
  AccountDeletionFileStatus,
  AccountDeletionRequest,
  Prisma,
} from '@prisma/client';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import { AuthService } from '../../auth/auth.service';
import { PrismaService } from '../../common/services/prisma.service';
import { PrivateImageStorageService } from '../../storage/private-image-storage.service';
import {
  isMissingFileError,
  isOwnedPrivateImageKey,
  isStructurallySafeKey,
} from '../../storage/private-storage-key';
import { PrivacyExportStorageService } from '../../storage/privacy-export-storage.service';
import { PRIVACY_EXPORT_FAILURES } from '../privacy-export.constants';
import { AccountDeletionCodeService } from './account-deletion-code.service';

/** How long one worker may hold a request before another may resume it. */
export const ERASURE_LEASE_MS = 5 * 60_000;
/** Token version cached for an erased account: no token ever matches it. */
const NO_VALID_TOKEN_VERSION = 0;

export const FILE_NOTES = {
  SHARED: 'Referenced by another account',
  OUT_OF_SCOPE: "Outside the account's storage scope",
} as const;

export type ErasureOutcome =
  | 'COMPLETED'
  /** Some step is still pending (for example a file); it will be retried. */
  | 'PENDING'
  /** Another worker holds the request, or it is already completed. */
  | 'SKIPPED';

/** How many times one pass re-checks storage after resolving references. */
const VERIFICATION_ROUNDS = 3;

/**
 * This worker's processing lease was taken over (it expired and another
 * worker claimed the request): stop without writing anything else.
 */
export class ErasureLeaseLostError extends Error {
  constructor() {
    super('The processing lease was lost');
    this.name = 'ErasureLeaseLostError';
  }
}

/** The account exists but is not pending deletion (for example reactivated). */
export class AccountNotPendingDeletionError extends Error {
  constructor() {
    super('The account is not pending deletion');
    this.name = 'AccountNotPendingDeletionError';
  }
}

type FileReference = {
  kind: AccountDeletionFileKind;
  storageKey: string;
  storageProvider?: string;
};
type FileResolution = {
  status: Exclude<AccountDeletionFileStatus, 'PENDING'>;
  note?: string;
};

/**
 * Permanently erases an account whose deletion was accepted, in resumable
 * steps recorded on the AccountDeletionRequest. The account stays closed
 * (PENDING_DELETION, no token works) until the last step:
 *
 * 1. Record files (transaction): stops the account's running exports and
 *    records every private file as an AccountDeletionFile reference: each
 *    photo and avatar, each generated export archive, and the owner's image
 *    and export directories (for unreferenced and temporary files).
 * 2. Delete files through the private storage adapters. Each reference ends
 *    DELETED, MISSING (already gone) or RETAINED (another account references
 *    the file, or it lies outside the account's scope); a storage error
 *    leaves it PENDING with the error, to be retried. The adapters refuse any
 *    key outside the account's own directory.
 * 3. Only when every reference is resolved: hard-delete the account and all
 *    its data in one transaction (payments are kept, detached).
 * 4. Complete once sessions are revoked.
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
    let request = await this.prisma.accountDeletionRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    // The claim's attempt number is this worker's fencing token: every later
    // write is conditional on it, so a worker whose lease was taken over can
    // never write (or delete files) again.
    const lease = new ErasureLease(this.prisma, requestId, request.attempts);
    await this.prisma.accountDeletionRequest.updateMany({
      where: { id: requestId, processingStartedAt: null },
      data: { processingStartedAt: now },
    });

    const problems: string[] = [];
    try {
      if (!request.filesRecordedAt) {
        request = await this.recordFiles(request, lease, now);
      }
      if (!request.filesDeletedAt) {
        const unresolved = await this.deleteFiles(
          request,
          lease,
          problems,
          now,
        );
        if (unresolved === 0) {
          request = await lease.update({ filesDeletedAt: new Date() });
        }
      }
      // The account is only deleted once its private files are gone.
      if (request.filesDeletedAt && !request.dataErasedAt) {
        request = await this.eraseData(request, lease);
      }
      if (!request.sessionsRevokedAt) {
        request = await this.revokeSessions(request, lease, problems);
      }
      // Final storage check, after the account's rows are gone: a request
      // that was already running when the deletion was approved (for example
      // a photo upload) may have written a file in the meantime. From now on
      // no writer can succeed (its database write fails and it removes its
      // own file), so a clean check here is final.
      if (request.dataErasedAt) {
        const leftover = await this.deleteFiles(request, lease, problems, now);
        if (leftover > 0 && problems.length === 0) {
          problems.push('Files remain in storage; cleanup will be retried');
        }
      }
    } catch (error) {
      if (error instanceof ErasureLeaseLostError) {
        this.logger.warn('Account deletion lease taken over; stopping', {
          context: 'AccountErasure',
          requestId,
        });
        return 'SKIPPED';
      }
      problems.push(this.describe(error));
    }

    try {
      if (
        problems.length === 0 &&
        request.filesDeletedAt &&
        request.dataErasedAt &&
        request.sessionsRevokedAt
      ) {
        await lease.update({
          status: 'COMPLETED',
          completedAt: new Date(),
          lockedUntil: null,
          lastError: null,
        });
        this.logger.info('Account deletion completed', {
          context: 'AccountErasure',
          requestId: request.id,
        });
        return 'COMPLETED';
      }

      // Release the lease so the next sweep resumes where this attempt stopped.
      await lease.update({
        lockedUntil: null,
        lastError: (problems[0] ?? 'Waiting for a pending step').slice(0, 500),
      });
    } catch (error) {
      if (error instanceof ErasureLeaseLostError) return 'SKIPPED';
      throw error;
    }
    this.logger.warn('Account deletion will be resumed', {
      context: 'AccountErasure',
      requestId: request.id,
      problems,
    });
    return 'PENDING';
  }

  /** Step 1: stop running exports and record every file, atomically. */
  private async recordFiles(
    request: AccountDeletionRequest,
    lease: ErasureLease,
    now: Date,
  ): Promise<AccountDeletionRequest> {
    const authId = request.authId;
    return this.prisma.$transaction(async (tx) => {
      await lease.renew(tx);
      const user = await tx.authUser.findUnique({
        where: { id: authId },
        select: { status: true },
      });
      if (user && user.status !== 'PENDING_DELETION') {
        throw new AccountNotPendingDeletionError();
      }
      // Cancel running exports. This takes the export rows' locks, which
      // their workers' file fences also take: from here on no worker can
      // create or publish an archive file (it can only finish writing and
      // remove a file it already opened, under its worker lease).
      await tx.dataExport.updateMany({
        where: { authId, status: { in: ['QUEUED', 'PROCESSING'] } },
        data: {
          status: 'FAILED',
          error: PRIVACY_EXPORT_FAILURES.ACCOUNT_UNAVAILABLE,
          errorCode: 'ACCOUNT_UNAVAILABLE',
          completedAt: now,
        },
      });
      await tx.accountDeletionFile.createMany({
        data: (await this.collectFiles(tx, authId)).map((file) => ({
          requestId: request.id,
          ...file,
        })),
        skipDuplicates: true,
      });
      return lease.update({ filesRecordedAt: new Date() }, tx);
    });
  }

  /**
   * Pending/failed cleanup can be the only reference to an orphan image.
   * Keep its provider in the erasure scan even when it is unavailable, so
   * erasure waits for recovery rather than reporting that storage is clean.
   */
  private async imageProviders(
    tx: Prisma.TransactionClient,
    authId: string,
    referenced: string[] = [],
  ): Promise<string[]> {
    const cleanup = await tx.privateStorageCleanup.findMany({
      where: { storageKey: { startsWith: authId + '/' } },
      select: { provider: true },
      distinct: ['provider'],
    });
    const providers = new Set(
      (this.images.registeredProviderIds ?? ['local']).filter(
        (provider) =>
          !this.images.isAvailable || this.images.isAvailable(provider),
      ),
    );
    for (const provider of referenced) providers.add(provider);
    for (const row of cleanup ?? []) providers.add(row.provider);
    return [...providers].sort();
  }

  /** Every private file the account has. */
  private async collectFiles(
    tx: Prisma.TransactionClient,
    authId: string,
  ): Promise<FileReference[]> {
    const files: FileReference[] = [];
    const images = await tx.imageAsset.findMany({
      where: { session: { authId } },
      select: {
        sessionId: true,
        storageKey: true,
        storageProvider: true,
        source: true,
      },
    });
    for (const image of images) {
      // Only private uploads inside the owner's own scope; shared assets
      // (mock captures, URLs) and foreign keys are never recorded.
      if (
        image.source === 'PRIVATE_UPLOAD' &&
        isOwnedPrivateImageKey(image.storageKey, authId, image.sessionId)
      ) {
        files.push({
          kind: 'PRIVATE_IMAGE',
          storageKey: image.storageKey,
          storageProvider: image.storageProvider ?? 'local',
        });
      }
    }
    const profile = await tx.userProfile.findUnique({
      where: { authId },
      select: { avatarUrl: true, avatarStorageProvider: true },
    });
    if (
      profile?.avatarUrl &&
      isOwnedPrivateImageKey(profile.avatarUrl, authId, 'profile')
    ) {
      files.push({
        kind: 'PRIVATE_IMAGE',
        storageKey: profile.avatarUrl,
        storageProvider: profile.avatarStorageProvider ?? 'local',
      });
    }
    const archives = await tx.dataExport.findMany({
      where: { authId, storageKey: { not: null } },
      select: { storageKey: true },
    });
    for (const archive of archives) {
      if (
        archive.storageKey &&
        this.isInOwnerScope(archive.storageKey, authId)
      ) {
        files.push({ kind: 'EXPORT_ARCHIVE', storageKey: archive.storageKey });
      }
    }
    // Directory sweeps catch files no row references (and partial archives).
    files.push({ kind: 'EXPORT_OWNER_DIRECTORY', storageKey: authId });
    const referencedProviders = files
      .filter((file) => file.kind === 'PRIVATE_IMAGE')
      .map((file) => file.storageProvider ?? 'local');
    for (const provider of await this.imageProviders(
      tx,
      authId,
      referencedProviders,
    )) {
      files.push({
        kind: 'IMAGE_OWNER_DIRECTORY',
        storageKey: authId,
        storageProvider: provider,
      });
    }
    return files;
  }

  /**
   * Step 2: deletes the account's files. Waits while any export worker of
   * the account may still write; then resolves every pending reference, and
   * re-lists storage until nothing is left (every leftover is recorded as a
   * reference before it is deleted). Returns how many references are still
   * unresolved (0 = storage is clean).
   */
  private async deleteFiles(
    request: AccountDeletionRequest,
    lease: ErasureLease,
    problems: string[],
    now: Date,
  ): Promise<number> {
    const activeWorkers = await this.prisma.dataExport.count({
      where: { authId: request.authId, workerLeaseUntil: { gt: now } },
    });
    if (activeWorkers > 0) {
      problems.push(
        `Waiting for ${activeWorkers} export worker(s) of the account to stop`,
      );
      return activeWorkers;
    }

    for (let round = 0; round < VERIFICATION_ROUNDS; round += 1) {
      const unresolved = await this.resolvePendingFiles(
        request,
        lease,
        problems,
      );
      if (unresolved > 0) return unresolved;
      const leftovers = await this.recordLeftovers(request, lease);
      if (leftovers === 0) return 0;
    }
    problems.push('Files keep appearing in storage; cleanup will be retried');
    return 1;
  }

  /** Resolves every pending reference; returns how many stay pending. */
  private async resolvePendingFiles(
    request: AccountDeletionRequest,
    lease: ErasureLease,
    problems: string[],
  ): Promise<number> {
    const pending = await this.prisma.accountDeletionFile.findMany({
      where: { requestId: request.id, status: 'PENDING' },
    });
    // Single files first, then the directory sweeps.
    pending.sort(
      (a, b) =>
        this.order(a.kind) - this.order(b.kind) || a.id.localeCompare(b.id),
    );
    let unresolved = 0;
    for (const file of pending) {
      // Never touch storage without holding the lease.
      await lease.renew();
      let resolution: FileResolution;
      try {
        resolution = await this.resolveFile(request.authId, file);
      } catch (error) {
        unresolved += 1;
        const description = this.describe(error);
        problems.push(`File deletion failed: ${description}`);
        await this.recordFile(lease, file, {
          attempts: { increment: 1 },
          lastError: description.slice(0, 200),
        });
        continue;
      }
      await this.recordFile(lease, file, {
        status: resolution.status,
        note: resolution.note ?? null,
        attempts: { increment: 1 },
        lastError: null,
        resolvedAt: new Date(),
      });
    }
    return unresolved;
  }

  /** Updates a pending reference, only while this worker holds the lease. */
  private async recordFile(
    lease: ErasureLease,
    file: AccountDeletionFile,
    data: Prisma.AccountDeletionFileUpdateManyMutationInput,
  ): Promise<void> {
    const updated = await this.prisma.accountDeletionFile.updateMany({
      where: {
        id: file.id,
        status: 'PENDING',
        request: { is: { attempts: lease.token } },
      },
      data,
    });
    if (!updated.count) throw new ErasureLeaseLostError();
  }

  /**
   * Lists the account's storage once more. Files still present (for example
   * written by an export worker just before it was cancelled, or files that
   * reappeared) are recorded as PENDING references; returns how many.
   */
  private async recordLeftovers(
    request: AccountDeletionRequest,
    lease: ErasureLease,
  ): Promise<number> {
    const authId = request.authId;
    const retained = new Set(
      (
        await this.prisma.accountDeletionFile.findMany({
          where: { requestId: request.id, status: 'RETAINED' },
          select: { storageKey: true, storageProvider: true },
        })
      ).map(
        (file) => (file.storageProvider ?? 'local') + ':' + file.storageKey,
      ),
    );
    const leftovers: FileReference[] = [];
    for (const provider of await this.imageProviders(this.prisma, authId)) {
      for (const key of await this.images.listOwnerFiles(authId, provider)) {
        if (
          !retained.has(provider + ':' + key) &&
          !(await this.isSharedImage(key, authId, provider))
        ) {
          leftovers.push({
            kind: 'PRIVATE_IMAGE',
            storageKey: key,
            storageProvider: provider,
          });
        }
      }
    }
    for (const key of await this.exports.listOwnerFiles(authId)) {
      leftovers.push({ kind: 'EXPORT_ARCHIVE', storageKey: key });
    }
    if (!leftovers.length) return 0;

    await this.prisma.$transaction(async (tx) => {
      await lease.renew(tx);
      await tx.accountDeletionFile.createMany({
        data: leftovers.map((file) => ({ requestId: request.id, ...file })),
        skipDuplicates: true,
      });
      // A file that was resolved before but is back must be deleted again.
      for (const file of leftovers) {
        await tx.accountDeletionFile.updateMany({
          where: {
            requestId: request.id,
            kind: file.kind,
            storageKey: file.storageKey,
            storageProvider: file.storageProvider ?? 'local',
            status: { in: ['DELETED', 'MISSING'] },
          },
          data: {
            status: 'PENDING',
            resolvedAt: null,
            note: 'Found in storage again',
          },
        });
      }
    });
    return leftovers.length;
  }

  private async resolveFile(
    authId: string,
    file: AccountDeletionFile,
  ): Promise<FileResolution> {
    switch (file.kind) {
      case 'PRIVATE_IMAGE': {
        if (!this.isInOwnerScope(file.storageKey, authId)) {
          return { status: 'RETAINED', note: FILE_NOTES.OUT_OF_SCOPE };
        }
        if (
          await this.isSharedImage(
            file.storageKey,
            authId,
            file.storageProvider,
          )
        ) {
          return { status: 'RETAINED', note: FILE_NOTES.SHARED };
        }
        return this.deleteOne(() =>
          file.storageProvider && file.storageProvider !== 'local'
            ? this.images.deleteOwnerFile(
                authId,
                file.storageKey,
                file.storageProvider,
              )
            : this.images.deleteOwnerFile(authId, file.storageKey),
        );
      }
      case 'EXPORT_ARCHIVE': {
        if (!this.isInOwnerScope(file.storageKey, authId)) {
          return { status: 'RETAINED', note: FILE_NOTES.OUT_OF_SCOPE };
        }
        return this.deleteOne(() =>
          this.exports.deleteOwnerFile(authId, file.storageKey),
        );
      }
      case 'IMAGE_OWNER_DIRECTORY':
        return this.sweepOwnerDirectory(
          authId,
          file,
          {
            listOwnerFiles: (owner) =>
              file.storageProvider && file.storageProvider !== 'local'
                ? this.images.listOwnerFiles(owner, file.storageProvider)
                : this.images.listOwnerFiles(owner),
            deleteOwnerFile: (owner, key) =>
              file.storageProvider && file.storageProvider !== 'local'
                ? this.images.deleteOwnerFile(owner, key, file.storageProvider)
                : this.images.deleteOwnerFile(owner, key),
            pruneOwnerDirectories: (owner) =>
              file.storageProvider && file.storageProvider !== 'local'
                ? this.images.pruneOwnerDirectories(owner, file.storageProvider)
                : this.images.pruneOwnerDirectories(owner),
          },
          (key) => this.isSharedImage(key, authId, file.storageProvider),
        );
      case 'EXPORT_OWNER_DIRECTORY':
        // Archives (finished and partial) are never shared.
        return this.sweepOwnerDirectory(authId, file, this.exports, () =>
          Promise.resolve(false),
        );
    }
  }

  /** Deletes one file; a missing file is MISSING, not an error. */
  private async deleteOne(
    remove: () => Promise<boolean>,
  ): Promise<FileResolution> {
    try {
      return { status: (await remove()) ? 'DELETED' : 'MISSING' };
    } catch (error) {
      if (isMissingFileError(error)) return { status: 'MISSING' };
      throw error;
    }
  }

  /**
   * Deletes every file left in the owner's directory except files another
   * account references, then removes the empty directories. Every file is
   * attempted even after a failure; the first failure is then reported so
   * the sweep is retried.
   */
  private async sweepOwnerDirectory(
    authId: string,
    reference: AccountDeletionFile,
    storage: Pick<
      PrivateImageStorageService,
      'listOwnerFiles' | 'deleteOwnerFile' | 'pruneOwnerDirectories'
    >,
    isShared: (storageKey: string) => Promise<boolean>,
  ): Promise<FileResolution> {
    const keys = await storage.listOwnerFiles(authId);
    let retained = 0;
    let failure: unknown;
    for (const key of keys) {
      try {
        if (await isShared(key)) {
          retained += 1;
          continue;
        }
        await this.deleteOne(() => storage.deleteOwnerFile(authId, key));
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) {
      throw failure instanceof Error
        ? failure
        : new Error('Storage cleanup failed');
    }
    await storage.pruneOwnerDirectories(authId);
    if (retained) {
      return {
        status: 'RETAINED',
        note: `${FILE_NOTES.SHARED}: ${retained} file(s) kept`,
      };
    }
    // Empty on a retry means an earlier attempt already deleted the files.
    return {
      status: keys.length || reference.attempts > 0 ? 'DELETED' : 'MISSING',
    };
  }

  /** Whether any other account still references this image key. */
  private async isSharedImage(
    storageKey: string,
    authId: string,
    provider = 'local',
  ): Promise<boolean> {
    const [images, avatars] = await Promise.all([
      this.prisma.imageAsset.count({
        where: {
          storageKey,
          storageProvider: provider,
          session: { authId: { not: authId } },
        },
      }),
      this.prisma.userProfile.count({
        where: {
          avatarUrl: storageKey,
          avatarStorageProvider: provider,
          authId: { not: authId },
        },
      }),
    ]);
    return images + avatars > 0;
  }

  private isInOwnerScope(storageKey: string, authId: string): boolean {
    const segments = storageKey.split('/');
    return (
      isStructurallySafeKey(storageKey) &&
      segments.length >= 2 &&
      segments[0] === authId
    );
  }

  private order(kind: AccountDeletionFileKind): number {
    return kind === 'IMAGE_OWNER_DIRECTORY' || kind === 'EXPORT_OWNER_DIRECTORY'
      ? 1
      : 0;
  }

  /** Step 3 (transaction): hard deletion, only after the files are gone. */
  private async eraseData(
    request: AccountDeletionRequest,
    lease: ErasureLease,
  ): Promise<AccountDeletionRequest> {
    const authId = request.authId;
    let email: string | null = null;
    const erased = await this.prisma.$transaction(async (tx) => {
      await lease.renew(tx);
      const user = await tx.authUser.findUnique({
        where: { id: authId },
        select: { status: true, email: true },
      });
      if (user && user.status !== 'PENDING_DELETION') {
        throw new AccountNotPendingDeletionError();
      }
      email = user?.email ?? null;

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
      // Entries the account made about shared records stay as the platform's
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

      return lease.update({ dataErasedAt: new Date() }, tx);
    });

    await this.auth.forgetDeletedAccount(authId, email).catch(() => undefined);
    await this.codes.forget(authId).catch(() => undefined);
    return erased;
  }

  private async revokeSessions(
    request: AccountDeletionRequest,
    lease: ErasureLease,
    problems: string[],
  ): Promise<AccountDeletionRequest> {
    try {
      await this.auth.revokeAllSessions(request.authId, NO_VALID_TOKEN_VERSION);
    } catch (error) {
      problems.push(`Session revocation failed: ${this.describe(error)}`);
      return request;
    }
    return lease.update({ sessionsRevokedAt: new Date() });
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

/**
 * The processing lease of one erasure worker. `token` is the request's
 * attempt number at claim time; only the worker that made the latest claim
 * can renew the lease or write the request.
 */
class ErasureLease {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requestId: string,
    readonly token: number,
  ) {}

  /** Extends the lease; throws ErasureLeaseLostError if it was taken over. */
  async renew(
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const renewed = await client.accountDeletionRequest.updateMany({
      where: { id: this.requestId, attempts: this.token },
      data: { lockedUntil: new Date(Date.now() + ERASURE_LEASE_MS) },
    });
    if (!renewed.count) throw new ErasureLeaseLostError();
  }

  /** Writes the request only while holding the lease. */
  async update(
    data: Prisma.AccountDeletionRequestUpdateManyMutationInput,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<AccountDeletionRequest> {
    const updated = await client.accountDeletionRequest.updateMany({
      where: { id: this.requestId, attempts: this.token },
      data,
    });
    if (!updated.count) throw new ErasureLeaseLostError();
    return client.accountDeletionRequest.findUniqueOrThrow({
      where: { id: this.requestId },
    });
  }
}
