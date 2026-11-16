import type { Prisma } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import { ImageValidationService } from '../makeup/services/image-validation.service';
import { PrivateImageLifecycleService } from '../storage/private-image-lifecycle.service';
import { PrivateImageStorageService } from '../storage/private-image-storage.service';
import { PrivateStorageError } from '../storage/private-storage.error';
import { EXTERNAL_AVATAR_MESSAGE, ProfileService } from './profile.service';

const FILE = { buffer: Buffer.from('avatar'), size: 6 } as Express.Multer.File;
const STORED = { provider: 'supabase', key: 'owner-id/profile/new.webp' };

describe('ProfileService private cloud storage lifecycle', () => {
  const prisma = mockDeep<PrismaService>();
  const tx = mockDeep<PrismaService>();
  const imageValidation = mock<ImageValidationService>();
  const imageStorage = mock<PrivateImageStorageService>();
  const lifecycle = mock<PrivateImageLifecycleService>();
  const service = new ProfileService(
    prisma,
    imageValidation,
    imageStorage,
    lifecycle,
  );

  function profileRow(avatar: {
    avatarUrl: string | null;
    avatarStorageProvider: string | null;
  }) {
    return {
      id: 'owner-id',
      email: 'owner@example.com',
      username: 'owner',
      userProfile: { ...avatar, updatedAt: new Date('2026-11-01T00:00:00Z') },
    } as never;
  }

  function lockedAvatar(
    avatarUrl: string | null,
    avatarStorageProvider: string | null,
  ) {
    tx.$queryRaw.mockResolvedValue(
      avatarUrl === null && avatarStorageProvider === null
        ? []
        : [{ avatarUrl, avatarStorageProvider }],
    );
  }

  beforeEach(() => {
    jest.resetAllMocks();
    imageValidation.validate.mockResolvedValue({
      mimeType: 'image/webp',
      width: 512,
      height: 512,
      sizeBytes: 6,
    });
    lifecycle.upload.mockResolvedValue(STORED);
    lifecycle.processRefs.mockResolvedValue([]);
    lifecycle.scheduleDeletion.mockImplementation((_tx, refs) =>
      Promise.resolve(refs),
    );
    prisma.$transaction.mockImplementation(((
      callback: (client: Prisma.TransactionClient) => Promise<unknown>,
    ) => callback(tx)) as PrismaService['$transaction']);
    prisma.authUser.findUnique.mockResolvedValue(
      profileRow({ avatarUrl: STORED.key, avatarStorageProvider: 'supabase' }),
    );
  });

  it('never exposes the storage key or provider of a cloud avatar', async () => {
    const profile = await service.getProfile('owner-id');

    expect(profile.avatarUrl).toBe('/v1/profile/avatar/content');
    expect(JSON.stringify(profile)).not.toContain(STORED.key);
    expect(JSON.stringify(profile)).not.toContain('supabase');
  });

  it('returns external (e.g. Google) avatar URLs unchanged', async () => {
    prisma.authUser.findUnique.mockResolvedValue(
      profileRow({
        avatarUrl: 'https://lh3.googleusercontent.com/a/photo',
        avatarStorageProvider: null,
      }),
    );

    await expect(service.getProfile('owner-id')).resolves.toMatchObject({
      avatarUrl: 'https://lh3.googleusercontent.com/a/photo',
    });
  });

  it('reads a stored avatar from the provider recorded with it', async () => {
    prisma.userProfile.findUnique.mockResolvedValue({
      avatarUrl: 'owner-id/profile/legacy.jpg',
      avatarStorageProvider: 'local',
    } as never);
    imageStorage.read.mockResolvedValue(Buffer.from('legacy'));

    await expect(service.getAvatarContent('owner-id')).resolves.toEqual({
      bytes: Buffer.from('legacy'),
      mimeType: 'image/jpeg',
    });
    expect(imageStorage.read.mock.calls[0]?.[0]).toEqual({
      provider: 'local',
      key: 'owner-id/profile/legacy.jpg',
    });
  });

  it('never guesses a provider (e.g. the local filesystem) for an avatar without one', async () => {
    prisma.userProfile.findUnique.mockResolvedValue({
      avatarUrl: 'owner-id/profile/orphan.jpg',
      avatarStorageProvider: null,
    } as never);

    const error = await service
      .getAvatarContent('owner-id')
      .catch((caught: unknown) => caught);

    expect((error as AppError).getStatus()).toBe(404);
    expect(imageStorage.read.mock.calls).toHaveLength(0);
  });

  describe('getAvatarSignedUrl', () => {
    const SIGNED = `https://project.supabase.co/storage/v1/object/sign/bucket/${STORED.key}?token=t`;
    const stored = (avatarUrl: string | null, provider: string | null) =>
      prisma.userProfile.findUnique.mockResolvedValue(
        avatarUrl === null && provider === null
          ? null
          : ({ avatarUrl, avatarStorageProvider: provider } as never),
      );

    it("signs the caller's own avatar for 60 s using the stored provider and key", async () => {
      stored(STORED.key, 'supabase');
      imageStorage.createSignedUrl.mockResolvedValue({
        url: SIGNED,
        expiresAt: new Date('2026-11-12T12:01:00.000Z'),
        expiresInSeconds: 60,
      });

      await expect(service.getAvatarSignedUrl('owner-id')).resolves.toEqual({
        url: SIGNED,
        expiresAt: '2026-11-12T12:01:00.000Z',
        expiresInSeconds: 60,
      });
      expect(prisma.userProfile.findUnique.mock.calls[0]?.[0]).toEqual({
        where: { authId: 'owner-id' },
        select: { avatarUrl: true, avatarStorageProvider: true },
      });
      expect(imageStorage.createSignedUrl.mock.calls).toEqual([[STORED, 60]]);
    });

    it.each([
      ['no profile', null],
      [
        'a profile without an avatar',
        { avatarUrl: null, avatarStorageProvider: null },
      ],
    ])('answers 404 for %s without touching storage', async (_label, row) => {
      prisma.userProfile.findUnique.mockResolvedValue(row as never);

      const error = await service
        .getAvatarSignedUrl('owner-id')
        .catch((caught: unknown) => caught);

      expect((error as AppError).getStatus()).toBe(404);
      expect(imageStorage.createSignedUrl.mock.calls).toHaveLength(0);
    });

    it('never signs or replaces an external (Google) avatar', async () => {
      stored('https://lh3.googleusercontent.com/a/photo', null);

      const error = await service
        .getAvatarSignedUrl('owner-id')
        .catch((caught: unknown) => caught);

      expect((error as AppError).getStatus()).toBe(409);
      expect((error as AppError).getResponse()).toMatchObject({
        message: EXTERNAL_AVATAR_MESSAGE,
      });
      expect(imageStorage.createSignedUrl.mock.calls).toHaveLength(0);
      expect(imageStorage.read.mock.calls).toHaveLength(0);
    });

    it("refuses to sign or stream a key outside the caller's own avatar folder", async () => {
      stored('other-user/profile/avatar.jpg', 'supabase');

      // Lazily invoked, so one failing call cannot leave another unhandled.
      for (const call of [
        () => service.getAvatarSignedUrl('owner-id'),
        () => service.getAvatarContent('owner-id'),
      ]) {
        const error = await call().catch((caught: unknown) => caught);
        expect((error as AppError).getStatus()).toBe(404);
      }
      expect(imageStorage.createSignedUrl.mock.calls).toHaveLength(0);
      expect(imageStorage.read.mock.calls).toHaveLength(0);
    });

    it.each([
      ['OBJECT_NOT_FOUND', 404, 'Avatar image is unavailable'],
      [
        'STORAGE_TIMEOUT',
        503,
        'Image storage is temporarily unavailable. Please try again.',
      ],
      [
        'STORAGE_UNAVAILABLE',
        503,
        'Image storage is temporarily unavailable. Please try again.',
      ],
      ['STORAGE_ACCESS_DENIED', 500, 'Image storage is unavailable'],
      ['INVALID_PROVIDER_RESPONSE', 500, 'Image storage is unavailable'],
      [
        'SIGNED_URL_UNSUPPORTED',
        409,
        'A signed URL is not available for this image. Use the image content endpoint instead.',
      ],
    ] as const)(
      'maps %s to %i with a safe message',
      async (code, status, message) => {
        stored(STORED.key, 'supabase');
        imageStorage.createSignedUrl.mockRejectedValue(
          new PrivateStorageError(code),
        );

        const error = (await service
          .getAvatarSignedUrl('owner-id')
          .catch((caught: unknown) => caught)) as AppError;

        expect(error.getStatus()).toBe(status);
        expect(error.getResponse()).toMatchObject({ message });
      },
    );
  });

  describe('updateAvatar', () => {
    it('locks the profile row, stores the new avatar and records the old one in one transaction', async () => {
      lockedAvatar('owner-id/profile/legacy.jpg', 'local');

      await service.updateAvatar('owner-id', FILE);

      const ensureSql = (
        tx.$executeRaw.mock.calls[0]?.[0] as unknown as string[]
      ).join('?');
      const lockSql = (
        tx.$queryRaw.mock.calls[0]?.[0] as unknown as string[]
      ).join('?');
      expect(ensureSql).toContain('ON CONFLICT ("authId") DO NOTHING');
      expect(lockSql).toContain('FOR UPDATE');
      expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.$queryRaw.mock.invocationCallOrder[0],
      );
      expect(tx.userProfile.upsert.mock.calls[0]?.[0].update).toEqual({
        avatarUrl: STORED.key,
        avatarStorageProvider: 'supabase',
      });
      const previous = {
        provider: 'local',
        key: 'owner-id/profile/legacy.jpg',
      };
      expect(lifecycle.confirmUpload.mock.calls).toEqual([[tx, STORED]]);
      expect(lifecycle.scheduleDeletion.mock.calls).toEqual([
        [tx, [previous], 'AVATAR_REPLACED', 'owner-id'],
      ]);
      expect(lifecycle.processRefs.mock.calls).toEqual([[[previous]]]);
    });

    it('does not fail when deleting the previous file fails; the ledger keeps it', async () => {
      lockedAvatar('owner-id/profile/old.jpg', 'supabase');
      lifecycle.processRefs.mockResolvedValue(['RETRY_SCHEDULED']);

      await expect(
        service.updateAvatar('owner-id', FILE),
      ).resolves.toMatchObject({ avatarUrl: '/v1/profile/avatar/content' });
      expect(lifecycle.scheduleDeletion.mock.calls).toHaveLength(1);
    });

    it('never schedules an external avatar URL for deletion', async () => {
      lockedAvatar('https://lh3.googleusercontent.com/a/photo', null);

      await service.updateAvatar('owner-id', FILE);

      expect(lifecycle.scheduleDeletion.mock.calls).toHaveLength(0);
      expect(lifecycle.processRefs.mock.calls).toHaveLength(0);
    });

    it('abandons the new upload and rethrows when the profile write fails', async () => {
      lockedAvatar(null, null);
      const failure = new Error('Database unavailable');
      tx.userProfile.upsert.mockRejectedValue(failure);

      await expect(service.updateAvatar('owner-id', FILE)).rejects.toBe(
        failure,
      );
      expect(lifecycle.abandonUpload.mock.calls).toEqual([[STORED]]);
      expect(lifecycle.scheduleDeletion.mock.calls).toHaveLength(0);
    });

    it('maps a storage outage during upload to 503 without touching the profile', async () => {
      lifecycle.upload.mockRejectedValue(
        new PrivateStorageError('STORAGE_UNAVAILABLE'),
      );

      const error = await service
        .updateAvatar('owner-id', FILE)
        .catch((caught: unknown) => caught);

      expect((error as AppError).getStatus()).toBe(503);
      expect(prisma.$transaction.mock.calls).toHaveLength(0);
    });
  });

  describe('deleteAvatar', () => {
    it('clears the key and provider and records the object in the same transaction', async () => {
      lockedAvatar(STORED.key, 'supabase');
      prisma.authUser.findUnique.mockResolvedValue(
        profileRow({ avatarUrl: null, avatarStorageProvider: null }),
      );

      await service.deleteAvatar('owner-id');

      expect(tx.userProfile.update.mock.calls[0]?.[0]).toEqual({
        where: { authId: 'owner-id' },
        data: { avatarUrl: null, avatarStorageProvider: null },
      });
      expect(lifecycle.scheduleDeletion.mock.calls).toEqual([
        [tx, [STORED], 'AVATAR_REMOVED', 'owner-id'],
      ]);
      expect(lifecycle.processRefs.mock.calls).toEqual([[[STORED]]]);
    });

    it('does nothing when there is no avatar, and never creates a profile', async () => {
      lockedAvatar(null, null);

      await service.deleteAvatar('owner-id');

      expect(tx.$executeRaw.mock.calls).toHaveLength(0);
      expect(tx.userProfile.update.mock.calls).toHaveLength(0);
      expect(lifecycle.scheduleDeletion.mock.calls).toHaveLength(0);
    });
  });

  it.each([
    ['OBJECT_NOT_FOUND', 404],
    ['STORAGE_TIMEOUT', 503],
    ['STORAGE_ACCESS_DENIED', 500],
  ] as const)('maps %s when reading an avatar to %i', async (code, status) => {
    prisma.userProfile.findUnique.mockResolvedValue({
      avatarUrl: STORED.key,
      avatarStorageProvider: 'supabase',
    } as never);
    imageStorage.read.mockRejectedValue(new PrivateStorageError(code));

    const error = await service
      .getAvatarContent('owner-id')
      .catch((caught: unknown) => caught);

    expect((error as AppError).getStatus()).toBe(status);
  });
});
