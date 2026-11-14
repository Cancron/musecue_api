import type {
  AccountDeletionFile,
  AccountDeletionRequest,
  Prisma,
} from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Logger } from 'winston';
import { freezeTime } from '../../../test/support/freeze-time';
import type { AuthService } from '../../auth/auth.service';
import type { PrismaService } from '../../common/services/prisma.service';
import { PrivateImageStorageService } from '../../storage/private-image-storage.service';
import { PrivacyExportStorageService } from '../../storage/privacy-export-storage.service';
import type { AccountDeletionCodeService } from './account-deletion-code.service';
import {
  AccountErasureService,
  ERASURE_LEASE_MS,
} from './account-erasure.service';

const OWNER = '0a0a0a0a-0000-4000-8000-00000000000a';
const OTHER = '0b0b0b0b-0000-4000-8000-00000000000b';
const SESSION = 'c4c4c4c4-0000-4000-8000-000000000004';
const OTHER_SESSION = 'd5d5d5d5-0000-4000-8000-000000000005';
const PHOTO = `${OWNER}/${SESSION}/11111111-1111-4111-8111-111111111111.jpg`;
const AVATAR = `${OWNER}/profile/22222222-2222-4222-8222-222222222222.png`;
const OTHER_PHOTO = `${OTHER}/${OTHER_SESSION}/33333333-3333-4333-8333-333333333333.jpg`;
const T0 = new Date('2026-09-01T12:00:00.000Z');

