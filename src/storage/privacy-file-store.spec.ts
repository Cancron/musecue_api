import {
  chmod,
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
import { UnsafeStoredFileError } from './private-file-store';
import { PrivateImageStorageService } from './private-image-storage.service';
import { PrivacyExportStorageService } from './privacy-export-storage.service';

const OWNER = '0a0a0a0a-0000-4000-8000-00000000000a';
const OTHER = '0b0b0b0b-0000-4000-8000-00000000000b';

/**
 * The private storage adapters' account-cleanup operations on a real
 * filesystem: what they list, remove and prune.
 */
describe('Private storage adapters for account cleanup (privacy)', () => {
  let root: string;
  let images: PrivateImageStorageService;
  let exportsStore: PrivacyExportStorageService;
  const env = {
    images: process.env.PRIVATE_UPLOAD_DIR,
    exports: process.env.PRIVATE_EXPORT_DIR,
  };
  const put = async (
    area: 'images' | 'exports',
    key: string,
    content = 'x',
  ) => {
    const path = join(root, area, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  };
  const exists = (area: string, key: string) =>
    readFile(join(root, area, key)).then(
      () => true,
      () => false,
    );

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'privacy-file-store-'));
    process.env.PRIVATE_UPLOAD_DIR = join(root, 'images');
    process.env.PRIVATE_EXPORT_DIR = join(root, 'exports');
    images = new PrivateImageStorageService();
    exportsStore = new PrivacyExportStorageService();
  });

  afterEach(async () => {
    for (const [key, value] of [
      ['PRIVATE_UPLOAD_DIR', env.images],
      ['PRIVATE_EXPORT_DIR', env.exports],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  describe('listOwnerFiles', () => {
    it('lists every file of the owner, nested and unreferenced ones included, and nothing of other owners', async () => {
      await put('images', `${OWNER}/session-1/a.jpg`);
      await put('images', `${OWNER}/profile/avatar.png`);
      await put('images', `${OWNER}/session-1/orphan-without-extension`);
      await put('images', `${OTHER}/session-2/b.jpg`);

      await expect(images.listOwnerFiles(OWNER)).resolves.toEqual([
        `${OWNER}/profile/avatar.png`,
        `${OWNER}/session-1/a.jpg`,
        `${OWNER}/session-1/orphan-without-extension`,
      ]);
    });

    it('lists export archives and temporary .partial files', async () => {
      await put('exports', `${OWNER}/export-1/archive.zip`);
      await put('exports', `${OWNER}/export-2/attempt.zip.partial`);

      await expect(exportsStore.listOwnerFiles(OWNER)).resolves.toEqual([
        `${OWNER}/export-1/archive.zip`,
        `${OWNER}/export-2/attempt.zip.partial`,
      ]);
    });

    it('returns nothing for an owner without storage', async () => {
      await expect(images.listOwnerFiles(OWNER)).resolves.toEqual([]);
    });

    it('lists a symbolic link as a file without following it', async () => {
      if (process.platform === 'win32') return;
      await put('images', `${OTHER}/session-2/secret.jpg`);
      await mkdir(join(root, 'images', OWNER), { recursive: true });
      // A link to another owner's directory must not expose its files.
      await symlink(
        join(root, 'images', OTHER),
        join(root, 'images', OWNER, 'link'),
      );

      await expect(images.listOwnerFiles(OWNER)).resolves.toEqual([
        `${OWNER}/link`,
      ]);
    });

    it('refuses to report storage as listed when a file cannot be addressed safely', async () => {
      if (process.platform === 'win32') return;
      await put('images', `${OWNER}/session-1/a.jpg`);
      await writeFile(join(root, 'images', OWNER, 'weird\\name.jpg'), 'x');

      await expect(images.listOwnerFiles(OWNER)).rejects.toBeInstanceOf(
        UnsafeStoredFileError,
      );
    });

    it.each(['', '..', '../x', `${OWNER}/sub`, 'a\\b'])(
      'rejects the unsafe owner %j',
      async (owner) => {
        await expect(images.listOwnerFiles(owner)).rejects.toThrow(
          'Invalid private storage owner',
        );
      },
    );
  });

  describe('remove', () => {
    it('removes one file and reports DELETED, then MISSING', async () => {
      await put('images', `${OWNER}/session-1/a.jpg`);
      await put('images', `${OWNER}/session-1/b.jpg`);

      await expect(images.remove(`${OWNER}/session-1/a.jpg`)).resolves.toBe(
        'DELETED',
      );
      await expect(images.remove(`${OWNER}/session-1/a.jpg`)).resolves.toBe(
        'MISSING',
      );
      expect(await exists('images', `${OWNER}/session-1/b.jpg`)).toBe(true);
    });

    it('removes temporary export files', async () => {
      await put('exports', `${OWNER}/export-1/attempt.zip.partial`);

      await expect(
        exportsStore.remove(`${OWNER}/export-1/attempt.zip.partial`),
      ).resolves.toBe('DELETED');
    });

    it('removes a link itself, never the file it points to', async () => {
      if (process.platform === 'win32') return;
      await put('images', `${OTHER}/session-2/secret.jpg`, 'other user');
      await mkdir(join(root, 'images', OWNER), { recursive: true });
      await symlink(
        join(root, 'images', OTHER, 'session-2', 'secret.jpg'),
        join(root, 'images', OWNER, 'link.jpg'),
      );

      await expect(images.remove(`${OWNER}/link.jpg`)).resolves.toBe('DELETED');

      expect(await exists('images', `${OTHER}/session-2/secret.jpg`)).toBe(
        true,
      );
    });

    it('fails (instead of succeeding) on a directory', async () => {
      await put('images', `${OWNER}/session-1/a.jpg`);

      await expect(images.remove(`${OWNER}/session-1`)).rejects.toMatchObject({
        code: expect.stringMatching(/EISDIR|EPERM/) as unknown,
      });
      expect(await exists('images', `${OWNER}/session-1/a.jpg`)).toBe(true);
    });

    it.each([
      '../outside.jpg',
      `${OWNER}/../${OTHER}/x.jpg`,
      `${OWNER}\\..\\${OTHER}\\x.jpg`,
      '',
    ])('rejects the unsafe key %j', async (key) => {
      await expect(images.remove(key)).rejects.toThrow(
        'Invalid private image storage key',
      );
    });
  });

  describe('removeEmptyOwnerDirectories', () => {
    it('removes the owner’s empty directories and keeps any that still hold a file', async () => {
      await mkdir(join(root, 'images', OWNER, 'empty-1', 'nested'), {
        recursive: true,
      });
      await put('images', `${OWNER}/shared/kept.jpg`);
      await put('images', `${OTHER}/session-2/b.jpg`);

      await images.removeEmptyOwnerDirectories(OWNER);

      expect(await readdir(join(root, 'images', OWNER))).toEqual(['shared']);
      expect(await exists('images', `${OWNER}/shared/kept.jpg`)).toBe(true);
      expect(await exists('images', `${OTHER}/session-2/b.jpg`)).toBe(true);
    });

    it('removes the owner directory once it is empty', async () => {
      await mkdir(join(root, 'exports', OWNER, 'export-1'), {
        recursive: true,
      });

      await exportsStore.removeEmptyOwnerDirectories(OWNER);

      expect(await readdir(join(root, 'exports'))).toEqual([]);
    });

    it('reports a directory that cannot be removed instead of ignoring it', async () => {
      if (process.platform === 'win32' || process.getuid?.() === 0) return;
      const owner = join(root, 'images', OWNER);
      await mkdir(join(owner, 'empty'), { recursive: true });
      // Without write permission on its parent, rmdir fails with EACCES.
      await chmod(owner, 0o500);
      try {
        await expect(
          images.removeEmptyOwnerDirectories(OWNER),
        ).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        await chmod(owner, 0o700);
      }
      expect(await readdir(owner)).toEqual(['empty']);
    });

    it('treats a missing owner directory as clean', async () => {
      await expect(
        images.removeEmptyOwnerDirectories(OWNER),
      ).resolves.toBeUndefined();
    });
  });
});
