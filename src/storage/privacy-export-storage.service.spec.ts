import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
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

  /** Writes an archive; commits it unless `commit` is false. */
  const write = async (authId = OWNER, exportId = EXPORT_ID, commit = true) => {
    const target = await storage.createArchive(authId, exportId);
    target.stream.end(Buffer.from('zip-bytes'));
    await new Promise<void>((resolve) =>
      target.stream.once('close', () => resolve()),
    );
    if (commit) await storage.commitArchive(target.storageKey);
    return target.storageKey;
  };
  const files = (authId = OWNER, exportId = EXPORT_ID) =>
    readdir(join(root, authId, exportId)).then((names) => names.sort());

  it('writes owner-scoped, per-attempt archive keys inside the configured root', async () => {
    const first = await write();
    const second = await write();

    expect(first).toMatch(
      new RegExp(`^${OWNER}/${EXPORT_ID}/[0-9a-f-]{36}\\.zip$`),
    );
    expect(second).not.toBe(first);
    expect(await readFile(join(root, first))).toEqual(Buffer.from('zip-bytes'));
  });

  it('writes an incomplete archive under a .partial name until it is committed', async () => {
    const key = await write(OWNER, EXPORT_ID, false);
    const name = key.split('/').pop()!;

    expect(await files()).toEqual([`${name}.partial`]);
    await storage.commitArchive(key);
    expect(await files()).toEqual([name]);
  });

  it('deletes an archive whether or not it was committed', async () => {
    const partial = await write(OWNER, EXPORT_ID, false);
    const finished = await write();

    await storage.delete(partial);
    await storage.delete(finished);

    await expect(files()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps only the published archive when asked to, removing partial files of other attempts', async () => {
    await write(OWNER, EXPORT_ID, false);
    await write(OWNER, EXPORT_ID, false);
    const published = await write();

    await storage.deleteExportScope(OWNER, EXPORT_ID, { keep: published });

    expect(await files()).toEqual([published.split('/').pop()]);
    expect(await readFile(join(root, published))).toEqual(
      Buffer.from('zip-bytes'),
    );
  });

  it('refuses to keep a file that belongs to another export', async () => {
    const otherExport = '44444444-4444-4444-8444-444444444444';
    await write();
    const foreign = await write(OWNER, otherExport);

    await expect(
      storage.deleteExportScope(OWNER, EXPORT_ID, { keep: foreign }),
    ).rejects.toThrow('does not belong to this export');
    expect(await files()).toHaveLength(1);
  });

  it('treats cleanup of an export without files as done', async () => {
    await expect(
      storage.deleteExportScope(OWNER, EXPORT_ID),
    ).resolves.toBeUndefined();
    await expect(
      storage.deleteExportScope(OWNER, EXPORT_ID, {
        keep: `${OWNER}/${EXPORT_ID}/x.zip`,
      }),
    ).resolves.toBeUndefined();
  });

  describe('openArchive', () => {
    const read = async (stream: NodeJS.ReadableStream) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    };

    it('opens a published archive with its size', async () => {
      const key = await write();

      const opened = await storage.openArchive(key);

      expect(opened?.sizeBytes).toBe('zip-bytes'.length);
      expect(await read(opened!.stream)).toEqual(Buffer.from('zip-bytes'));
    });

    it('never serves an unfinished archive or a missing file', async () => {
      const partial = await write(OWNER, EXPORT_ID, false);

      await expect(storage.openArchive(partial)).resolves.toBeNull();
      await expect(storage.openArchive(`${partial}.partial`)).rejects.toThrow(
        'Invalid private export storage key',
      );
      await expect(
        storage.openArchive(`${OWNER}/${EXPORT_ID}/missing.zip`),
      ).resolves.toBeNull();
    });

    it('does not follow a symbolic link planted in place of an archive', async () => {
      if (process.platform === 'win32') return;
      const secret = join(root, 'outside-secret.txt');
      await writeFile(secret, 'not an archive');
      const key = `${OWNER}/${EXPORT_ID}/planted.zip`;
      await mkdir(join(root, OWNER, EXPORT_ID), { recursive: true });
      await symlink(secret, join(root, key));

      await expect(storage.openArchive(key)).resolves.toBeNull();
    });

    it('rejects keys outside the export root', async () => {
      await expect(storage.openArchive('../../etc/passwd.zip')).rejects.toThrow(
        'Invalid private export storage key',
      );
    });
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

    await storage.deleteExportScope(OWNER, otherExport);
    // The owner's directory is dropped once the last export is gone.
    expect(await readdir(root)).toEqual([]);
  });
});
