import type { Dirent } from 'node:fs';
import { readdir, rmdir, unlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  isMissingFileError,
  isStructurallySafeKey,
} from './private-storage-key';

/** A storage owner segment: the account ID, never a path. */
const SAFE_OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export class OwnerScopeViolationError extends Error {
  constructor() {
    super("The storage key is outside the owner's scope");
    this.name = 'OwnerScopeViolationError';
  }
}

function ownerDirectory(root: string, authId: string): string {
  if (!SAFE_OWNER.test(authId)) throw new OwnerScopeViolationError();
  return resolve(root, authId);
}

/**
 * Resolves `storageKey` only if it lies inside `<root>/<authId>/`: the key
 * must be `/`-separated, start with the owner's segment, and contain no
 * backslashes, empty, `.` or `..` segments.
 */
export function resolveOwnedKey(
  root: string,
  authId: string,
  storageKey: string,
): string {
  const directory = ownerDirectory(root, authId);
  const segments = storageKey.split('/');
  if (
    !isStructurallySafeKey(storageKey) ||
    segments.length < 2 ||
    segments[0] !== authId
  ) {
    throw new OwnerScopeViolationError();
  }
  const path = resolve(root, ...segments);
  const inside = relative(directory, path);
  if (inside === '' || inside.startsWith('..') || inside.includes(`..${sep}`)) {
    throw new OwnerScopeViolationError();
  }
  return path;
}

/**
 * Storage keys (`/`-separated on every platform) of every file under
 * `<root>/<authId>/`. Symbolic links are listed as entries (deleting one
 * removes the link, never its target) and never followed.
 */
export async function listOwnerFiles(
  root: string,
  authId: string,
): Promise<string[]> {
  const base = ownerDirectory(root, authId);
  const keys: string[] = [];
  const walk = async (directory: string, prefix: string[]) => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), [...prefix, entry.name]);
      } else {
        keys.push([authId, ...prefix, entry.name].join('/'));
      }
    }
  };
  await walk(base, []);
  return keys.sort();
}

/** Deletes one owned file; false when it was already missing. */
export async function deleteOwnedFile(
  root: string,
  authId: string,
  storageKey: string,
): Promise<boolean> {
  try {
    await unlink(resolveOwnedKey(root, authId, storageKey));
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

/**
 * Removes empty directories under `<root>/<authId>/`, deepest first, and the
 * owner directory itself once empty. Files are never removed here.
 */
export async function pruneOwnerDirectories(
  root: string,
  authId: string,
): Promise<void> {
  const prune = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await prune(join(directory, entry.name));
    }
    // Fails harmlessly (ENOTEMPTY) while files remain.
    await rmdir(directory).catch(() => undefined);
  };
  await prune(ownerDirectory(root, authId));
}
