import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivacyExportStorageService } from './privacy-export-storage.service';

const OWNER = '11111111-1111-4111-8111-111111111111';
const EXPORT_ID = '22222222-2222-4222-8222-222222222222';

describe('PrivacyExportStorageService (privacy export archives)', () => {
  let root: string;
  let storage: PrivacyExportStorageService;
  const originalDir = process.env.PRIVATE_EXPORT_DIR;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'privacy-export-storage-'));
    process.env.PRIVATE_EXPORT_DIR = root;
    storage = new PrivacyExportStorageService();
  });

  afterEach(async () => {
    if (originalDir === undefined) delete process.env.PRIVATE_EXPORT_DIR;
    else process.env.PRIVATE_EXPORT_DIR = originalDir;
    await rm(root, { recursive: true, force: true });
  });

  const write = async (authId = OWNER, exportId = EXPORT_ID) => {
    const target = await storage.createArchive(authId, exportId);
    target.stream.end(Buffer.from('zip-bytes'));
    await new Promise<void>((resolve) =>
      target.stream.once('close', () => resolve()),
    );
    return target.storageKey;
  };

  it('writes owner-scoped, per-attempt archive keys inside the configured root', async () => {
    const first = await write();
    const second = await write();

    expect(first).toMatch(
      new RegExp(`^${OWNER}/${EXPORT_ID}/[0-9a-f-]{36}\\.zip$`),
    );
    expect(second).not.toBe(first);
    expect(await readFile(join(root, first))).toEqual(Buffer.from('zip-bytes'));
  });

  it('creates archives readable only by the service account', async () => {
    const key = await write();
    expect((await stat(join(root, key))).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['../escape', EXPORT_ID],
    [OWNER, '../../escape'],
    ['a/b', EXPORT_ID],
    ['', EXPORT_ID],
    [OWNER, '.hidden'],
  ])(
    'rejects unsafe scope segments (%s / %s) before touching the disk',
    async (authId, exportId) => {
      await expect(storage.createArchive(authId, exportId)).rejects.toThrow(
        'Invalid private export scope',
      );
      await expect(storage.deleteExportScope(authId, exportId)).rejects.toThrow(
        'Invalid private export scope',
      );
      expect(await readdir(root)).toEqual([]);
    },
  );

  it('rejects storage keys that escape the root', async () => {
    await expect(storage.delete('../../etc/passwd.zip')).rejects.toThrow(
      'Invalid private export storage key',
    );
  });

  it('deletes one archive, tolerating a missing file, and drops the empty scope', async () => {
    const key = await write();
    await storage.delete(key);
    await storage.delete(key);

    expect(await readdir(join(root, OWNER))).toEqual([]);
  });

  it('removes every archive of one export without touching other exports', async () => {
    const otherExport = '33333333-3333-4333-8333-333333333333';
    await write();
    await write();
    const kept = await write(OWNER, otherExport);

    await storage.deleteExportScope(OWNER, EXPORT_ID);

    expect(await readdir(join(root, OWNER))).toEqual([otherExport]);
    expect(await readFile(join(root, kept))).toEqual(Buffer.from('zip-bytes'));
  });
});
