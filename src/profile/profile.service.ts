import { Injectable } from '@nestjs/common';
import { extname } from 'node:path';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import { ImageValidationService } from '../makeup/services/image-validation.service';
import { PrivateImageStorageService } from '../storage/private-image-storage.service';

const AVATAR_MIME_TYPES: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly imageValidation: ImageValidationService,
    private readonly imageStorage: PrivateImageStorageService,
  ) {}

  async getProfile(authId: string) {
    const user = await this.prisma.authUser.findUnique({
      where: { id: authId },
      select: {
        id: true,
        email: true,
        username: true,
        userProfile: {
          select: { avatarUrl: true, updatedAt: true },
        },
      },
    });
    if (!user) throw AppError.notFound('User profile not found');

    const storedAvatar = user.userProfile?.avatarUrl ?? null;
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      avatarUrl: storedAvatar
        ? storedAvatar.includes('://')
          ? storedAvatar
          : '/v1/profile/avatar/content'
        : null,
      avatarUpdatedAt: storedAvatar
        ? (user.userProfile?.updatedAt.toISOString() ?? null)
        : null,
    };
  }

  async updateAvatar(authId: string, file?: Express.Multer.File) {
    if (!file) throw AppError.badRequest('An avatar image is required');
    const image = await this.imageValidation.validate(file);
    const previousProfile = await this.prisma.userProfile.findUnique({
      where: { authId },
      select: { avatarUrl: true },
    });
    const storageKey = await this.imageStorage.save(
      authId,
      'profile',
      image.mimeType,
      file.buffer,
    );

    try {
      await this.prisma.userProfile.upsert({
        where: { authId },
        create: { authId, avatarUrl: storageKey },
        update: { avatarUrl: storageKey },
      });
    } catch (error) {
      await this.imageStorage.delete(storageKey);
      throw error;
    }

    const previousAvatar = previousProfile?.avatarUrl;
    if (previousAvatar && previousAvatar !== storageKey) {
      await this.imageStorage.delete(previousAvatar);
    }
    return this.getProfile(authId);
  }

  async deleteAvatar(authId: string) {
    const profile = await this.prisma.userProfile.findUnique({
      where: { authId },
      select: { avatarUrl: true },
    });
    if (!profile?.avatarUrl) return this.getProfile(authId);

    await this.prisma.userProfile.update({
      where: { authId },
      data: { avatarUrl: null },
    });
    await this.imageStorage.delete(profile.avatarUrl);
    return this.getProfile(authId);
  }

  async getAvatarContent(authId: string) {
    const profile = await this.prisma.userProfile.findUnique({
      where: { authId },
      select: { avatarUrl: true },
    });
    const storageKey = profile?.avatarUrl;
    if (!storageKey || storageKey.includes('://')) {
      throw AppError.notFound('Avatar image is unavailable');
    }

    try {
      return {
        bytes: await this.imageStorage.read(storageKey),
        mimeType:
          AVATAR_MIME_TYPES[extname(storageKey).toLowerCase()] ??
          'application/octet-stream',
      };
    } catch {
      throw AppError.notFound('Avatar image is unavailable');
    }
  }
}
