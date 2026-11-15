import type { Dirent } from 'node:fs';
import { readdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isMissingFileError,
  isStructurallySafeKey,
  resolvePrivateStorageKey,
} from './private-storage-key';

/** Result of removing one file: removed now, or already gone. */
export type FileRemoval = 'DELETED' | 'MISSING';

/**
 * What account cleanup needs from a private storage adapter. Keys are
 * `/`-separated and start with the owner ID (`<ownerId>/...`).
 */
export interface PrivateFileStore {
  /** Keys of every file stored for one owner, without following links. */
  listOwnerFiles(ownerId: string): Promise<string[]>;
  /** Removes one file (never a directory, never a link target). */
  remove(storageKey: string): Promise<FileRemoval>;
  /** Removes the owner's directories that are empty; never a non-empty one. */
  removeEmptyOwnerDirectories(ownerId: string): Promise<void>;
}

/** Injection tokens for the adapters used by account cleanup. */
export const ACCOUNT_IMAGE_FILES = Symbol('ACCOUNT_IMAGE_FILES');
export const ACCOUNT_EXPORT_FILES = Symbol('ACCOUNT_EXPORT_FILES');

const SAFE_OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export class UnsafeStoredFileError extends Error {
  constructor() {
    super(
      'Private storage contains a file name that cannot be addressed safely',
    );
    this.name = 'UnsafeStoredFileError';
  }
}

function ownerDirectory(root: string, ownerId: string): string {
  if (!SAFE_OWNER.test(ownerId)) {
    throw new Error('Invalid private storage owner');
  }
  return join(root, ownerId);
}

/** Every file under `<root>/<ownerId>`, as storage keys. */
export async function listOwnerFiles(
  root: string,
  ownerId: string,
): Promise<string[]> {
  const keys: string[] = [];
  const walk = async (directory: string, prefix: string) => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const key = `${prefix}/${entry.name}`;
      // A name that is not a safe key could never be removed through the
      // key API; stop rather than report the owner's storage as clean.
      if (!isStructurallySafeKey(key)) throw new UnsafeStoredFileError();
      // Directories are walked; links and files are listed (never followed).
      if (entry.isDirectory()) await walk(join(directory, entry.name), key);
      else keys.push(key);
    }
  };
  await walk(ownerDirectory(root, ownerId), ownerId);
  return keys.sort();
}

/** Removes one file; a file that is already gone is reported as MISSING. */
export async function removeStoredFile(
  root: string,
  storageKey: string,
  errorMessage: string,
): Promise<FileRemoval> {
  const path = resolvePrivateStorageKey(root, storageKey, errorMessage, {
    requireExtension: false,
  });
  try {
    // unlink never follows a link and fails on directories.
    await unlink(path);
    return 'DELETED';
  } catch (error) {
    if (isMissingFileError(error)) return 'MISSING';
    throw error;
  }
}

/** Removes empty directories under (and including) `<root>/<ownerId>`. */
export async function removeEmptyOwnerDirectories(
  root: string,
  ownerId: string,
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
    try {
      await rmdir(directory);
    } catch (error) {
      const code = (error as { code?: string }).code;
      // Still holds files (for example one shared with another user).
      if (
        code === 'ENOTEMPTY' ||
        code === 'EEXIST' ||
        isMissingFileError(error)
      ) {
        return;
      }
      throw error;
    }
  };
  await prune(ownerDirectory(root, ownerId));
}
