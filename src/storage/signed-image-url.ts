import type {
  PrivateImageStorageService,
  PrivateObjectRef,
} from './private-image-storage.service';
import { toImageStorageHttpError } from './private-storage-http';

/**
 * Lifetime of every signed image URL handed to clients. The storage layer
 * enforces it as a strict maximum (see `MAX_SIGNED_URL_TTL_SECONDS`).
 */
export const SIGNED_IMAGE_URL_TTL_SECONDS = 60;

export interface SignedImageUrlResponse {
  url: string;
  expiresAt: string;
  expiresInSeconds: number;
}

/**
 * The single path used to issue client-facing signed URLs (makeup images and
 * profile avatars), so both get identical protections: the provider and key
 * stored with the record, a strict 60 s lifetime verified against the
 * provider's token, nothing persisted or logged, and client-safe errors.
 * Callers must have checked ownership before calling.
 */
export async function issueSignedImageUrl(
  storage: PrivateImageStorageService,
  ref: PrivateObjectRef,
  notFoundMessage: string,
): Promise<SignedImageUrlResponse> {
  try {
    const signed = await storage.createSignedUrl(
      ref,
      SIGNED_IMAGE_URL_TTL_SECONDS,
    );
    return {
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      expiresInSeconds: SIGNED_IMAGE_URL_TTL_SECONDS,
    };
  } catch (error) {
    throw toImageStorageHttpError(error, notFoundMessage);
  }
}
