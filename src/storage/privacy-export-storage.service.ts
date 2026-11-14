import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rm, rmdir, unlink } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import {
  isMissingFileError,
  resolvePrivateStorageKey,
} from './private-storage-key';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface PrivacyExportArchiveTarget {
  /** Private storage key; persist it, never return it to clients. */
  storageKey: string;
  /** Exclusive (`wx`, mode 0600) write stream for the archive bytes. */
  stream: WriteStream;
}

/**
 * Private storage for generated personal-data export archives.
 *
 * Follows the private image convention (`<authId>/<scopeId>/<uuid>.<ext>`
 * under a configurable, never-public root) but uses its own root,
 * `PRIVATE_EXPORT_DIR`, so archives of all a user's data have a separate
 * retention lifecycle from the face images they are built from. Every attempt
 * writes a new key, so a superseded worker can never overwrite an archive
 * that another attempt already published.
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
    const absolutePath = this.resolveKey(storageKey);
    await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
    const stream = createWriteStream(absolutePath, {
      flags: 'wx',
      mode: 0o600,
    });
    await once(stream, 'open');
    return { storageKey, stream };
  }

  /** Removes one archive; a missing file is not an error. */
  async delete(storageKey: string): Promise<void> {
    const absolutePath = this.resolveKey(storageKey);
    try {
      await unlink(absolutePath);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    // Drop the per-export directory once it is empty; keep it otherwise.
    await rmdir(dirname(absolutePath)).catch(() => undefined);
  }

  /** Removes every archive (including partial ones) written for an export. */
  async deleteExportScope(authId: string, exportId: string): Promise<void> {
    const directory = resolve(this.root, this.scopeKey(authId, exportId));
    await rm(directory, { recursive: true, force: true });
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
