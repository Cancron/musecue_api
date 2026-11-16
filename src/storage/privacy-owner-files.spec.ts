import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  OwnerScopeViolationError,
  deleteOwnedFile,
  listOwnerFiles,
  pruneOwnerDirectories,
} from './private-storage-owner-files';

const OWNER = '0a0a0a0a-0000-4000-8000-00000000000a';
const OTHER = '0b0b0b0b-0000-4000-8000-00000000000b';

describe('Owner-scoped private storage operations (privacy account cleanup)', () => {
  let root: string;

  const put = async (key: string, content = key) => {
    const path = join(root, ...key.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'privacy-owner-files-'));
    await put(`${OWNER}/session-1/a.jpg`);
    await put(`${OWNER}/session-1/nested/b.png`);
    await put(`${OWNER}/profile/avatar.png`);
    await put(`${OWNER}/export-1/archive.zip.partial`);
    await put(`${OTHER}/session-2/c.jpg`);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('listOwnerFiles', () => {
    it('lists every file of the owner, at any depth, as "/" keys, and nothing of others', async () => {
      await expect(listOwnerFiles(root, OWNER)).resolves.toEqual([
        `${OWNER}/export-1/archive.zip.partial`,
        `${OWNER}/profile/avatar.png`,
        `${OWNER}/session-1/a.jpg`,
        `${OWNER}/session-1/nested/b.png`,
      ]);
    });

    it('lists nothing for an owner without files', async () => {
      await expect(
        listOwnerFiles(root, '0c0c0c0c-0000-4000-8000-00000000000c'),
      ).resolves.toEqual([]);
    });

    it.each(['..', '', '.', `${OWNER}/x`, 'a\\..', '../etc'])(
      'refuses the owner %j',
      async (owner) => {
        await expect(listOwnerFiles(root, owner)).rejects.toBeInstanceOf(
          OwnerScopeViolationError,
        );
      },
    );

    it('lists a symbolic link as an entry without following it', async () => {
      if (process.platform === 'win32') return;
      await mkdir(join(root, 'outside'), { recursive: true });
      await writeFile(join(root, 'outside', 'secret.txt'), 'secret');
      await symlink(join(root, 'outside'), join(root, OWNER, 'link'));

      const keys = await listOwnerFiles(root, OWNER);

      expect(keys).toContain(`${OWNER}/link`);
      expect(keys.some((key) => key.includes('secret'))).toBe(false);
    });
  });

  describe('deleteOwnedFile', () => {
    it('deletes an owned file and reports a missing one', async () => {
      await expect(
        deleteOwnedFile(root, OWNER, `${OWNER}/session-1/a.jpg`),
      ).resolves.toBe(true);
      await expect(
        deleteOwnedFile(root, OWNER, `${OWNER}/session-1/a.jpg`),
      ).resolves.toBe(false);
      await expect(readdir(join(root, OWNER, 'session-1'))).resolves.toEqual([
        'nested',
      ]);
    });

    it.each([
      `${OTHER}/session-2/c.jpg`,
      `${OWNER}/../${OTHER}/session-2/c.jpg`,
      `${OWNER}/..\\${OTHER}\\session-2\\c.jpg`,
      `${OWNER}`,
      `${OWNER}/`,
      `/${OWNER}/session-1/a.jpg`,
      `${OWNER}-evil/session-1/a.jpg`,
    ])('refuses %j and leaves every file in place', async (key) => {
      await expect(deleteOwnedFile(root, OWNER, key)).rejects.toBeInstanceOf(
        OwnerScopeViolationError,
      );
      await expect(
        readFile(join(root, OTHER, 'session-2', 'c.jpg'), 'utf8'),
      ).resolves.toBe(`${OTHER}/session-2/c.jpg`);
      expect(await listOwnerFiles(root, OWNER)).toHaveLength(4);
    });

    it('removes a symbolic link itself, never its target', async () => {
      if (process.platform === 'win32') return;
      await writeFile(join(root, 'target.txt'), 'keep me');
      await symlink(join(root, 'target.txt'), join(root, OWNER, 'link.txt'));

      await expect(
        deleteOwnedFile(root, OWNER, `${OWNER}/link.txt`),
      ).resolves.toBe(true);

      await expect(readFile(join(root, 'target.txt'), 'utf8')).resolves.toBe(
        'keep me',
      );
    });
  });

  describe('pruneOwnerDirectories', () => {
    it('removes only empty directories, never files', async () => {
      await deleteOwnedFile(root, OWNER, `${OWNER}/session-1/nested/b.png`);
      await deleteOwnedFile(
        root,
        OWNER,
        `${OWNER}/export-1/archive.zip.partial`,
      );

      await pruneOwnerDirectories(root, OWNER);

      expect(await listOwnerFiles(root, OWNER)).toEqual([
        `${OWNER}/profile/avatar.png`,
        `${OWNER}/session-1/a.jpg`,
      ]);
      expect((await readdir(join(root, OWNER))).sort()).toEqual([
        'profile',
        'session-1',
      ]);
      expect(await readdir(join(root, OWNER, 'session-1'))).toEqual(['a.jpg']);
    });

    it('removes the owner directory once it is empty, and no other owner', async () => {
      for (const key of await listOwnerFiles(root, OWNER)) {
        await deleteOwnedFile(root, OWNER, key);
      }

      await pruneOwnerDirectories(root, OWNER);
      await pruneOwnerDirectories(root, OWNER);

      expect(await readdir(root)).toEqual([OTHER]);
    });
  });
});
