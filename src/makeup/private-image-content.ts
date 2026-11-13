import type { PrismaService } from '../common/services/prisma.service';
import type {
  PrivateImageStorageService,
  SupportedImageMime,
} from '../storage/private-image-storage.service';
import { isSupportedImageMime } from '../storage/image-signature';

export interface PrivateImageContent {
  /** The original bytes exactly as stored (no resizing or re-encoding). */
  bytes: Buffer;
  /** The validated type recorded at upload, verified against the bytes. */
  mimeType: SupportedImageMime;
}

export type PrivateImageUnavailableReason =
  /** No such image, or it belongs to another user (indistinguishable). */
  | 'NOT_FOUND'
  /** The record has no private upload behind it (e.g. a mock capture). */
  | 'NOT_PRIVATE_UPLOAD'
  /** The recorded type is not a supported image type. */
  | 'UNSUPPORTED_TYPE';

/** The image cannot be served for a reason decided by its record, not storage. */
export class PrivateImageUnavailableError extends Error {
  constructor(readonly reason: PrivateImageUnavailableReason) {
    super('Private image is unavailable');
    this.name = 'PrivateImageUnavailableError';
  }
}

/**
 * The single way private makeup images are loaded, shared by
 * `GET /v1/images/:id/content` and the AI worker: an owner-scoped lookup,
 * then the original bytes from the storage provider and key stored on the
 * image (as the filesystem adapter used to be read), verified to match the
 * stored type. Throws `PrivateImageUnavailableError` for record problems and
 * `PrivateStorageError` for storage problems; callers map both to their own
 * safe errors.
 */
export async function loadOwnedPrivateImage(
  prisma: PrismaService,
  storage: PrivateImageStorageService,
  authId: string,
  imageId: string,
): Promise<PrivateImageContent> {
  const image = await prisma.imageAsset.findFirst({
    where: { id: imageId, session: { authId } },
    select: {
      storageKey: true,
      storageProvider: true,
      mimeType: true,
      source: true,
    },
  });
  if (!image) throw new PrivateImageUnavailableError('NOT_FOUND');
  if (image.source !== 'PRIVATE_UPLOAD') {
    throw new PrivateImageUnavailableError('NOT_PRIVATE_UPLOAD');
  }
  if (!isSupportedImageMime(image.mimeType)) {
    throw new PrivateImageUnavailableError('UNSUPPORTED_TYPE');
  }
  const bytes = await storage.readImage(
    { provider: image.storageProvider, key: image.storageKey },
    image.mimeType,
  );
  return { bytes, mimeType: image.mimeType };
}
