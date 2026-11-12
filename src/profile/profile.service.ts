import { Injectable } from '@nestjs/common';
import { extname } from 'node:path';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import { ImageValidationService } from '../makeup/services/image-validation.service';
import {
  PrivateImageStorageService,
  type PrivateObjectRef,
} from '../storage/private-image-storage.service';
import { LOCAL_STORAGE_PROVIDER_ID } from '../storage/private-storage.config';
import { toImageStorageHttpError } from '../storage/private-storage-http';

const AVATAR_MIME_TYPES: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

interface StoredAvatar {
  avatarUrl: string | null;
  avatarStorageProvider: string | null;
}

const AVATAR_SELECT = { avatarUrl: true, avatarStorageProvider: true } as const;

/**
 * Returns the private storage location of an uploaded avatar, or null when
 * there is no avatar or it is an external URL (e.g. a Google profile photo).
 */
function privateAvatar(
  profile: StoredAvatar | null | undefined,
): PrivateObjectRef | null {
  const key = profile?.avatarUrl;
  if (!key) return null;
  if (profile.avatarStorageProvider) {
    return { provider: profile.avatarStorageProvider, key };
  }
  // Keys written before provider tracking came from the filesystem adapter.
  return key.includes('://')
    ? null
    : { provider: LOCAL_STORAGE_PROVIDER_ID, key };
}

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
          select: { ...AVATAR_SELECT, updatedAt: true },
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
        ? privateAvatar(user.userProfile)
          ? '/v1/profile/avatar/content'
          : storedAvatar
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
      select: AVATAR_SELECT,
    });
    let stored: PrivateObjectRef;
    try {
      stored = await this.imageStorage.save(
        authId,
        'profile',
        image.mimeType,
        file.buffer,
      );
    } catch (error) {
      throw toImageStorageHttpError(error);
    }

    const avatar = {
      avatarUrl: stored.key,
      avatarStorageProvider: stored.provider,
    };
    try {
      await this.prisma.userProfile.upsert({
        where: { authId },
        create: { authId, ...avatar },
        update: avatar,
      });
    } catch (error) {
      await this.imageStorage.deleteQuietly(
        stored,
        'avatar upload rolled back',
      );
      throw error;
    }

    const previousAvatar = privateAvatar(previousProfile);
    if (previousAvatar && previousAvatar.key !== stored.key) {
      await this.imageStorage.deleteQuietly(previousAvatar, 'avatar replaced');
    }
    return this.getProfile(authId);
  }

  async deleteAvatar(authId: string) {
    const profile = await this.prisma.userProfile.findUnique({
      where: { authId },
      select: AVATAR_SELECT,
    });
    if (!profile?.avatarUrl) return this.getProfile(authId);

    await this.prisma.userProfile.update({
      where: { authId },
      data: { avatarUrl: null, avatarStorageProvider: null },
    });
    const removed = privateAvatar(profile);
    if (removed) {
      await this.imageStorage.deleteQuietly(removed, 'avatar removed');
    }
    return this.getProfile(authId);
  }

  async getAvatarContent(authId: string) {
    const profile = await this.prisma.userProfile.findUnique({
      where: { authId },
      select: AVATAR_SELECT,
    });
    const avatar = privateAvatar(profile);
    if (!avatar) {
      throw AppError.notFound('Avatar image is unavailable');
    }

    try {
      return {
        bytes: await this.imageStorage.read(avatar),
        mimeType:
          AVATAR_MIME_TYPES[extname(avatar.key).toLowerCase()] ??
          'application/octet-stream',
      };
    } catch (error) {
      throw toImageStorageHttpError(error, 'Avatar image is unavailable');
    }
  }
}
