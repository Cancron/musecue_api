import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  isMissingFileError,
  resolvePrivateStorageKey,
} from './private-storage-key';

const EXTENSIONS_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
} as const;

type SupportedImageMime = keyof typeof EXTENSIONS_BY_MIME;

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

@Injectable()
export class PrivateImageStorageService {
  private readonly root = resolve(
    process.env.PRIVATE_UPLOAD_DIR ??
      join(process.cwd(), '.data', 'private-images'),
  );

  async save(
    authId: string,
    scopeId: string,
    mimeType: SupportedImageMime,
    bytes: Buffer,
  ): Promise<string> {
    // Storage keys always use `/`, whatever the platform. Only the resolved
    // filesystem path uses the platform separator (`\\` on Windows), so keys
    // stay portable and pass the same validation on every OS.
    const storageKey = [
      authId,
      scopeId,
      `${randomUUID()}${EXTENSIONS_BY_MIME[mimeType]}`,
    ].join('/');
    const absolutePath = this.resolveKey(storageKey);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes, { flag: 'wx' });
    return storageKey;
  }

  async delete(storageKey: string): Promise<void> {
    if (storageKey.includes('://')) return;

    try {
      await unlink(this.resolveKey(storageKey));
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }

  /**
   * Removes every private image of one owner (`<authId>/`), including files
   * no database row references any more. Used when an account is erased.
   */
  async deleteOwnerDirectory(authId: string): Promise<void> {
    if (!SAFE_SEGMENT.test(authId)) {
      throw new Error('Invalid private image storage owner');
    }
    await rm(resolve(this.root, authId), { recursive: true, force: true });
  }

  read(storageKey: string): Promise<Buffer> {
    return readFile(this.resolveKey(storageKey));
  }

  private resolveKey(storageKey: string): string {
    return resolvePrivateStorageKey(
      this.root,
      storageKey,
      'Invalid private image storage key',
    );
  }
}
