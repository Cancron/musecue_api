import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFilesystemStorageProvider } from './local-filesystem-storage.provider';

const KEY = 'owner-id/session-id/0b7c9a52-8d2f-4d57-9a8c-0d8c1f0a1b2c.jpg';

describe('LocalFilesystemStorageProvider (private cloud storage fallback)', () => {
  let root: string;
  let provider: LocalFilesystemStorageProvider;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'musecue-private-'));
    provider = new LocalFilesystemStorageProvider(root);
  });

  afterEach(() => rm(root, { recursive: true, force: true }));

  it('round-trips bytes under the private root', async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0x00, 0x01]);

    await provider.put(KEY, bytes);

    await expect(provider.get(KEY)).resolves.toEqual(bytes);
    await expect(readFile(join(root, ...KEY.split('/')))).resolves.toEqual(
      bytes,
    );
  });

  it('never overwrites an existing object', async () => {
    await provider.put(KEY, Buffer.from('first'));

    await expect(
      provider.put(KEY, Buffer.from('second')),
    ).rejects.toMatchObject({
      code: 'OBJECT_ALREADY_EXISTS',
      provider: 'local',
    });
    await expect(provider.get(KEY)).resolves.toEqual(Buffer.from('first'));
  });

  it('reports a missing object and deletes idempotently', async () => {
    await expect(provider.get(KEY)).rejects.toMatchObject({
      code: 'OBJECT_NOT_FOUND',
      operation: 'get',
    });
    await expect(provider.delete(KEY)).resolves.toBeUndefined();

    await provider.put(KEY, Buffer.from('x'));
    await provider.delete(KEY);
    await expect(provider.get(KEY)).rejects.toMatchObject({
      code: 'OBJECT_NOT_FOUND',
    });
  });

  it('cannot issue signed URLs (callers fall back to the content endpoint)', async () => {
    await provider.put(KEY, Buffer.from('x'));

    await expect(provider.createSignedUrl()).rejects.toMatchObject({
      code: 'SIGNED_URL_UNSUPPORTED',
      provider: 'local',
      operation: 'sign',
    });
  });

  it('is read-only when it is not the active provider, but still serves and deletes legacy images', async () => {
    await provider.put(KEY, Buffer.from('legacy'));
    const legacyOnly = new LocalFilesystemStorageProvider(root, {
      writable: false,
    });

    await expect(
      legacyOnly.put(
        'owner-id/session-id/1b7c9a52-8d2f-4d57-9a8c-0d8c1f0a1b2c.jpg',
        Buffer.from('new'),
      ),
    ).rejects.toMatchObject({
      code: 'STORAGE_MISCONFIGURED',
      operation: 'put',
    });
    await expect(legacyOnly.get(KEY)).resolves.toEqual(Buffer.from('legacy'));
    await legacyOnly.delete(KEY);
    await expect(provider.get(KEY)).rejects.toMatchObject({
      code: 'OBJECT_NOT_FOUND',
    });
  });

  it('refuses to resolve paths outside the private root', async () => {
    const outside = join(root, '..', 'outside.jpg');
    await writeFile(outside, 'secret');
    try {
      await expect(provider.get('../outside.jpg')).rejects.toMatchObject({
        code: 'INVALID_STORAGE_KEY',
      });
    } finally {
      await rm(outside, { force: true });
    }
  });
});
