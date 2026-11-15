import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  type FileRemoval,
  listOwnerFiles,
  type PrivateFileStore,
  removeEmptyOwnerDirectories,
  removeStoredFile,
} from './private-file-store';
import { resolvePrivateStorageKey } from './private-storage-key';

const EXTENSIONS_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
} as const;

type SupportedImageMime = keyof typeof EXTENSIONS_BY_MIME;

@Injectable()
export class PrivateImageStorageService implements PrivateFileStore {
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
    this.resolveKey(storageKey);
    await this.remove(storageKey);
  }

  /** Removes one stored file (any name), reporting one already gone. */
  remove(storageKey: string): Promise<FileRemoval> {
    return removeStoredFile(
      this.root,
      storageKey,
      'Invalid private image storage key',
    );
  }

  /** Every private image file of one owner, including unreferenced ones. */
  listOwnerFiles(ownerId: string): Promise<string[]> {
    return listOwnerFiles(this.root, ownerId);
  }

  removeEmptyOwnerDirectories(ownerId: string): Promise<void> {
    return removeEmptyOwnerDirectories(this.root, ownerId);
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
