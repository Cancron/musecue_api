import { mock, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../common/services/prisma.service';
import { ImageValidationService } from '../makeup/services/image-validation.service';
import { PrivateImageStorageService } from '../storage/private-image-storage.service';
import { ProfileService } from './profile.service';

describe('ProfileService avatar ownership and lifecycle', () => {
  const prisma = mockDeep<PrismaService>();
  const imageValidation = mock<ImageValidationService>();
  const imageStorage = mock<PrivateImageStorageService>();
  const service = new ProfileService(prisma, imageValidation, imageStorage);

  beforeEach(() => jest.clearAllMocks());

  it('returns an authenticated content route without exposing the storage key', async () => {
    const updatedAt = new Date('2026-09-03T12:00:00.000Z');
    prisma.authUser.findUnique.mockResolvedValue({
      id: 'owner-id',
      email: 'owner@example.com',
      username: 'owner',
      userProfile: {
        avatarUrl: 'owner-id/profile/avatar.jpg',
        updatedAt,
      },
    } as never);

    await expect(service.getProfile('owner-id')).resolves.toEqual({
      id: 'owner-id',
      email: 'owner@example.com',
      username: 'owner',
      avatarUrl: '/v1/profile/avatar/content',
      avatarUpdatedAt: updatedAt.toISOString(),
    });
  });

  it('replaces an avatar and deletes the previous private file', async () => {
    const file = {
      buffer: Buffer.from('avatar'),
      size: 6,
    } as Express.Multer.File;
    imageValidation.validate.mockResolvedValue({
      mimeType: 'image/jpeg',
      width: 640,
      height: 640,
      sizeBytes: 6,
    });
    prisma.userProfile.findUnique.mockResolvedValue({
      avatarUrl: 'owner-id/profile/old.jpg',
    } as never);
    imageStorage.save.mockResolvedValue('owner-id/profile/new.jpg');
    prisma.userProfile.upsert.mockResolvedValue({} as never);
    prisma.authUser.findUnique.mockResolvedValue({
      id: 'owner-id',
      email: 'owner@example.com',
      username: 'owner',
      userProfile: {
        avatarUrl: 'owner-id/profile/new.jpg',
        updatedAt: new Date('2026-09-03T12:00:00.000Z'),
      },
    } as never);

    await service.updateAvatar('owner-id', file);

    expect(imageStorage.save.mock.calls[0]?.slice(0, 3)).toEqual([
      'owner-id',
      'profile',
      'image/jpeg',
    ]);
    expect(prisma.userProfile.upsert.mock.calls[0]?.[0]).toEqual({
      where: { authId: 'owner-id' },
      create: { authId: 'owner-id', avatarUrl: 'owner-id/profile/new.jpg' },
      update: { avatarUrl: 'owner-id/profile/new.jpg' },
    });
    expect(imageStorage.delete.mock.calls).toContainEqual([
      'owner-id/profile/old.jpg',
    ]);
  });

  it('deletes a newly written file when the database update fails', async () => {
    const file = {
      buffer: Buffer.from('avatar'),
      size: 6,
    } as Express.Multer.File;
    imageValidation.validate.mockResolvedValue({
      mimeType: 'image/jpeg',
      width: 640,
      height: 640,
      sizeBytes: 6,
    });
    prisma.userProfile.findUnique.mockResolvedValue(null);
    imageStorage.save.mockResolvedValue('owner-id/profile/new.jpg');
    prisma.userProfile.upsert.mockRejectedValue(
      new Error('Database unavailable'),
    );

    await expect(service.updateAvatar('owner-id', file)).rejects.toThrow(
      'Database unavailable',
    );
    expect(imageStorage.delete.mock.calls).toContainEqual([
      'owner-id/profile/new.jpg',
    ]);
  });

  it('removes an external provider avatar without treating its URL as a local path', async () => {
    prisma.userProfile.findUnique.mockResolvedValue({
      avatarUrl: 'https://images.example.com/avatar.jpg',
    } as never);
    prisma.userProfile.update.mockResolvedValue({} as never);
    prisma.authUser.findUnique.mockResolvedValue({
      id: 'owner-id',
      email: 'owner@example.com',
      username: 'owner',
      userProfile: { avatarUrl: null, updatedAt: new Date() },
    } as never);

    await service.deleteAvatar('owner-id');

    expect(prisma.userProfile.update.mock.calls[0]?.[0]).toEqual({
      where: { authId: 'owner-id' },
      data: { avatarUrl: null },
    });
    expect(imageStorage.delete.mock.calls).toContainEqual([
      'https://images.example.com/avatar.jpg',
    ]);
  });

  it('reads only the current user profile avatar', async () => {
    const bytes = Buffer.from('private-avatar');
    prisma.userProfile.findUnique.mockResolvedValue({
      avatarUrl: 'owner-id/profile/avatar.webp',
    } as never);
    imageStorage.read.mockResolvedValue(bytes);

    await expect(service.getAvatarContent('owner-id')).resolves.toEqual({
      bytes,
      mimeType: 'image/webp',
    });
    expect(prisma.userProfile.findUnique.mock.calls[0]?.[0]).toEqual({
      where: { authId: 'owner-id' },
      select: { avatarUrl: true },
    });
  });
});
