import type {
  AccountDeletionFile,
  AccountDeletionFileKind,
  AccountDeletionRequest,
} from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'winston';
import {
  ControlledFileStore,
  type StorageOperation,
} from '../../../test/support/controlled-file-store';
import type { AuthService } from '../../auth/auth.service';
import type { PrismaService } from '../../common/services/prisma.service';
import type { AccountDeletionCodeService } from './account-deletion-code.service';
import {
  AccountErasureService,
  ERASURE_LEASE_MS,
} from './account-erasure.service';

const OWNER = '0a0a0a0a-0000-4000-8000-00000000000a';
const OTHER = '0b0b0b0b-0000-4000-8000-00000000000b';
const SESSION = 'c4c4c4c4-0000-4000-8000-000000000004';
const OTHER_SESSION = 'd5d5d5d5-0000-4000-8000-000000000005';
const EXPORT_ID = 'e3e3e3e3-0000-4000-8000-000000000003';
const uuid = (n: number) =>
  `${String(n).repeat(8)}-1111-4111-8111-111111111111`;

// The owner's private files.
const PHOTO = `${OWNER}/${SESSION}/${uuid(1)}.jpg`;
const SNAPSHOT = `${OWNER}/${SESSION}/${uuid(2)}.png`;
const AVATAR = `${OWNER}/profile/${uuid(3)}.webp`;
const ORPHAN = `${OWNER}/${SESSION}/${uuid(4)}.jpg`; // no row references it
const ARCHIVE = `${OWNER}/${EXPORT_ID}/${uuid(5)}.zip`;
const TEMPORARY = `${OWNER}/${EXPORT_ID}/${uuid(6)}.zip.partial`;
// Another user's files.
const OTHER_PHOTO = `${OTHER}/${OTHER_SESSION}/${uuid(7)}.jpg`;
const OTHER_ARCHIVE = `${OTHER}/${uuid(8)}/${uuid(9)}.zip`;
const T0 = new Date('2026-09-01T12:00:00.000Z');

/**
 * The erasure's database (request, file references, account rows and other
 * users' references) in memory, with rollback, plus the two controlled
 * storage adapters. `events` interleaves storage operations with the
 * account's hard deletion, so their order can be asserted.
 */
class ErasureWorld {
  readonly events: Array<StorageOperation | { op: 'erase-account' }> = [];
  readonly images = new ControlledFileStore(this.events as StorageOperation[]);
  readonly exports = new ControlledFileStore(this.events as StorageOperation[]);
  readonly prisma = mockDeep<PrismaService>();
  readonly auth = mock<AuthService>();
  request: AccountDeletionRequest;
  files: AccountDeletionFile[] = [];
  user: { status: string; email: string; tokenVersion: number } | null = {
    status: 'PENDING_DELETION',
    email: 'owner@example.com',
    tokenVersion: 2,
  };
  /** Image rows of the owner (storage key, session, source). */
  ownerImages = [
    { sessionId: SESSION, storageKey: PHOTO, source: 'PRIVATE_UPLOAD' },
    { sessionId: SESSION, storageKey: SNAPSHOT, source: 'PRIVATE_UPLOAD' },
    {
      sessionId: SESSION,
      storageKey: 'mock://capture',
      source: 'MOCK_CAPTURE',
    },
  ];
  ownerAvatar: string | null = AVATAR;
  ownerExports = [{ storageKey: ARCHIVE as string | null }];
  /** Keys referenced by OTHER users' rows (images/avatars, exports). */
  sharedImageKeys = new Set<string>();
  sharedExportKeys = new Set<string>();

  constructor() {
    this.request = {
      id: randomUUID(),
      authId: OWNER,
      status: 'PENDING',
      verificationMethod: 'PASSWORD_AND_EMAIL_CODE',
      requestedAt: T0,
      accountBlockedAt: T0,
      sessionsRevokedAt: T0,
      processingStartedAt: null,
      referencesRecordedAt: null,
      filesDeletedAt: null,
      dataErasedAt: null,
      completedAt: null,
      lockedUntil: null,
      attempts: 0,
      lastError: null,
      updatedAt: T0,
    };
    this.images.add(PHOTO, SNAPSHOT, AVATAR, ORPHAN, OTHER_PHOTO);
    this.exports.add(ARCHIVE, TEMPORARY, OTHER_ARCHIVE);
    this.auth.revokeAllSessions.mockResolvedValue();
    this.auth.forgetDeletedAccount.mockResolvedValue();
    this.wire();
  }

