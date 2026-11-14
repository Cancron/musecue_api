import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
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
    const storageKey = join(
      authId,
      scopeId,
      `${randomUUID()}${EXTENSIONS_BY_MIME[mimeType]}`,
    );
    const absolutePath = this.resolveKey(storageKey);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes, { flag: 'wx' });
    return storageKey.replaceAll(sep, '/');
  }

  async delete(storageKey: string): Promise<void> {
    if (storageKey.includes('://')) return;

    try {
      await unlink(this.resolveKey(storageKey));
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
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
