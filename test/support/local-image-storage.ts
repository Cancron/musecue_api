import { join, resolve } from 'node:path';
import { mock } from 'jest-mock-extended';
import type { Logger } from 'winston';
import {
  PrivateImageStorageService,
  type SupportedImageMime,
} from '../../src/storage/private-image-storage.service';
import { LocalFilesystemStorageProvider } from '../../src/storage/providers/local-filesystem-storage.provider';

export function localImageStorage(): PrivateImageStorageService {
  const root = resolve(
    process.env.PRIVATE_UPLOAD_DIR ??
      join(process.cwd(), '.data', 'private-images'),
  );
  return new PrivateImageStorageService(
    [new LocalFilesystemStorageProvider(root)],
    { activeProvider: 'local', localRoot: root },
    mock<Logger>(),
  );
}

export async function saveLocalImage(
  storage: PrivateImageStorageService,
  owner: string,
  scope: string,
  mime: SupportedImageMime,
  bytes: Buffer,
): Promise<string> {
  const ref = storage.createRef(owner, scope, mime);
  await storage.put(ref, bytes, mime);
  return ref.key;
}