  service() {
    const codes = mock<AccountDeletionCodeService>();
    codes.forget.mockResolvedValue();
    return new AccountErasureService(
      this.prisma,
      this.auth,
      codes,
      this.images,
      this.exports,
      mock<Logger>(),
    );
  }

  file(kind: AccountDeletionFileKind, key: string) {
    return this.files.find(
      (item) => item.kind === kind && item.storageKey === key,
    );
  }

  private apply(
    target: Record<string, unknown>,
    data: Record<string, unknown>,
  ) {
    for (const [key, value] of Object.entries(data)) {
      target[key] =
        value && typeof value === 'object' && 'increment' in value
          ? (target[key] as number) + (value.increment as number)
          : value;
    }
  }

  private wire() {
    const prisma = this.prisma;
    prisma.$transaction.mockImplementation((async (
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => {
      const before = {
        request: { ...this.request },
        files: this.files.map((file) => ({ ...file })),
        user: this.user && { ...this.user },
      };
      try {
        return await callback(prisma);
      } catch (error) {
        this.request = before.request;
        this.files = before.files;
        this.user = before.user;
        throw error;
      }
    }) as never);

    // Request: claim with lease, updates.
    prisma.accountDeletionRequest.updateMany.mockImplementation(((args: {
      where: {
        OR?: Array<{ lockedUntil?: { lt: Date } | null }>;
        processingStartedAt?: null;
      };
      data: Record<string, unknown>;
    }) => {
      const request = this.request;
      if (args.where.OR) {
        const now = args.where.OR[1]?.lockedUntil?.lt ?? new Date();
        const free =
          ['PENDING', 'PROCESSING'].includes(request.status) &&
          (request.lockedUntil === null ||
            request.lockedUntil.getTime() < now.getTime());
        if (!free) return Promise.resolve({ count: 0 });
      }
      if ('processingStartedAt' in args.where && request.processingStartedAt) {
        return Promise.resolve({ count: 0 });
      }
      this.apply(request as never, args.data);
      return Promise.resolve({ count: 1 });
    }) as never);
    prisma.accountDeletionRequest.findUniqueOrThrow.mockImplementation((() =>
      Promise.resolve({ ...this.request })) as never);
    prisma.accountDeletionRequest.update.mockImplementation(((args: {
      data: Record<string, unknown>;
    }) => {
      this.apply(this.request as never, args.data);
      return Promise.resolve({ ...this.request });
    }) as never);

    // File references.
    prisma.accountDeletionFile.createMany.mockImplementation(((args: {
      data: Array<{
        requestId: string;
        kind: AccountDeletionFileKind;
        storageKey: string;
      }>;
    }) => {
      let count = 0;
      for (const item of args.data) {
        if (!this.file(item.kind, item.storageKey)) {
          this.files.push({
            id: randomUUID(),
            resolvedAt: null,
            outcome: null,
            attempts: 0,
            lastError: null,
            createdAt: T0,
            ...item,
          });
          count += 1;
        }
      }
      return Promise.resolve({ count });
    }) as never);
    prisma.accountDeletionFile.findMany.mockImplementation(((args: {
      where: { resolvedAt: null; kind: { in: string[] } };
    }) =>
      Promise.resolve(
        this.files
          .filter((file) => file.resolvedAt === null)
          .filter((file) => args.where.kind.in.includes(file.kind))
          .sort((a, b) => a.storageKey.localeCompare(b.storageKey))
          .map((file) => ({ ...file })),
      )) as never);
    prisma.accountDeletionFile.update.mockImplementation(((args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const file = this.files.find((item) => item.id === args.where.id)!;
      this.apply(file as never, args.data);
      return Promise.resolve({ ...file });
    }) as never);
    prisma.accountDeletionFile.updateMany.mockImplementation(((args: {
      where: {
        kind: AccountDeletionFileKind | { in: AccountDeletionFileKind[] };
        storageKey?: { in: string[] };
        outcome?: { in: string[] };
        resolvedAt?: null;
      };
      data: Record<string, unknown>;
    }) => {
      const kinds =
        typeof args.where.kind === 'string'
          ? [args.where.kind]
          : args.where.kind.in;
      const targets = this.files.filter(
        (file) =>
          kinds.includes(file.kind) &&
          (!args.where.storageKey ||
            args.where.storageKey.in.includes(file.storageKey)) &&
          (!args.where.outcome ||
            (file.outcome !== null &&
              args.where.outcome.in.includes(file.outcome))) &&
          (!('resolvedAt' in args.where) || file.resolvedAt === null),
      );
      for (const file of targets) this.apply(file as never, args.data);
      return Promise.resolve({ count: targets.length });
    }) as never);

    // The account and its rows.
    prisma.authUser.findUnique.mockImplementation((() =>
      Promise.resolve(this.user && { ...this.user })) as never);
    prisma.authUser.deleteMany.mockImplementation((() => {
      this.events.push({ op: 'erase-account' });
      this.user = null;
      return Promise.resolve({ count: 1 });
    }) as never);
    prisma.imageAsset.findMany.mockImplementation((() =>
      Promise.resolve(this.ownerImages)) as never);
    prisma.userProfile.findUnique.mockImplementation((() =>
      Promise.resolve(
        this.ownerAvatar ? { avatarUrl: this.ownerAvatar } : null,
      )) as never);
    prisma.dataExport.findMany.mockImplementation((() =>
      Promise.resolve(this.ownerExports)) as never);
    prisma.dataExport.updateMany.mockResolvedValue({ count: 1 });
    prisma.userSubscription.findUnique.mockResolvedValue(null);
    prisma.activityLogEvent.deleteMany.mockResolvedValue({ count: 0 });
    prisma.activityLogEvent.updateMany.mockResolvedValue({ count: 0 });

    // Other users' references (shared files).
    prisma.imageAsset.count.mockImplementation(((args: {
      where: { storageKey: string };
    }) =>
      Promise.resolve(
        this.sharedImageKeys.has(args.where.storageKey) ? 1 : 0,
      )) as never);
    prisma.userProfile.count.mockResolvedValue(0);
    prisma.dataExport.count.mockImplementation(((args: {
      where: { storageKey: string };
    }) =>
      Promise.resolve(
        this.sharedExportKeys.has(args.where.storageKey) ? 1 : 0,
      )) as never);
  }
}

const storageError = (code: string) =>
  Object.assign(new Error(`${code}: /srv/private/${OWNER}`), { code });

describe('Account file cleanup (privacy account deletion, controlled storage)', () => {
  let world: ErasureWorld;

  beforeEach(() => {
    world = new ErasureWorld();
  });

  describe('file deletion', () => {
    it('removes every photo, the avatar, unreferenced photos, export archives and temporary files through the adapters', async () => {
      await expect(world.service().process(world.request.id, T0)).resolves.toBe(
        'COMPLETED',
      );

      expect(world.images.removed().sort()).toEqual(
        [PHOTO, SNAPSHOT, AVATAR, ORPHAN].sort(),
      );
      expect(world.exports.removed().sort()).toEqual(
        [ARCHIVE, TEMPORARY].sort(),
      );
      // Each file was removed exactly once.
      expect(world.images.removalAttempts()).toHaveLength(4);
      expect(world.exports.removalAttempts()).toHaveLength(2);
      // Empty owner directories are pruned afterwards.
      for (const store of [world.images, world.exports]) {
        expect(store.operations.filter((op) => op.op === 'prune')).toEqual([
          { op: 'prune', target: OWNER, result: 'OK' },
        ]);
      }
    });

    it('does not delete the account before every file is removed', async () => {
      await world.service().process(world.request.id, T0);

      const eraseAt = world.events.findIndex(
        (event) => event.op === 'erase-account',
      );
      const lastRemoval = world.events
        .map((event) => event.op)
        .lastIndexOf('remove');
      expect(eraseAt).toBeGreaterThan(lastRemoval);
      expect(eraseAt).toBeGreaterThan(
        world.events.map((event) => event.op).lastIndexOf('prune'),
      );
    });

    it('stops the account’s running exports before it touches any file', async () => {
      await world.service().process(world.request.id, T0);

      expect(world.prisma.dataExport.updateMany.mock.calls[0][0]).toMatchObject(
        {
          where: { authId: OWNER, status: { in: ['QUEUED', 'PROCESSING'] } },
          data: { status: 'FAILED', errorCode: 'ACCOUNT_UNAVAILABLE' },
        },
      );
    });

    it('finds and removes a temporary file written while the cleanup runs', async () => {
      const late = `${OWNER}/${EXPORT_ID}/${uuid(9)}.zip.partial`;
      world.images.onRemove = (key) => {
        // An export attempt that was just stopped writes a last file.
        if (key === PHOTO) world.exports.add(late);
      };

      await world.service().process(world.request.id, T0);

      expect(world.exports.removed()).toContain(late);
      expect(world.exports.files.has(late)).toBe(false);
      const eraseAt = world.events.findIndex(
        (event) => event.op === 'erase-account',
      );
      const lateRemoval = world.events.findIndex(
        (event) =>
          event.op === 'remove' && 'target' in event && event.target === late,
      );
      expect(lateRemoval).toBeLessThan(eraseAt);
    });

    it('removes a file again if it reappears after being removed', async () => {
      let rewritten = false;
      world.exports.onRemove = (key) => {
        if (key === ARCHIVE && !rewritten) {
          rewritten = true;
          world.exports.add(ARCHIVE);
        }
      };

      await world.service().process(world.request.id, T0);

      expect(
        world.exports.removalAttempts().filter((key) => key === ARCHIVE),
      ).toHaveLength(2);
      expect(world.exports.files.has(ARCHIVE)).toBe(false);
    });
  });

  describe('file ownership', () => {
    it('never lists, removes or prunes another user’s storage', async () => {
      await world.service().process(world.request.id, T0);

      for (const store of [world.images, world.exports]) {
        expect(
          store.operations.every((op) => op.target.startsWith(OWNER)),
        ).toBe(true);
      }
      expect(world.images.files).toEqual(new Set([OTHER_PHOTO]));
      expect(world.exports.files).toEqual(new Set([OTHER_ARCHIVE]));
    });

    it('never touches a file the account’s rows reference outside its own scope', async () => {
      world.ownerImages.push(
        {
          sessionId: SESSION,
          storageKey: OTHER_PHOTO,
          source: 'PRIVATE_UPLOAD',
        },
        {
          sessionId: SESSION,
          storageKey: `${OWNER}/..\\${OTHER}\\${OTHER_SESSION}\\${uuid(7)}.jpg`,
          source: 'PRIVATE_UPLOAD',
        },
      );
      world.ownerExports.push({ storageKey: OTHER_ARCHIVE });
      world.ownerAvatar = 'https://lh3.googleusercontent.com/a/photo';

      await world.service().process(world.request.id, T0);

      const attempted = [
        ...world.images.removalAttempts(),
        ...world.exports.removalAttempts(),
      ];
      expect(attempted).not.toContain(OTHER_PHOTO);
      expect(attempted).not.toContain(OTHER_ARCHIVE);
      expect(
        attempted.some((key) => key.includes('\\') || key.includes('://')),
      ).toBe(false);
      expect(world.images.files.has(OTHER_PHOTO)).toBe(true);
      expect(world.exports.files.has(OTHER_ARCHIVE)).toBe(true);
      // Such keys are not even recorded as files of the account.
      expect(world.file('PRIVATE_IMAGE', OTHER_PHOTO)).toBeUndefined();
      expect(world.file('EXPORT_FILE', OTHER_ARCHIVE)).toBeUndefined();
    });

    it('keeps, never removes, a saved reference that points outside the account’s scope', async () => {
      // For example a reference saved by an older version, or corrupted.
      world.files.push({
        id: randomUUID(),
        requestId: world.request.id,
        kind: 'PRIVATE_IMAGE',
        storageKey: OTHER_PHOTO,
        resolvedAt: null,
        outcome: null,
        attempts: 0,
        lastError: null,
        createdAt: T0,
      });

      await expect(world.service().process(world.request.id, T0)).resolves.toBe(
        'COMPLETED',
      );

      expect(world.images.removalAttempts()).not.toContain(OTHER_PHOTO);
      expect(world.images.files.has(OTHER_PHOTO)).toBe(true);
      expect(world.file('PRIVATE_IMAGE', OTHER_PHOTO)?.outcome).toBe(
        'RETAINED_NOT_OWNED',
      );
    });

    it('keeps a file in the account’s folder that another user’s record also uses', async () => {
      world.sharedImageKeys.add(ORPHAN);
      world.sharedExportKeys.add(TEMPORARY);

      await expect(world.service().process(world.request.id, T0)).resolves.toBe(
        'COMPLETED',
      );

      expect(world.images.removalAttempts()).not.toContain(ORPHAN);
      expect(world.exports.removalAttempts()).not.toContain(TEMPORARY);
      expect(world.images.files.has(ORPHAN)).toBe(true);
      expect(world.exports.files.has(TEMPORARY)).toBe(true);
      expect(world.file('PRIVATE_IMAGE', ORPHAN)?.outcome).toBe(
        'RETAINED_SHARED',
      );
      expect(world.file('EXPORT_FILE', TEMPORARY)?.outcome).toBe(
        'RETAINED_SHARED',
      );
      // Everything else of the owner is removed.
      expect(world.images.removed().sort()).toEqual(
        [PHOTO, SNAPSHOT, AVATAR].sort(),
      );
    });

    it('does not touch storage for an account that is no longer pending deletion', async () => {
      world.user = {
        status: 'ACTIVE',
        email: 'owner@example.com',
        tokenVersion: 2,
      };

      await expect(world.service().process(world.request.id, T0)).resolves.toBe(
        'PENDING',
      );

      expect(world.images.operations).toEqual([]);
      expect(world.exports.operations).toEqual([]);
    });
  });

  describe('missing files', () => {
    it('treats a referenced file that is already gone as handled, and continues', async () => {
      world.images.files.delete(SNAPSHOT);
      world.images.respond(AVATAR, 'MISSING');

      await expect(world.service().process(world.request.id, T0)).resolves.toBe(
        'COMPLETED',
      );

      // Removal was attempted once for each missing file; no retry needed.
      expect(
        world.images.removalAttempts().filter((key) => key === SNAPSHOT),
      ).toEqual([SNAPSHOT]);
      expect(
        world.images.removalAttempts().filter((key) => key === AVATAR),
      ).toEqual([AVATAR]);
      expect(world.file('PRIVATE_IMAGE', SNAPSHOT)?.outcome).toBe(
        'ALREADY_MISSING',
      );
      expect(world.file('PRIVATE_IMAGE', AVATAR)?.outcome).toBe(
        'ALREADY_MISSING',
      );
      expect(world.images.removed().sort()).toEqual([PHOTO, ORPHAN].sort());
      expect(world.events.some((event) => event.op === 'erase-account')).toBe(
        true,
      );
    });

    it('handles an account with no files at all', async () => {
      world.images.files.clear();
      world.exports.files.clear();
      world.ownerImages = [];
      world.ownerAvatar = null;
      world.ownerExports = [];

      await expect(world.service().process(world.request.id, T0)).resolves.toBe(
        'COMPLETED',
      );

      expect(world.images.removalAttempts()).toEqual([]);
      expect(world.exports.removalAttempts()).toEqual([]);
    });
  });

  describe('storage errors', () => {
    it('keeps the account closed and the reference pending when a removal fails, then retries only that file', async () => {
      world.images.respond(SNAPSHOT, storageError('EIO'));

      await expect(world.service().process(world.request.id, T0)).resolves.toBe(
        'PENDING',
      );

      // Storage: every other file removed; the failing one is still there.
      expect(world.images.files.has(SNAPSHOT)).toBe(true);
      expect(world.images.removed().sort()).toEqual(
        [AVATAR, ORPHAN, PHOTO].sort(),
      );
      // The account is not deleted, and the reference is kept for the retry.
      expect(world.events.some((event) => event.op === 'erase-account')).toBe(
        false,
      );
      expect(world.user?.status).toBe('PENDING_DELETION');
      expect(world.file('PRIVATE_IMAGE', SNAPSHOT)).toMatchObject({
        resolvedAt: null,
        outcome: null,
        attempts: 1,
        lastError: 'Error (EIO)',
      });
      expect(world.request).toMatchObject({
        status: 'PROCESSING',
        filesDeletedAt: null,
        dataErasedAt: null,
        lockedUntil: null,
      });
      expect(world.request.lastError).not.toContain('/srv/');

      world.images.operations.length = 0;
      await expect(world.service().process(world.request.id, T0)).resolves.toBe(
        'COMPLETED',
      );

      // Only the failed file is removed on the retry.
      expect(world.images.removalAttempts()).toEqual([SNAPSHOT]);
      expect(world.images.files.has(SNAPSHOT)).toBe(false);
      expect(
        world.events.filter((event) => event.op === 'erase-account'),
      ).toHaveLength(1);
    });

    it('retries a persistently failing file on every run without ever deleting the account', async () => {
      world.exports.respond(
        ARCHIVE,
        storageError('EACCES'),
        storageError('EACCES'),
        storageError('EACCES'),
      );
      const service = world.service();

      for (let run = 1; run <= 3; run += 1) {
        await expect(service.process(world.request.id, T0)).resolves.toBe(
          'PENDING',
        );
        expect(world.file('EXPORT_FILE', ARCHIVE)?.attempts).toBe(run);
      }
      expect(
        world.exports.removalAttempts().filter((key) => key === ARCHIVE),
      ).toHaveLength(3);
      expect(world.events.some((event) => event.op === 'erase-account')).toBe(
        false,
      );
      expect(world.user?.status).toBe('PENDING_DELETION');

      await expect(service.process(world.request.id, T0)).resolves.toBe(
        'COMPLETED',
      );
      expect(world.exports.files.has(ARCHIVE)).toBe(false);
    });

    it('removes nothing and deletes nothing when the storage cannot be listed', async () => {
      world.images.failListing(storageError('EIO'));

      await expect(world.service().process(world.request.id, T0)).resolves.toBe(
        'PENDING',
      );

      expect(world.images.removalAttempts()).toEqual([]);
      expect(world.exports.removalAttempts()).toEqual([]);
      expect(world.events.some((event) => event.op === 'erase-account')).toBe(
        false,
      );
      // The references recorded before the listing are kept for the retry.
      expect(world.file('PRIVATE_IMAGE', PHOTO)?.resolvedAt).toBeNull();

      await expect(world.service().process(world.request.id, T0)).resolves.toBe(
        'COMPLETED',
      );
    });

    it('does not finish while the owner’s directories cannot be cleaned up', async () => {
      world.exports.failPruning(storageError('EBUSY'));

      await expect(world.service().process(world.request.id, T0)).resolves.toBe(
        'PENDING',
      );
      expect(world.request.filesDeletedAt).toBeNull();
      expect(world.events.some((event) => event.op === 'erase-account')).toBe(
        false,
      );

      await expect(world.service().process(world.request.id, T0)).resolves.toBe(
        'COMPLETED',
      );
    });
  });

  describe('resumption', () => {
    it('finishes the files of a request that erased its data first (before per-file cleanup)', async () => {
      world.request.dataErasedAt = T0;
      world.user = null;
      world.files.push({
        id: randomUUID(),
        requestId: world.request.id,
        kind: 'IMAGE_OWNER_DIRECTORY',
        storageKey: OWNER,
        resolvedAt: null,
        outcome: null,
        attempts: 0,
        lastError: null,
        createdAt: T0,
      });

      await expect(world.service().process(world.request.id, T0)).resolves.toBe(
        'COMPLETED',
      );

      expect(world.images.removed().sort()).toEqual(
        [PHOTO, SNAPSHOT, AVATAR, ORPHAN].sort(),
      );
      expect(
        world.file('IMAGE_OWNER_DIRECTORY', OWNER)?.resolvedAt,
      ).toBeInstanceOf(Date);
    });

    it('lets only one worker hold a request, until its lease expires', async () => {
      world.request.status = 'PROCESSING';
      world.request.lockedUntil = new Date(T0.getTime() + ERASURE_LEASE_MS);

      await expect(world.service().process(world.request.id, T0)).resolves.toBe(
        'SKIPPED',
      );
      expect(world.images.operations).toEqual([]);

      const later = new Date(T0.getTime() + ERASURE_LEASE_MS + 1);
      await expect(
        world.service().process(world.request.id, later),
      ).resolves.toBe('COMPLETED');
    });

    it('does nothing once completed', async () => {
      const service = world.service();
      await service.process(world.request.id, T0);
      const operations = world.events.length;

      await expect(service.process(world.request.id, T0)).resolves.toBe(
        'SKIPPED',
      );

      expect(world.events).toHaveLength(operations);
    });
  });
});
