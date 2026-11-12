import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { PrivateObjectStorageProvider } from '../private-object-storage.provider';
import { LOCAL_STORAGE_PROVIDER_ID } from '../private-storage.config';
import {
  PrivateStorageError,
  type PrivateStorageOperation,
} from '../private-storage.error';

/**
 * Private filesystem storage for local/offline development and for reading
 * and deleting images stored before the move to cloud storage. The root must
 * never be served as a public static directory.
 */
export class LocalFilesystemStorageProvider implements PrivateObjectStorageProvider {
  readonly id = LOCAL_STORAGE_PROVIDER_ID;

  constructor(private readonly root: string) {}

  async put(key: string, bytes: Buffer): Promise<void> {
    const absolutePath = this.resolveKey(key);
    try {
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, bytes, { flag: 'wx' });
    } catch (error) {
      throw this.toStorageError(error, 'put');
    }
  }

  async get(key: string): Promise<Buffer> {
    const absolutePath = this.resolveKey(key);
    try {
      return await readFile(absolutePath);
    } catch (error) {
      throw this.toStorageError(error, 'get');
    }
  }

  async delete(key: string): Promise<void> {
    const absolutePath = this.resolveKey(key);
    try {
      await unlink(absolutePath);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw this.toStorageError(error, 'delete');
    }
  }

  /** Defense in depth on top of key validation: stay inside the root. */
  private resolveKey(key: string): string {
    const absolutePath = resolve(this.root, key.replaceAll('/', sep));
    const relativePath = relative(this.root, absolutePath);
    if (
      relativePath === '' ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new PrivateStorageError('INVALID_STORAGE_KEY', {
        provider: this.id,
      });
    }
    return absolutePath;
  }

  private toStorageError(
    error: unknown,
    operation: PrivateStorageOperation,
  ): PrivateStorageError {
    const code = errorCode(error);
    const details = { provider: this.id, operation, cause: error };
    if (code === 'ENOENT') {
      return new PrivateStorageError('OBJECT_NOT_FOUND', details);
    }
    if (code === 'EEXIST') {
      return new PrivateStorageError('OBJECT_ALREADY_EXISTS', details);
    }
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      return new PrivateStorageError('STORAGE_MISCONFIGURED', details);
    }
    return new PrivateStorageError('STORAGE_UNAVAILABLE', details);
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
