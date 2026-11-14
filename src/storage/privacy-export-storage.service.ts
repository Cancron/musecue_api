import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
  createWriteStream,
  type ReadStream,
  type WriteStream,
} from 'node:fs';
import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import {
  isMissingFileError,
  resolvePrivateStorageKey,
} from './private-storage-key';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Suffix of an archive that is still being written (or was abandoned). */
export const PARTIAL_ARCHIVE_SUFFIX = '.partial';

export interface PrivacyExportArchiveTarget {
  /** Private key of the finished archive; persist it, never return it to clients. */
  storageKey: string;
  /**
   * Exclusive (`wx`, mode 0600) write stream for the archive bytes. It writes
   * `<storageKey>.partial`; commitArchive() renames it to `storageKey`.
   */
  stream: WriteStream;
}

export interface OpenedArchive {
  stream: ReadStream;
  sizeBytes: number;
}

/** Read-only, and never through a symbolic link where the OS supports it. */
const OPEN_ARCHIVE_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

/** The files of one export, as found in storage (`<authId>/<exportId>/`). */
export interface StoredExportScope {
  authId: string;
  exportId: string;
  /** Last modification of the export's directory. */
  modifiedAt: Date;
}

export interface DeleteExportScopeOptions {
  /** A finished archive of this export to keep; every other file is removed. */
  keep?: string;
}

/**
 * Private storage for generated personal-data export archives.
 *
 * Follows the private image convention (`<authId>/<scopeId>/<uuid>.<ext>`
 * under a configurable, never-public root) but uses its own root,
 * `PRIVATE_EXPORT_DIR`, so archives of all a user's data have a separate
 * retention lifecycle from the face images they are built from.
 *
 * An archive is written under a `.partial` name and renamed only once it is
 * complete, so an incomplete archive is never mistaken for a finished one.
 * Every attempt writes a new key, so a superseded worker can never overwrite
 * an archive that another attempt already published. Keys always use `/`;
 * only resolved filesystem paths use the platform separator.
 */
@Injectable()
export class PrivacyExportStorageService {
  private readonly root = resolve(
    process.env.PRIVATE_EXPORT_DIR ??
      join(process.cwd(), '.data', 'private-exports'),
  );

  async createArchive(
    authId: string,
    exportId: string,
  ): Promise<PrivacyExportArchiveTarget> {
    const storageKey = `${this.scopeKey(authId, exportId)}/${randomUUID()}.zip`;
    const partialPath = this.resolveKey(
      `${storageKey}${PARTIAL_ARCHIVE_SUFFIX}`,
    );
    await mkdir(dirname(partialPath), { recursive: true, mode: 0o700 });
    const stream = createWriteStream(partialPath, {
      flags: 'wx',
      mode: 0o600,
    });
    await once(stream, 'open');
    return { storageKey, stream };
  }

  /** Publishes a fully written archive under its final key (atomic rename). */
  async commitArchive(storageKey: string): Promise<void> {
    await rename(
      this.resolveKey(`${storageKey}${PARTIAL_ARCHIVE_SUFFIX}`),
      this.resolveKey(storageKey),
    );
  }

  /**
   * Opens a published archive for streaming, or returns null when it no
   * longer exists. Only finished `.zip` archives (never `.partial` files),
   * regular files, and no symbolic links are served.
   */
  async openArchive(storageKey: string): Promise<OpenedArchive | null> {
    if (!storageKey.endsWith('.zip')) {
      throw new Error('Invalid private export storage key');
    }
    const path = this.resolveKey(storageKey);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, OPEN_ARCHIVE_FLAGS);
    } catch (error) {
      // ELOOP: the path is a symbolic link, which is never served.
      if (isMissingFileError(error) || errorCode(error) === 'ELOOP') {
        return null;
      }
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        await handle.close();
        return null;
      }
      return { stream: handle.createReadStream(), sizeBytes: stats.size };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  /**
   * Removes one archive, finished or partial; missing files are not an error.
   * The per-export directory is dropped once it is empty.
   */
  async delete(storageKey: string): Promise<void> {
    const absolutePath = this.resolveKey(storageKey);
    for (const path of [
      absolutePath,
      this.resolveKey(`${storageKey}${PARTIAL_ARCHIVE_SUFFIX}`),
    ]) {
      try {
        await unlink(path);
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
    }
    await rmdir(dirname(absolutePath)).catch(() => undefined);
  }

  /**
   * Removes the files of one export: everything, or everything except
   * `options.keep` (for example partial files left by earlier attempts once
   * an archive was published). A missing directory is not an error.
   */
  async deleteExportScope(
    authId: string,
    exportId: string,
    options: DeleteExportScopeOptions = {},
  ): Promise<void> {
    const scope = this.scopeKey(authId, exportId);
    const directory = resolve(this.root, scope);
    if (!options.keep) {
      await rm(directory, { recursive: true, force: true });
      await rmdir(resolve(this.root, authId)).catch(() => undefined);
      return;
    }

    const keepPath = this.resolveKey(options.keep);
    if (dirname(keepPath) !== directory) {
      throw new Error('The kept archive does not belong to this export');
    }
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry);
      if (path !== keepPath) await rm(path, { recursive: true, force: true });
    }
  }

  /**
   * Lists the export directories in storage, so files whose database record
   * no longer exists (for example after account deletion) can still be found
   * and removed. Entries that do not have the `<authId>/<exportId>` layout are
   * ignored, never touched.
   */
  async listExportScopes(): Promise<StoredExportScope[]> {
    const scopes: StoredExportScope[] = [];
    for (const authId of await this.directoriesIn(this.root)) {
      const ownerDirectory = resolve(this.root, authId);
      for (const exportId of await this.directoriesIn(ownerDirectory)) {
        try {
          const info = await stat(resolve(ownerDirectory, exportId));
          scopes.push({ authId, exportId, modifiedAt: info.mtime });
        } catch (error) {
          if (!isMissingFileError(error)) throw error;
        }
      }
    }
    return scopes;
  }

  /** Removes every export archive of one owner (`<authId>/`). */
  async deleteOwnerDirectory(authId: string): Promise<void> {
    if (!SAFE_SEGMENT.test(authId)) {
      throw new Error('Invalid private export scope');
    }
    await rm(resolve(this.root, authId), { recursive: true, force: true });
  }

  /** Removes an owner's export directory if it is empty. */
  async removeEmptyOwnerDirectory(authId: string): Promise<void> {
    if (!SAFE_SEGMENT.test(authId)) return;
    await rmdir(resolve(this.root, authId)).catch(() => undefined);
  }

  private async directoriesIn(directory: string): Promise<string[]> {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && SAFE_SEGMENT.test(entry.name))
        .map((entry) => entry.name);
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
  }

  private scopeKey(authId: string, exportId: string): string {
    if (!SAFE_SEGMENT.test(authId) || !SAFE_SEGMENT.test(exportId)) {
      throw new Error('Invalid private export scope');
    }
    return `${authId}/${exportId}`;
  }

  private resolveKey(storageKey: string): string {
    return resolvePrivateStorageKey(
      this.root,
      storageKey,
      'Invalid private export storage key',
    );
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
