import { mock, mockDeep } from 'jest-mock-extended';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import { ImageValidationService } from '../makeup/services/image-validation.service';
import { PrivateImageStorageService } from '../storage/private-image-storage.service';
import { PrivateStorageError } from '../storage/private-storage.error';
import { ProfileService } from './profile.service';

const FILE = { buffer: Buffer.from('avatar'), size: 6 } as Express.Multer.File;
const STORED = { provider: 'supabase', key: 'owner-id/profile/new.webp' };

describe('ProfileService private cloud storage integration', () => {
  const prisma = mockDeep<PrismaService>();
  const imageValidation = mock<ImageValidationService>();
  const imageStorage = mock<PrivateImageStorageService>();
  const service = new ProfileService(prisma, imageValidation, imageStorage);

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

  beforeEach(() => {
    jest.resetAllMocks();
    imageValidation.validate.mockResolvedValue({
      mimeType: 'image/webp',
      width: 512,
      height: 512,
      sizeBytes: 6,
    });
    imageStorage.deleteQuietly.mockResolvedValue(true);
  });

  it('never exposes the storage key or provider of a cloud avatar', async () => {
    prisma.authUser.findUnique.mockResolvedValue(
      profileRow({
        avatarUrl: STORED.key,
        avatarStorageProvider: 'supabase',
      }),
    );

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

  it('reads avatars stored before provider tracking from local storage', async () => {
    prisma.userProfile.findUnique.mockResolvedValue({
      avatarUrl: 'owner-id/profile/legacy.jpg',
      avatarStorageProvider: null,
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

  it('replaces a legacy local avatar with a cloud one and removes the old file', async () => {
    prisma.userProfile.findUnique.mockResolvedValue({
      avatarUrl: 'owner-id/profile/legacy.jpg',
      avatarStorageProvider: 'local',
    } as never);
    imageStorage.save.mockResolvedValue(STORED);
    prisma.authUser.findUnique.mockResolvedValue(
      profileRow({ avatarUrl: STORED.key, avatarStorageProvider: 'supabase' }),
    );

    await service.updateAvatar('owner-id', FILE);

    expect(prisma.userProfile.upsert.mock.calls[0]?.[0].update).toEqual({
      avatarUrl: STORED.key,
      avatarStorageProvider: 'supabase',
    });
    expect(imageStorage.deleteQuietly.mock.calls).toEqual([
      [
        { provider: 'local', key: 'owner-id/profile/legacy.jpg' },
        'avatar replaced',
      ],
    ]);
  });

  it('does not fail an avatar update when removing the previous file fails', async () => {
    prisma.userProfile.findUnique.mockResolvedValue({
      avatarUrl: 'owner-id/profile/old.jpg',
      avatarStorageProvider: 'supabase',
    } as never);
    imageStorage.save.mockResolvedValue(STORED);
    imageStorage.deleteQuietly.mockResolvedValue(false);
    prisma.authUser.findUnique.mockResolvedValue(
      profileRow({ avatarUrl: STORED.key, avatarStorageProvider: 'supabase' }),
    );

    await expect(service.updateAvatar('owner-id', FILE)).resolves.toMatchObject(
      { avatarUrl: '/v1/profile/avatar/content' },
    );
  });

  it('does not delete an external avatar when it is replaced', async () => {
    prisma.userProfile.findUnique.mockResolvedValue({
      avatarUrl: 'https://lh3.googleusercontent.com/a/photo',
      avatarStorageProvider: null,
    } as never);
    imageStorage.save.mockResolvedValue(STORED);
    prisma.authUser.findUnique.mockResolvedValue(
      profileRow({ avatarUrl: STORED.key, avatarStorageProvider: 'supabase' }),
    );

    await service.updateAvatar('owner-id', FILE);

    expect(imageStorage.deleteQuietly.mock.calls).toHaveLength(0);
  });

  it('maps a storage outage during upload to 503 without touching the profile', async () => {
    prisma.userProfile.findUnique.mockResolvedValue(null);
    imageStorage.save.mockRejectedValue(
      new PrivateStorageError('STORAGE_UNAVAILABLE'),
    );

    const error = await service
      .updateAvatar('owner-id', FILE)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).getStatus()).toBe(503);
    expect(prisma.userProfile.upsert.mock.calls).toHaveLength(0);
  });

  it('clears both the key and provider when removing a cloud avatar', async () => {
    prisma.userProfile.findUnique.mockResolvedValue({
      avatarUrl: STORED.key,
      avatarStorageProvider: 'supabase',
    } as never);
    prisma.authUser.findUnique.mockResolvedValue(
      profileRow({ avatarUrl: null, avatarStorageProvider: null }),
    );

    await service.deleteAvatar('owner-id');

    expect(prisma.userProfile.update.mock.calls[0]?.[0]).toEqual({
      where: { authId: 'owner-id' },
      data: { avatarUrl: null, avatarStorageProvider: null },
    });
    expect(imageStorage.deleteQuietly.mock.calls).toEqual([
      [STORED, 'avatar removed'],
    ]);
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
