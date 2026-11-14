import { extname, relative, resolve, sep } from 'node:path';

/**
 * Resolves a private storage key (`/`-separated, relative) to an absolute
 * path inside `root`. Keys that escape the root or name a directory rather
 * than a file (no extension) are rejected.
 */
export function resolvePrivateStorageKey(
  root: string,
  storageKey: string,
  errorMessage = 'Invalid private storage key',
): string {
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

export function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
