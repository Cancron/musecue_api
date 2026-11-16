import type {
  AccountDeletionFile,
  AccountDeletionRequest,
  Prisma,
} from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'winston';
import type { AuthService } from '../../auth/auth.service';
import type { PrismaService } from '../../common/services/prisma.service';
import type { PrivateImageStorageService } from '../../storage/private-image-storage.service';
import type { PrivacyExportStorageService } from '../../storage/privacy-export-storage.service';
import type { AccountDeletionCodeService } from './account-deletion-code.service';
import {
  AccountErasureService,
  ERASURE_LEASE_MS,
  FILE_NOTES,
} from './account-erasure.service';

const OWNER = '0a0a0a0a-0000-4000-8000-00000000000a';
const OTHER = '0b0b0b0b-0000-4000-8000-00000000000b';
const SESSION = 'c4c4c4c4-0000-4000-8000-000000000004';
const EXPORT_ID = 'e3e3e3e3-0000-4000-8000-000000000003';
const T0 = new Date('2026-09-01T12:00:00.000Z');

const PHOTO = `${OWNER}/${SESSION}/11111111-1111-4111-8111-111111111111.jpg`;
const SNAPSHOT = `${OWNER}/${SESSION}/44444444-4444-4444-8444-444444444444.png`;
const AVATAR = `${OWNER}/profile/22222222-2222-4222-8222-222222222222.png`;
const ORPHAN = `${OWNER}/${SESSION}/orphan-without-row.jpg`;
/** In the owner's scope, but another account's row references it too. */
const SHARED = `${OWNER}/${SESSION}/55555555-5555-4555-8555-555555555555.jpg`;
const OTHER_PHOTO = `${OTHER}/d5d5d5d5-0000-4000-8000-000000000005/33333333-3333-4333-8333-333333333333.jpg`;
const ARCHIVE = `${OWNER}/${EXPORT_ID}/66666666-6666-4666-8666-666666666666.zip`;
const PARTIAL = `${OWNER}/${EXPORT_ID}/77777777-7777-4777-8777-777777777777.zip.partial`;
const OTHER_ARCHIVE = `${OTHER}/f0f0f0f0-0000-4000-8000-00000000000f/88888888-8888-4888-8888-888888888888.zip`;

const storageError = (code: string) =>
  Object.assign(new Error(`${code}: /srv/private/${OWNER}/secret`), { code });

/**
 * A private storage adapter whose responses the test controls. It holds a
 * set of keys and records every operation; scripted failures are consumed
 * per key (or per owner for listing and pruning) in order.
 */
class ScriptedStorage {
  readonly files: Set<string>;
  readonly deleteFailures = new Map<string, Error[]>();
  readonly listFailures: Error[] = [];
  readonly pruneFailures: Error[] = [];
  /** Keys whose deletion reports "missing" even if listed (raced away). */
  readonly reportMissing = new Set<string>();
  readonly calls: Array<[string, ...string[]]> = [];
  /** Runs before each operation (to simulate concurrent writers/workers). */
  beforeOperation: (operation: string, key?: string) => void = () => {};

  constructor(keys: string[]) {
    this.files = new Set(keys);
  }

  readonly listOwnerFiles = jest.fn((authId: string) => {
    this.beforeOperation('list');
    this.calls.push(['list', authId]);
    const failure = this.listFailures.shift();
    if (failure) return Promise.reject(failure);
    return Promise.resolve(
      [...this.files].filter((key) => key.startsWith(`${authId}/`)).sort(),
    );
  });

  readonly deleteOwnerFile = jest.fn((authId: string, key: string) => {
    this.beforeOperation('delete', key);
    this.calls.push(['delete', authId, key]);
    const failure = this.deleteFailures.get(key)?.shift();
    if (failure) return Promise.reject(failure);
    if (this.reportMissing.has(key)) {
      this.files.delete(key);
      return Promise.reject(storageError('ENOENT'));
    }
    return Promise.resolve(this.files.delete(key));
  });

  readonly pruneOwnerDirectories = jest.fn((authId: string) => {
    this.beforeOperation('prune');
    this.calls.push(['prune', authId]);
    const failure = this.pruneFailures.shift();
    return failure ? Promise.reject(failure) : Promise.resolve();
  });

