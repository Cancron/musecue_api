import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

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
    sessionId: string,
    mimeType: SupportedImageMime,
    bytes: Buffer,
  ): Promise<string> {
    const storageKey = join(
      authId,
      sessionId,
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
      if (!this.isMissingFile(error)) throw error;
    }
  }

  private resolveKey(storageKey: string): string {
    const normalizedKey = storageKey.replaceAll('/', sep);
    const absolutePath = resolve(this.root, normalizedKey);
    const relativePath = relative(this.root, absolutePath);
    if (
      relativePath.startsWith(`..${sep}`) ||
      relativePath === '..' ||
      extname(absolutePath) === ''
    ) {
      throw new Error('Invalid private image storage key');
    }
    return absolutePath;
  }

  private isMissingFile(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    );
  }
}
