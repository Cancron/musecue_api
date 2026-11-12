import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { extname } from 'node:path';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import { ImageValidationService } from '../makeup/services/image-validation.service';
import { PrivateImageLifecycleService } from '../storage/private-image-lifecycle.service';
import {
  PrivateImageStorageService,
  type PrivateObjectRef,
} from '../storage/private-image-storage.service';
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
 * The database guarantees a provider is recorded exactly for private keys
 * (`userProfile_avatar_storage_provider_check`), so nothing is guessed.
 */
function privateAvatar(
  profile: StoredAvatar | null | undefined,
): PrivateObjectRef | null {
  if (!profile?.avatarUrl || !profile.avatarStorageProvider) return null;
  return { provider: profile.avatarStorageProvider, key: profile.avatarUrl };
}

/**
 * Reads the current avatar while holding a row lock until the transaction
 * ends. With `ensureRow`, an empty profile is created first: without a row
 * there is nothing to lock, and concurrent first uploads would each see "no
 * previous avatar" and leave all but one upload unreferenced.
 */
async function lockAvatar(
  tx: Prisma.TransactionClient,
  authId: string,
  ensureRow = false,
): Promise<StoredAvatar | null> {
  if (ensureRow) {
    await tx.$executeRaw`
      INSERT INTO "userProfile" ("id", "authId", "updatedAt")
      VALUES (gen_random_uuid()::text, ${authId}, now())
      ON CONFLICT ("authId") DO NOTHING
    `;
  }
  const rows = await tx.$queryRaw<StoredAvatar[]>`
    SELECT "avatarUrl", "avatarStorageProvider" FROM "userProfile"
    WHERE "authId" = ${authId} FOR UPDATE
  `;
  return rows[0] ?? null;
}

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly imageValidation: ImageValidationService,
    private readonly imageStorage: PrivateImageStorageService,
    private readonly imageLifecycle: PrivateImageLifecycleService,
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
    let stored: PrivateObjectRef;
    try {
      stored = await this.imageLifecycle.upload(
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
    let replaced: PrivateObjectRef | null;
    try {
      replaced = await this.prisma.$transaction(async (tx) => {
        // Lock the row so concurrent uploads cannot both "replace" the same
        // previous avatar and leave one new avatar unreferenced.
        const previous = privateAvatar(await lockAvatar(tx, authId, true));
        await tx.userProfile.upsert({
          where: { authId },
          create: { authId, ...avatar },
          update: avatar,
        });
        await this.imageLifecycle.confirmUpload(tx, stored);
        if (!previous || previous.key === stored.key) return null;
        await this.imageLifecycle.scheduleDeletion(
          tx,
          [previous],
          'AVATAR_REPLACED',
        );
        return previous;
      });
    } catch (error) {
      await this.imageLifecycle.abandonUpload(stored);
      throw error;
    }

    if (replaced) await this.imageLifecycle.processRefs([replaced]);
    return this.getProfile(authId);
  }

  async deleteAvatar(authId: string) {
    const removed = await this.prisma.$transaction(async (tx) => {
      const current = await lockAvatar(tx, authId);
      if (!current?.avatarUrl) return null;
      await tx.userProfile.update({
        where: { authId },
        data: { avatarUrl: null, avatarStorageProvider: null },
      });
      const ref = privateAvatar(current);
      if (ref) {
        await this.imageLifecycle.scheduleDeletion(tx, [ref], 'AVATAR_REMOVED');
      }
      return ref;
    });

    if (removed) await this.imageLifecycle.processRefs([removed]);
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