  failDelete(key: string, ...errors: Error[]): void {
    this.deleteFailures.set(key, errors);
  }

  deletedKeys(): string[] {
    return this.calls
      .filter(([operation]) => operation === 'delete')
      .map((call) => call[2]);
  }
}

describe('AccountErasureService private file cleanup (scripted storage)', () => {
  let prisma: ReturnType<typeof mockDeep<PrismaService>>;
  let images: ScriptedStorage;
  let exportsStorage: ScriptedStorage;
  let service: AccountErasureService;
  let request: AccountDeletionRequest;
  let fileRows: AccountDeletionFile[];
  let userStatus: 'PENDING_DELETION' | 'ACTIVE' | null;
  let sharedKeys: Set<string>;
  let ownImages: Array<{
    sessionId: string;
    storageKey: string;
    source: string;
  }>;
  let activeExportWorkers: number;

  function wirePrisma() {
    prisma = mockDeep<PrismaService>();
    const apply = (
      target: Record<string, unknown>,
      data: Record<string, unknown>,
    ) => {
      for (const [key, value] of Object.entries(data)) {
        target[key] =
          value && typeof value === 'object' && 'increment' in value
            ? (target[key] as number) + (value.increment as number)
            : value;
      }
    };
    prisma.accountDeletionRequest.updateMany.mockImplementation(((args: {
      where: Prisma.AccountDeletionRequestWhereInput;
      data: Record<string, unknown>;
    }) => {
      if (args.where.OR) {
        const now = (
          args.where.OR as Array<{ lockedUntil: { lt: Date } }>
        )[1].lockedUntil.lt.getTime();
        const free =
          ['PENDING', 'PROCESSING'].includes(request.status) &&
          (request.lockedUntil === null || request.lockedUntil.getTime() < now);
        if (!free) return Promise.resolve({ count: 0 });
      }
      if (
        'processingStartedAt' in args.where &&
        request.processingStartedAt !== null
      ) {
        return Promise.resolve({ count: 0 });
      }
      // Lease-guarded writes: only the holder of the latest claim.
      if (
        typeof args.where.attempts === 'number' &&
        args.where.attempts !== request.attempts
      ) {
        return Promise.resolve({ count: 0 });
      }
      apply(request as unknown as Record<string, unknown>, args.data);
      return Promise.resolve({ count: 1 });
    }) as never);
    prisma.accountDeletionRequest.findUniqueOrThrow.mockImplementation((() =>
      Promise.resolve({ ...request })) as never);
    prisma.accountDeletionRequest.update.mockImplementation(((args: {
      data: Record<string, unknown>;
    }) => {
      apply(request as unknown as Record<string, unknown>, args.data);
      return Promise.resolve({ ...request });
    }) as never);
    prisma.accountDeletionFile.createMany.mockImplementation(((args: {
      data: Array<
        Pick<AccountDeletionFile, 'requestId' | 'kind' | 'storageKey'>
      >;
    }) => {
      for (const file of args.data) {
        fileRows.push({
          id: randomUUID(),
          status: 'PENDING',
          storageProvider: 'local',
          attempts: 0,
          lastError: null,
          note: null,
          resolvedAt: null,
          createdAt: T0,
          ...file,
        });
      }
      return Promise.resolve({ count: args.data.length });
    }) as never);
    prisma.accountDeletionFile.findMany.mockImplementation(((args: {
      where: { status: string };
    }) =>
      Promise.resolve(
        fileRows
          .filter((file) => file.status === args.where.status)
          .map((file) => ({ ...file })),
      )) as never);
    prisma.accountDeletionFile.updateMany.mockImplementation(((args: {
      where: {
        id?: string;
        status?: string | { in: string[] };
        kind?: string;
        storageKey?: string;
        request?: { is: { attempts: number } };
      };
      data: Record<string, unknown>;
    }) => {
      if (
        args.where.request &&
        args.where.request.is.attempts !== request.attempts
      ) {
        return Promise.resolve({ count: 0 });
      }
      const targets = fileRows.filter(
        (file) =>
          (args.where.id === undefined || file.id === args.where.id) &&
          (args.where.kind === undefined || file.kind === args.where.kind) &&
          (args.where.storageKey === undefined ||
            file.storageKey === args.where.storageKey) &&
          (args.where.status === undefined ||
            (typeof args.where.status === 'string'
              ? file.status === args.where.status
              : args.where.status.in.includes(file.status))),
      );
      for (const file of targets) {
        apply(file as unknown as Record<string, unknown>, args.data);
      }
      return Promise.resolve({ count: targets.length });
    }) as never);
    prisma.dataExport.count.mockImplementation((() =>
      Promise.resolve(activeExportWorkers)) as never);
    prisma.accountDeletionFile.update.mockImplementation(((args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const file = fileRows.find((item) => item.id === args.where.id)!;
      apply(file as unknown as Record<string, unknown>, args.data);
      return Promise.resolve({ ...file });
    }) as never);
    prisma.$transaction.mockImplementation((async (
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => {
      const before = {
        request: { ...request },
        files: fileRows.map((file) => ({ ...file })),
      };
      try {
        return await callback(prisma);
      } catch (error) {
        request = before.request;
        fileRows = before.files;
        throw error;
      }
    }) as never);
    prisma.authUser.findUnique.mockImplementation((() =>
      Promise.resolve(
        userStatus ? { status: userStatus, email: 'owner@example.com' } : null,
      )) as never);
    prisma.authUser.deleteMany.mockResolvedValue({ count: 1 });
    prisma.imageAsset.findMany.mockImplementation((() =>
      Promise.resolve(ownImages)) as never);
    prisma.userProfile.findUnique.mockResolvedValue({
      avatarUrl: AVATAR,
    } as never);
    prisma.dataExport.findMany.mockResolvedValue([
      { storageKey: ARCHIVE },
      // A corrupted archive reference pointing at another user's archive.
      { storageKey: OTHER_ARCHIVE },
    ] as never);
    prisma.dataExport.updateMany.mockResolvedValue({ count: 1 });
    // Sharing: another account's image row or avatar references the key.
    prisma.imageAsset.count.mockImplementation(((args: {
      where: { storageKey: string };
    }) =>
      Promise.resolve(sharedKeys.has(args.where.storageKey) ? 1 : 0)) as never);
    prisma.userProfile.count.mockResolvedValue(0);
    prisma.userSubscription.findUnique.mockResolvedValue(null);
    prisma.activityLogEvent.deleteMany.mockResolvedValue({ count: 0 });
    prisma.activityLogEvent.updateMany.mockResolvedValue({ count: 0 });
  }

  beforeEach(() => {
    request = {
      id: randomUUID(),
      authId: OWNER,
      status: 'PENDING',
      verificationMethod: 'PASSWORD_AND_EMAIL_CODE',
      requestedAt: T0,
      accountBlockedAt: T0,
      sessionsRevokedAt: T0,
      processingStartedAt: null,
      filesRecordedAt: null,
      dataErasedAt: null,
      filesDeletedAt: null,
      completedAt: null,
      lockedUntil: null,
      attempts: 0,
      lastError: null,
      updatedAt: T0,
    };
    fileRows = [];
    userStatus = 'PENDING_DELETION';
    sharedKeys = new Set();
    activeExportWorkers = 0;
    ownImages = [
      { sessionId: SESSION, storageKey: PHOTO, source: 'PRIVATE_UPLOAD' },
      { sessionId: SESSION, storageKey: SNAPSHOT, source: 'PRIVATE_UPLOAD' },
      // Shared, non-private assets are never storage operations.
      {
        sessionId: SESSION,
        storageKey: 'mock://capture/1',
        source: 'MOCK_CAPTURE',
      },
      {
        sessionId: SESSION,
        storageKey: 'https://cdn.example.com/look.jpg',
        source: 'PRIVATE_UPLOAD',
      },
      // Corrupted references pointing at another user's file.
      { sessionId: SESSION, storageKey: OTHER_PHOTO, source: 'PRIVATE_UPLOAD' },
      {
        sessionId: SESSION,
        storageKey: `${OWNER}/..\\${OTHER}\\x.jpg`,
        source: 'PRIVATE_UPLOAD',
      },
    ];
    images = new ScriptedStorage([
      PHOTO,
      SNAPSHOT,
      AVATAR,
      ORPHAN,
      OTHER_PHOTO,
    ]);
    exportsStorage = new ScriptedStorage([ARCHIVE, PARTIAL, OTHER_ARCHIVE]);
    wirePrisma();
    const auth = mock<AuthService>();
    auth.revokeAllSessions.mockResolvedValue();
    auth.forgetDeletedAccount.mockResolvedValue();
    const codes = mock<AccountDeletionCodeService>();
    codes.forget.mockResolvedValue();
    service = new AccountErasureService(
      prisma,
      auth,
      codes,
      images as unknown as PrivateImageStorageService,
      exportsStorage as unknown as PrivacyExportStorageService,
      mock<Logger>(),
    );
  });

  const run = (at: Date = T0) => service.process(request.id, at);
  const accountDeleted = () => prisma.authUser.deleteMany.mock.calls.length > 0;
  const allOperations = () => [...images.calls, ...exportsStorage.calls];

  describe('file deletion', () => {
    it('deletes every photo, avatar, export archive and temporary file of the account through the adapters', async () => {
      await expect(run()).resolves.toBe('COMPLETED');

      // Referenced photos and avatar, then the directory sweep's leftovers.
      expect(images.deletedKeys().sort()).toEqual(
        [PHOTO, SNAPSHOT, AVATAR, ORPHAN].sort(),
      );
      // The published archive, then the partial (temporary) archive.
      expect(exportsStorage.deletedKeys().sort()).toEqual(
        [ARCHIVE, PARTIAL].sort(),
      );
      // Every operation is scoped to the account's own directory.
      for (const call of allOperations()) expect(call[1]).toBe(OWNER);
      expect(images.pruneOwnerDirectories.mock.calls).toEqual([[OWNER]]);
      expect(exportsStorage.pruneOwnerDirectories.mock.calls).toEqual([
        [OWNER],
      ]);
      expect([...images.files]).toEqual([OTHER_PHOTO]);
      expect([...exportsStorage.files]).toEqual([OTHER_ARCHIVE]);
    });

    it('deletes each file once: a file deleted individually is not deleted again by the sweep', async () => {
      await run();

      const deletions = [
        ...images.deletedKeys(),
        ...exportsStorage.deletedKeys(),
      ];
      expect(new Set(deletions).size).toBe(deletions.length);
    });

    it('deletes the files before the account: no storage operation happens after the hard delete', async () => {
      await run();

      const deleteOrder =
        prisma.authUser.deleteMany.mock.invocationCallOrder[0];
      const storageOrders = [
        ...images.deleteOwnerFile.mock.invocationCallOrder,
        ...images.pruneOwnerDirectories.mock.invocationCallOrder,
        ...exportsStorage.deleteOwnerFile.mock.invocationCallOrder,
        ...exportsStorage.pruneOwnerDirectories.mock.invocationCallOrder,
      ];
      expect(Math.max(...storageOrders)).toBeLessThan(deleteOrder);
      // ...and running exports were stopped before any file was recorded.
      expect(
        prisma.dataExport.updateMany.mock.invocationCallOrder[0],
      ).toBeLessThan(Math.min(...storageOrders));
      expect(prisma.dataExport.updateMany.mock.calls[0][0]).toMatchObject({
        where: { authId: OWNER, status: { in: ['QUEUED', 'PROCESSING'] } },
        data: { status: 'FAILED', errorCode: 'ACCOUNT_UNAVAILABLE' },
      });
    });
  });

  describe('file ownership', () => {
    it('never issues a storage operation for another account’s file, even from corrupted references', async () => {
      await run();

      const touched = allOperations().flatMap((call) => call.slice(1));
      for (const foreign of [OTHER_PHOTO, OTHER_ARCHIVE, OTHER]) {
        expect(touched).not.toContain(foreign);
      }
      expect(touched.some((value) => value.includes('\\'))).toBe(false);
      expect(touched.some((value) => value.includes('://'))).toBe(false);
    });

    it('records no reference to another account’s file (collection check)', async () => {
      await run();

      const recorded = fileRows.map((file) => file.storageKey);
      expect(recorded).not.toContain(OTHER_PHOTO);
      expect(recorded).not.toContain(OTHER_ARCHIVE);
      expect(
        recorded.every((key) => key === OWNER || key.startsWith(`${OWNER}/`)),
      ).toBe(true);
    });

    it('retains a tampered reference outside the account’s scope without any storage operation (deletion check)', async () => {
      // References already recorded, one of them tampered with.
      request.filesRecordedAt = T0;
      fileRows.push(
        ...[
          { kind: 'PRIVATE_IMAGE' as const, storageKey: OTHER_PHOTO },
          { kind: 'EXPORT_ARCHIVE' as const, storageKey: OTHER_ARCHIVE },
        ].map((file) => ({
          id: randomUUID(),
          requestId: request.id,
          status: 'PENDING' as const,
          storageProvider: 'local',
          attempts: 0,
          lastError: null,
          note: null,
          resolvedAt: null,
          createdAt: T0,
          ...file,
        })),
      );

      await run();

      for (const key of [OTHER_PHOTO, OTHER_ARCHIVE]) {
        expect(fileRows.find((file) => file.storageKey === key)).toMatchObject({
          status: 'RETAINED',
          note: FILE_NOTES.OUT_OF_SCOPE,
        });
      }
      // No operation ever targets the foreign keys (the verification pass
      // still cleans the account's own files, in its own scope).
      const touched = allOperations().flatMap((call) => call.slice(1));
      expect(touched).not.toContain(OTHER_PHOTO);
      expect(touched).not.toContain(OTHER_ARCHIVE);
      for (const call of allOperations()) expect(call[1]).toBe(OWNER);
      expect(images.files.has(OTHER_PHOTO)).toBe(true);
      expect(exportsStorage.files.has(OTHER_ARCHIVE)).toBe(true);
    });

    it('keeps a file that another account references, and still deletes the rest', async () => {
      images.files.add(SHARED);
      ownImages.push({
        sessionId: SESSION,
        storageKey: SHARED,
        source: 'PRIVATE_UPLOAD',
      });
      sharedKeys.add(SHARED);

      await expect(run()).resolves.toBe('COMPLETED');

      expect(images.deletedKeys()).not.toContain(SHARED);
      expect(images.files.has(SHARED)).toBe(true);
      expect(images.deletedKeys()).toEqual(
        expect.arrayContaining([PHOTO, SNAPSHOT, AVATAR, ORPHAN]),
      );
      expect(fileRows.find((file) => file.storageKey === SHARED)).toMatchObject(
        {
          kind: 'PRIVATE_IMAGE',
          status: 'RETAINED',
          note: FILE_NOTES.SHARED,
        },
      );
      // The sweep also leaves it alone and says so.
      expect(
        fileRows.find((file) => file.kind === 'IMAGE_OWNER_DIRECTORY'),
      ).toMatchObject({ status: 'RETAINED' });
    });

    it('keeps a file that another account references even when only the sweep finds it', async () => {
      images.files.add(SHARED);
      sharedKeys.add(SHARED);

      await run();

      expect(images.deletedKeys()).not.toContain(SHARED);
      expect(images.files.has(SHARED)).toBe(true);
    });
  });

  describe('missing files', () => {
    it('treats files already missing from storage as cleaned up (reported or thrown as ENOENT)', async () => {
      images.files.delete(PHOTO); // adapter reports "missing" (false)
      images.reportMissing.add(AVATAR); // adapter throws ENOENT

      await expect(run()).resolves.toBe('COMPLETED');

      expect(fileRows.find((file) => file.storageKey === PHOTO)?.status).toBe(
        'MISSING',
      );
      expect(fileRows.find((file) => file.storageKey === AVATAR)?.status).toBe(
        'MISSING',
      );
      expect(accountDeleted()).toBe(true);
    });

    it('treats an owner directory with nothing left as cleaned up', async () => {
      images.files.clear();
      exportsStorage.files.clear();

      await expect(run()).resolves.toBe('COMPLETED');

      expect(
        fileRows
          .filter((file) => file.kind.endsWith('OWNER_DIRECTORY'))
          .map((file) => file.status),
      ).toEqual(['MISSING', 'MISSING']);
    });
  });

  describe('storage errors', () => {
    it('keeps the account closed and undeleted while a file cannot be deleted, and retries only what is left', async () => {
      images.failDelete(PHOTO, storageError('EIO'), storageError('EIO'));

      await expect(run()).resolves.toBe('PENDING');

      // Not deleted: no hard delete, the deletion is incomplete.
      expect(accountDeleted()).toBe(false);
      expect(request).toMatchObject({
        status: 'PROCESSING',
        filesDeletedAt: null,
        dataErasedAt: null,
        completedAt: null,
        lockedUntil: null,
        lastError: 'File deletion failed: Error (EIO)',
      });
      // The reference is kept, pending, with the (path-free) error.
      expect(fileRows.find((file) => file.storageKey === PHOTO)).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        lastError: 'Error (EIO)',
      });
      expect(JSON.stringify(fileRows)).not.toContain('/srv/');
      // The directory sweep hit the same error and stays pending too, but it
      // still deleted every other file it could.
      expect(
        fileRows.find((file) => file.kind === 'IMAGE_OWNER_DIRECTORY')?.status,
      ).toBe('PENDING');
      expect(images.files.has(ORPHAN)).toBe(false);

      // Storage recovers: only the unresolved references are retried.
      images.calls.length = 0;
      exportsStorage.calls.length = 0;
      await expect(run()).resolves.toBe('COMPLETED');

      expect(images.deletedKeys()).toEqual([PHOTO]);
      expect(exportsStorage.deletedKeys()).toEqual([]);
      expect(accountDeleted()).toBe(true);
    });

    it('never deletes the account while deletion keeps failing', async () => {
      images.failDelete(
        PHOTO,
        ...Array.from({ length: 10 }, () => storageError('EACCES')),
      );

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await expect(run()).resolves.toBe('PENDING');
      }

      expect(accountDeleted()).toBe(false);
      expect(request.status).toBe('PROCESSING');
      expect(fileRows.find((file) => file.storageKey === PHOTO)).toMatchObject({
        status: 'PENDING',
        attempts: 4,
      });
      // The photo was attempted on every run, never silently dropped.
      expect(
        images.deletedKeys().filter((key) => key === PHOTO).length,
      ).toBeGreaterThanOrEqual(4);
    });

    it.each([
      [
        'listing the directory',
        (s: ScriptedStorage) => s.listFailures.push(storageError('EACCES')),
      ],
      [
        'removing empty directories',
        (s: ScriptedStorage) => s.pruneFailures.push(storageError('EBUSY')),
      ],
    ])(
      'keeps the deletion incomplete when %s fails, then completes',
      async (_label, script) => {
        script(exportsStorage);

        await expect(run()).resolves.toBe('PENDING');
        expect(accountDeleted()).toBe(false);
        expect(
          fileRows.find((file) => file.kind === 'EXPORT_OWNER_DIRECTORY')
            ?.status,
        ).toBe('PENDING');

        await expect(run()).resolves.toBe('COMPLETED');
        expect(accountDeleted()).toBe(true);
      },
    );

    it('never deletes a resolved file again, even if a later step fails: later passes only re-check storage', async () => {
      prisma.authUser.deleteMany.mockRejectedValueOnce(
        new Error('connection lost'),
      );

      await expect(run()).resolves.toBe('PENDING');
      expect(request.filesDeletedAt).not.toBeNull();
      expect(request.dataErasedAt).toBeNull();
      const deletesBefore = [
        ...images.deletedKeys(),
        ...exportsStorage.deletedKeys(),
      ];
      const operationsBefore = allOperations().length;

      await expect(run()).resolves.toBe('COMPLETED');

      const newOperations = allOperations().slice(operationsBefore);
      // Only the read-only final storage check (one listing per storage).
      expect(newOperations.map((call) => call[0])).toEqual(['list', 'list']);
      expect([
        ...images.deletedKeys(),
        ...exportsStorage.deletedKeys(),
      ]).toEqual(deletesBefore);
    });
  });

  describe('active export workers', () => {
    it('does not touch storage or complete while an export worker of the account may still write', async () => {
      activeExportWorkers = 1;

      await expect(run()).resolves.toBe('PENDING');

      expect(allOperations()).toEqual([]);
      expect(accountDeleted()).toBe(false);
      expect(request).toMatchObject({
        status: 'PROCESSING',
        filesDeletedAt: null,
        lastError: 'Waiting for 1 export worker(s) of the account to stop',
      });
      // Running exports were cancelled first, so the worker will stop.
      expect(prisma.dataExport.updateMany.mock.calls[0][0]).toMatchObject({
        data: { status: 'FAILED' },
      });
      // The check uses worker leases that are still live.
      expect(prisma.dataExport.count.mock.calls[0][0]).toEqual({
        where: { authId: OWNER, workerLeaseUntil: { gt: T0 } },
      });

      activeExportWorkers = 0;
      await expect(run()).resolves.toBe('COMPLETED');
      expect(exportsStorage.deletedKeys().sort()).toEqual(
        [ARCHIVE, PARTIAL].sort(),
      );
    });

    it('records and deletes a file that a worker left while cleanup was running, before completing', async () => {
      const LATE = `${OWNER}/${EXPORT_ID}/99999999-9999-4999-8999-999999999999.zip.partial`;
      let written = false;
      // The worker finishes writing its partial archive right after the
      // export directory sweep.
      exportsStorage.beforeOperation = (operation) => {
        if (operation === 'prune' && !written) {
          written = true;
          exportsStorage.files.add(LATE);
        }
      };

      await expect(run()).resolves.toBe('COMPLETED');

      expect(exportsStorage.deletedKeys()).toContain(LATE);
      expect(exportsStorage.files.size).toBe(1); // only the other user's archive
      const late = fileRows.find((file) => file.storageKey === LATE);
      expect(late).toMatchObject({ kind: 'EXPORT_ARCHIVE', status: 'DELETED' });
      // Recorded as a reference before it was deleted.
      const recordedAt = Math.max(
        ...prisma.accountDeletionFile.createMany.mock.invocationCallOrder,
      );
      const deleteCalls = exportsStorage.deleteOwnerFile.mock.calls;
      const deletedAt =
        exportsStorage.deleteOwnerFile.mock.invocationCallOrder[
          deleteCalls.findIndex(([, key]) => key === LATE)
        ];
      expect(deletedAt).toBeGreaterThan(recordedAt);
    });

    it('never completes while files keep appearing in storage', async () => {
      let counter = 0;
      exportsStorage.beforeOperation = (operation) => {
        if (operation === 'list') {
          counter += 1;
          exportsStorage.files.add(
            `${OWNER}/${EXPORT_ID}/late-${counter}.zip.partial`,
          );
        }
      };

      await expect(run()).resolves.toBe('PENDING');

      expect(accountDeleted()).toBe(false);
      expect(request.filesDeletedAt).toBeNull();
      expect(request.lastError).toBe(
        'Files keep appearing in storage; cleanup will be retried',
      );
    });
  });

  describe('requests already running when the deletion was approved', () => {
    const UPLOAD = `${OWNER}/${SESSION}/12121212-1212-4212-8212-121212121212.jpg`;
    /** An upload that was in flight saves its file while the rows are deleted. */
    const uploadDuringHardDelete = () => {
      prisma.authUser.deleteMany.mockImplementation((() => {
        images.files.add(UPLOAD);
        return Promise.resolve({ count: 1 });
      }) as never);
    };

    it('finds, records and deletes a file written during the hard delete before completing', async () => {
      uploadDuringHardDelete();

      await expect(run()).resolves.toBe('COMPLETED');

      expect(images.deletedKeys()).toContain(UPLOAD);
      expect(images.files.has(UPLOAD)).toBe(false);
      expect(fileRows.find((file) => file.storageKey === UPLOAD)).toMatchObject(
        { kind: 'PRIVATE_IMAGE', status: 'DELETED' },
      );
    });

    it('does not complete while that file cannot be deleted', async () => {
      uploadDuringHardDelete();
      images.failDelete(UPLOAD, storageError('EIO'));

      await expect(run()).resolves.toBe('PENDING');

      expect(request.status).toBe('PROCESSING');
      expect(request.completedAt).toBeNull();
      expect(images.files.has(UPLOAD)).toBe(true);
      expect(fileRows.find((file) => file.storageKey === UPLOAD)?.status).toBe(
        'PENDING',
      );

      await expect(run()).resolves.toBe('COMPLETED');
      expect(images.files.has(UPLOAD)).toBe(false);
    });
  });

  describe('interrupted and concurrent processing', () => {
    it('resumes without losing a reference when recording a deletion fails (database interruption)', async () => {
      const realUpdate =
        prisma.accountDeletionFile.updateMany.getMockImplementation()!;
      let failed = false;
      prisma.accountDeletionFile.updateMany.mockImplementation(((
        args: never,
      ) => {
        if (!failed) {
          failed = true;
          return Promise.reject(new Error('connection reset'));
        }
        return realUpdate(args);
      }) as never);

      await expect(run()).resolves.toBe('PENDING');

      // One file was deleted from storage, but its outcome was not recorded:
      // the reference is still pending, and the account is not deleted.
      expect(accountDeleted()).toBe(false);
      // The first deletion on either storage (processing order follows the
      // references' random IDs).
      const firstDeleted = allOperations().find(
        (call) => call[0] === 'delete',
      )![2];
      expect(
        fileRows.find((file) => file.storageKey === firstDeleted)?.status,
      ).toBe('PENDING');

      await expect(run()).resolves.toBe('COMPLETED');
      expect(
        fileRows.find((file) => file.storageKey === firstDeleted)?.status,
      ).toBe('MISSING');
    });

    it('stops a worker whose lease was taken over before its next storage operation', async () => {
      let operationsAtTakeover = -1;
      let inFlightKey = '';
      images.beforeOperation = (operation, key) => {
        if (operation === 'delete' && operationsAtTakeover < 0) {
          operationsAtTakeover = allOperations().length;
          inFlightKey = key!;
          // Meanwhile the lease expired and another worker claimed it.
          request.attempts += 1;
        }
      };

      await expect(run()).resolves.toBe('SKIPPED');

      // Only the operation already in flight; nothing after the takeover.
      expect(allOperations()).toHaveLength(operationsAtTakeover + 1);
      expect(accountDeleted()).toBe(false);
      // Its outcome was not recorded by the stale worker: the reference stays
      // pending, so the new lease holder resolves it (as MISSING).
      expect(
        fileRows.find((file) => file.storageKey === inFlightKey)?.status,
      ).toBe('PENDING');
      expect(request.lastError).toBeNull();
    });

    it('records nothing when its lease is taken over during the final storage check', async () => {
      const LATE = `${OWNER}/${SESSION}/late-file.jpg`;
      let lists = 0;
      images.beforeOperation = (operation) => {
        if (operation !== 'list') return;
        lists += 1;
        // The second listing is the final check: meanwhile a file appears
        // and another worker takes over the request.
        if (lists === 2) {
          images.files.add(LATE);
          request.attempts += 1;
        }
      };

      await expect(run()).resolves.toBe('SKIPPED');

      expect(fileRows.map((file) => file.storageKey)).not.toContain(LATE);
      expect(images.deletedKeys()).not.toContain(LATE);
      expect(accountDeleted()).toBe(false);
    });

    it('lets concurrent workers delete each file exactly once', async () => {
      const outcomes = await Promise.all([run(), run(), run()]);

      expect(outcomes.sort()).toEqual(['COMPLETED', 'SKIPPED', 'SKIPPED']);
      const deletions = [
        ...images.deletedKeys(),
        ...exportsStorage.deletedKeys(),
      ];
      expect(new Set(deletions).size).toBe(deletions.length);
      expect(prisma.authUser.deleteMany.mock.calls).toHaveLength(1);
    });
  });

  describe('guards', () => {
    it('does not touch storage for an account that is not pending deletion', async () => {
      userStatus = 'ACTIVE';

      await expect(run()).resolves.toBe('PENDING');

      expect(allOperations()).toEqual([]);
      expect(fileRows).toEqual([]);
    });

    it('lets only one worker delete files at a time, until its lease expires', async () => {
      request.status = 'PROCESSING';
      request.lockedUntil = new Date(T0.getTime() + ERASURE_LEASE_MS);

      await expect(run()).resolves.toBe('SKIPPED');
      expect(allOperations()).toEqual([]);

      await expect(
        run(new Date(T0.getTime() + ERASURE_LEASE_MS + 1)),
      ).resolves.toBe('COMPLETED');
    });
  });
});
