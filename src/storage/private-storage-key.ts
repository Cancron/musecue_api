import { randomUUID } from 'node:crypto';
import { PrivateStorageError } from './private-storage.error';

export const EXTENSIONS_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
} as const;

export type SupportedImageMime = keyof typeof EXTENSIONS_BY_MIME;

const MAX_KEY_LENGTH = 512;
const MAX_SEGMENTS = 8;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.(?:jpg|png|webp)$/;

/**
 * Builds a new, unguessable object key: `<authId>/<scopeId>/<uuid>.<ext>`.
 * The format is identical for every provider so keys stay portable.
 */
export function buildPrivateImageKey(
  authId: string,
  scopeId: string,
  mimeType: SupportedImageMime,
): string {
  const extension = EXTENSIONS_BY_MIME[mimeType];
  if (!extension || !SEGMENT.test(authId) || !SEGMENT.test(scopeId)) {
    throw new PrivateStorageError('INVALID_STORAGE_KEY');
  }
  return `${authId}/${scopeId}/${randomUUID()}${extension}`;
}

/**
 * Accepts only relative keys made of safe segments ending in an image file
 * name. Rejects URLs, absolute paths, traversal, backslashes and empty
 * segments so no provider can be steered outside its own namespace.
 */
export function assertValidPrivateImageKey(key: string): void {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > MAX_KEY_LENGTH
  ) {
    throw new PrivateStorageError('INVALID_STORAGE_KEY');
  }
  const segments = key.split('/');
  const fileName = segments.pop();
  if (
    !fileName ||
    segments.length === 0 ||
    segments.length + 1 > MAX_SEGMENTS ||
    !FILE_NAME.test(fileName) ||
    !segments.every((segment) => SEGMENT.test(segment))
  ) {
    throw new PrivateStorageError('INVALID_STORAGE_KEY');
  }
}
