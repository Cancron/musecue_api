import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, rmdir, unlink } from 'node:fs/promises';
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
