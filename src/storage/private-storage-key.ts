import { randomUUID } from 'node:crypto';
import { extname, relative, resolve, sep } from 'node:path';
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

/** One path segment of a private storage key: no separators, no dots-only names. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** The file segment written by PrivateImageStorageService.save(). */
const IMAGE_FILE_SEGMENT =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.(?:jpg|png|webp)$/;

/**
 * Whether a key is structurally safe on every platform: `/`-separated, with no
 * backslashes (a separator on Windows), NUL bytes, or empty, `.` or `..`
 * segments. Safe keys cannot express traversal before or after `/` is
 * converted to the platform separator.
 */
export function isStructurallySafeKey(storageKey: string): boolean {
  return (
    storageKey.length > 0 &&
    storageKey.length <= 512 &&
    !storageKey.includes('\\') &&
    !storageKey.includes('\0') &&
    storageKey
      .split('/')
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

/**
 * Resolves a private storage key (`/`-separated, relative) to an absolute
 * path inside `root`. Structurally unsafe keys, keys that escape the root, and
 * keys that name a directory rather than a file (no extension) are rejected.
 */
export function resolvePrivateStorageKey(
  root: string,
  storageKey: string,
  errorMessage = 'Invalid private storage key',
): string {
  if (!isStructurallySafeKey(storageKey)) throw new Error(errorMessage);
  const normalizedKey = storageKey.replaceAll('/', sep);
  const absolutePath = resolve(root, normalizedKey);
  const relativePath = relative(root, absolutePath);
  if (
    relativePath.startsWith(`..${sep}`) ||
    relativePath === '..' ||
    extname(absolutePath) === ''
  ) {
    throw new Error(errorMessage);
  }
  return absolutePath;
}

/**
 * Whether `storageKey` is a private image key in exactly the format
 * PrivateImageStorageService.save() writes for this owner and scope:
 * `<authId>/<scopeId>/<file>.<jpg|png|webp>`.
 *
 * This is an allowlist, not a blocklist: anything else (other owners or
 * scopes, backslashes, dot segments, extra or missing segments, absolute
 * paths, drive letters, URLs) is rejected, so a corrupted or crafted
 * reference can never select another user's file on any platform.
 */
export function isOwnedPrivateImageKey(
  storageKey: string,
  authId: string,
  scopeId: string,
): boolean {
  if (!SAFE_SEGMENT.test(authId) || !SAFE_SEGMENT.test(scopeId)) return false;
  if (!isStructurallySafeKey(storageKey)) return false;
  const segments = storageKey.split('/');
  return (
    segments.length === 3 &&
    segments[0] === authId &&
    segments[1] === scopeId &&
    IMAGE_FILE_SEGMENT.test(segments[2])
  );
}

export function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