describe('AccountErasureService (privacy account erasure)', () => {
  let root: string;
  let prisma: ReturnType<typeof mockDeep<PrismaService>>;
  let auth: ReturnType<typeof mock<AuthService>>;
  let images: PrivateImageStorageService;
  let exportsStorage: PrivacyExportStorageService;
  let service: AccountErasureService;
  let request: AccountDeletionRequest;
  let files: AccountDeletionFile[];
  let user: { status: string; email: string } | null;
  const env = {
    images: process.env.PRIVATE_UPLOAD_DIR,
    exports: process.env.PRIVATE_EXPORT_DIR,
  };

  const put = async (path: string, content = 'x') => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  };
  const exists = async (path: string) =>
    readdir(dirname(path)).then(
      (names) => names.includes(path.split('/').pop()!),
      () => false,
    );

  /** Prisma mock over in-memory request/file state, with rollback. */
  function wirePrisma() {
    prisma = mockDeep<PrismaService>();
    const matchLease = (where: Prisma.AccountDeletionRequestWhereInput) => {
      const now = (
        (where.OR as Array<{ lockedUntil: { lt: Date } }> | undefined)?.[1]
          ?.lockedUntil?.lt ?? new Date()
      ).getTime();
      return (
        ['PENDING', 'PROCESSING'].includes(request.status) &&
        (request.lockedUntil === null || request.lockedUntil.getTime() < now)
      );
    };
    prisma.accountDeletionRequest.updateMany.mockImplementation(((args: {
      where: Prisma.AccountDeletionRequestWhereInput;
      data: Record<string, unknown>;
    }) => {
      if (args.where.OR && !matchLease(args.where)) {
        return Promise.resolve({ count: 0 });
      }
      if (
        'processingStartedAt' in args.where &&
        request.processingStartedAt !== null
      ) {
        return Promise.resolve({ count: 0 });
      }
      apply(args.data);
      return Promise.resolve({ count: 1 });
    }) as never);
    const apply = (data: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(data)) {
        (request as Record<string, unknown>)[key] =
          value && typeof value === 'object' && 'increment' in value
            ? request.attempts + (value.increment as number)
            : value;
      }
    };
    prisma.accountDeletionRequest.findUniqueOrThrow.mockImplementation((() =>
      Promise.resolve({ ...request })) as never);
    prisma.accountDeletionRequest.update.mockImplementation(((args: {
      data: Record<string, unknown>;
    }) => {
      apply(args.data);
      return Promise.resolve({ ...request });
    }) as never);
    prisma.accountDeletionFile.createMany.mockImplementation(((args: {
      data: Array<
        Pick<AccountDeletionFile, 'requestId' | 'kind' | 'storageKey'>
      >;
    }) => {
      for (const file of args.data) {
        if (
          !files.some(
            (item) =>
              item.kind === file.kind && item.storageKey === file.storageKey,
          )
        ) {
          files.push({
            id: randomUUID(),
            deletedAt: null,
            createdAt: T0,
            ...file,
          });
        }
      }
      return Promise.resolve({ count: args.data.length });
    }) as never);
    prisma.accountDeletionFile.findMany.mockImplementation((() =>
      Promise.resolve(
        files
          .filter((file) => file.deletedAt === null)
          .sort((a, b) => a.kind.localeCompare(b.kind)),
      )) as never);
    prisma.accountDeletionFile.update.mockImplementation(((args: {
      where: { id: string };
      data: { deletedAt: Date };
    }) => {
      const file = files.find((item) => item.id === args.where.id)!;
      file.deletedAt = args.data.deletedAt;
      return Promise.resolve(file);
    }) as never);
    prisma.$transaction.mockImplementation((async (
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => {
      const before = {
        request: { ...request },
        files: files.map((file) => ({ ...file })),
      };
      try {
        return await callback(prisma);
      } catch (error) {
        request = before.request;
        files = before.files;
        throw error;
      }
    }) as never);
    prisma.authUser.findUnique.mockImplementation((() =>
      Promise.resolve(user)) as never);
    prisma.authUser.deleteMany.mockResolvedValue({ count: 1 });
    prisma.imageAsset.findMany.mockResolvedValue([
      { sessionId: SESSION, storageKey: PHOTO, source: 'PRIVATE_UPLOAD' },
      {
        sessionId: SESSION,
        storageKey: 'mock://capture',
        source: 'MOCK_CAPTURE',
      },
      // Corrupted references must never delete another user's file.
      { sessionId: SESSION, storageKey: OTHER_PHOTO, source: 'PRIVATE_UPLOAD' },
      {
        sessionId: SESSION,
        storageKey: `${OWNER}/..\\${OTHER}\\${OTHER_SESSION}\\x.jpg`,
        source: 'PRIVATE_UPLOAD',
      },
    ] as never);
    prisma.userProfile.findUnique.mockResolvedValue({
      avatarUrl: AVATAR,
    } as never);
    prisma.userSubscription.findUnique.mockResolvedValue({
      id: 'subscription-1',
    } as never);
    prisma.activityLogEvent.deleteMany.mockResolvedValue({ count: 2 });
    prisma.activityLogEvent.updateMany.mockResolvedValue({ count: 1 });
  }

  beforeEach(async () => {
    freezeTime(T0);
    root = await mkdtemp(join(tmpdir(), 'privacy-erasure-'));
    process.env.PRIVATE_UPLOAD_DIR = join(root, 'images');
    process.env.PRIVATE_EXPORT_DIR = join(root, 'exports');
    images = new PrivateImageStorageService();
    exportsStorage = new PrivacyExportStorageService();
    for (const key of [PHOTO, AVATAR, OTHER_PHOTO]) {
      await put(join(root, 'images', key));
    }
    // A file no row references any more, and an export archive.
    await put(join(root, 'images', OWNER, SESSION, 'orphan.jpg'));
    await put(join(root, 'exports', OWNER, 'export-1', 'archive.zip'));
    await put(join(root, 'exports', OTHER, 'export-2', 'archive.zip'));

    request = {
      id: randomUUID(),
      authId: OWNER,
      status: 'PENDING',
      verificationMethod: 'PASSWORD_AND_EMAIL_CODE',
      requestedAt: T0,
      accountBlockedAt: T0,
      sessionsRevokedAt: T0,
      processingStartedAt: null,
      dataErasedAt: null,
      filesDeletedAt: null,
      completedAt: null,
      lockedUntil: null,
      attempts: 0,
      lastError: null,
      updatedAt: T0,
    };
    files = [];
    user = { status: 'PENDING_DELETION', email: 'owner@example.com' };
    wirePrisma();
    auth = mock<AuthService>();
    auth.revokeAllSessions.mockResolvedValue();
    auth.forgetDeletedAccount.mockResolvedValue();
    const codes = mock<AccountDeletionCodeService>();
    codes.forget.mockResolvedValue();
    service = new AccountErasureService(
      prisma,
      auth,
      codes,
      images,
      exportsStorage,
      mock<Logger>(),
    );
  });

  afterEach(async () => {
    jest.useRealTimers();
    for (const [key, value] of [
      ['PRIVATE_UPLOAD_DIR', env.images],
      ['PRIVATE_EXPORT_DIR', env.exports],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  it('records the storage references, hard-deletes the account, deletes its files and completes', async () => {
    await expect(service.process(request.id, T0)).resolves.toBe('COMPLETED');

    // References were saved (in the same transaction as the deletion).
    expect(files.map((file) => [file.kind, file.storageKey]).sort()).toEqual(
      [
        ['PRIVATE_IMAGE', PHOTO],
        ['PRIVATE_IMAGE', AVATAR],
        ['IMAGE_OWNER_DIRECTORY', OWNER],
        ['EXPORT_OWNER_DIRECTORY', OWNER],
      ].sort(),
    );
    expect(files.every((file) => file.deletedAt instanceof Date)).toBe(true);

    // Hard delete, guarded so only an account pending deletion is removed.
    expect(prisma.authUser.deleteMany.mock.calls).toEqual([
      [{ where: { id: OWNER, status: 'PENDING_DELETION' } }],
    ]);
    expect(prisma.activityLogEvent.deleteMany.mock.calls[0][0]).toEqual({
      where: {
        OR: [
          { tableName: 'authUser', recordId: OWNER },
          { tableName: 'UserSubscription', recordId: 'subscription-1' },
        ],
      },
    });
    expect(prisma.activityLogEvent.updateMany.mock.calls[0][0]).toEqual({
      where: { actionedBy: OWNER },
      data: {
        actionedBy: null,
        ipAddress: null,
        userAgent: null,
        device: null,
      },
    });

    // Every file of the owner is gone; the other user's files are untouched.
    await expect(readdir(join(root, 'images'))).resolves.toEqual([OTHER]);
    await expect(readdir(join(root, 'exports'))).resolves.toEqual([OTHER]);
    expect(await exists(join(root, 'images', OTHER_PHOTO))).toBe(true);

    expect(request).toMatchObject({
      status: 'COMPLETED',
      processingStartedAt: T0,
      dataErasedAt: T0,
      filesDeletedAt: T0,
      completedAt: T0,
      lockedUntil: null,
      lastError: null,
      attempts: 1,
    });
    expect(auth.forgetDeletedAccount.mock.calls).toEqual([
      [OWNER, 'owner@example.com'],
    ]);
  });

  it('leaves nothing half-done when the database transaction fails, and resumes later', async () => {
    prisma.authUser.deleteMany.mockRejectedValueOnce(
      Object.assign(new Error('connection lost'), { code: 'P1017' }),
    );

    await expect(service.process(request.id, T0)).resolves.toBe('PENDING');

    // Rolled back: no references, data not marked erased, no file touched.
    expect(files).toEqual([]);
    expect(request).toMatchObject({
      status: 'PROCESSING',
      dataErasedAt: null,
      lockedUntil: null,
      lastError: 'Error (P1017)',
    });
    expect(await exists(join(root, 'images', PHOTO))).toBe(true);

    await expect(service.process(request.id, T0)).resolves.toBe('COMPLETED');
    expect(request.attempts).toBe(2);
  });

  it('keeps the saved references when file deletion fails, and deletes the files on a later run', async () => {
    const deleteImage = jest
      .spyOn(images, 'delete')
      .mockRejectedValueOnce(
        Object.assign(new Error(`EBUSY ${root}`), { code: 'EBUSY' }),
      );

    await expect(service.process(request.id, T0)).resolves.toBe('PENDING');

    expect(request).toMatchObject({
      status: 'PROCESSING',
      filesDeletedAt: null,
      lockedUntil: null,
      lastError: 'File deletion failed: Error (EBUSY)',
    });
    expect(request.dataErasedAt).toEqual(T0);
    expect(files.filter((file) => file.deletedAt === null)).toHaveLength(1);
    // Private paths never reach the recorded error.
    expect(request.lastError).not.toContain(root);

    deleteImage.mockRestore();
    await expect(service.process(request.id, T0)).resolves.toBe('COMPLETED');
    // The data step is not repeated.
    expect(prisma.authUser.deleteMany.mock.calls).toHaveLength(1);
    expect(files.every((file) => file.deletedAt)).toBe(true);
  });

  it('waits for session revocation before completing', async () => {
    request.sessionsRevokedAt = null;
    auth.revokeAllSessions.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.process(request.id, T0)).resolves.toBe('PENDING');
    expect(request.status).toBe('PROCESSING');
    expect(request.dataErasedAt).toEqual(T0);

    await expect(service.process(request.id, T0)).resolves.toBe('COMPLETED');
    // No token can match the version cached for an erased account.
    expect(auth.revokeAllSessions.mock.calls.at(-1)).toEqual([OWNER, 0]);
  });

  it('does not erase an account that is no longer pending deletion', async () => {
    user = { status: 'ACTIVE', email: 'owner@example.com' };

    await expect(service.process(request.id, T0)).resolves.toBe('PENDING');

    expect(prisma.authUser.deleteMany.mock.calls).toHaveLength(0);
    expect(files).toEqual([]);
    expect(request.lastError).toBe('The account is not pending deletion');
    expect(await exists(join(root, 'images', PHOTO))).toBe(true);
  });

  it('still cleans up storage when the account row is already gone', async () => {
    user = null;
    prisma.imageAsset.findMany.mockResolvedValue([]);
    prisma.userProfile.findUnique.mockResolvedValue(null);

    await expect(service.process(request.id, T0)).resolves.toBe('COMPLETED');

    await expect(readdir(join(root, 'images'))).resolves.toEqual([OTHER]);
  });

  describe('repeated and concurrent processing', () => {
    it('does nothing once completed', async () => {
      await service.process(request.id, T0);
      prisma.authUser.deleteMany.mockClear();

      await expect(service.process(request.id, T0)).resolves.toBe('SKIPPED');

      expect(prisma.authUser.deleteMany.mock.calls).toHaveLength(0);
    });

    it('lets only one worker hold a request, until its lease expires', async () => {
      request.status = 'PROCESSING';
      request.lockedUntil = new Date(T0.getTime() + ERASURE_LEASE_MS);

      await expect(service.process(request.id, T0)).resolves.toBe('SKIPPED');
      expect(prisma.authUser.deleteMany.mock.calls).toHaveLength(0);

      // The holder crashed: after the lease, another worker resumes.
      const later = new Date(T0.getTime() + ERASURE_LEASE_MS + 1);
      await expect(service.process(request.id, later)).resolves.toBe(
        'COMPLETED',
      );
    });
  });
});
