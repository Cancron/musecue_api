/**
 * Private storage under Windows path semantics.
 *
 * `node:path` is replaced by `path.win32` (so `\` is the separator, paths have
 * drive letters, and `path.join` produces backslashes) and the filesystem by
 * an in-memory one, so the same code paths a Windows server runs are exercised
 * on every CI platform. Storage keys must always use `/` and must pass the
 * same validation and ownership checks as on Linux.
 */
jest.mock(
  'node:path',
  () => jest.requireActual<typeof import('node:path')>('node:path').win32,
);
jest.mock('node:fs/promises', () => {
  const path =
    jest.requireActual<typeof import('node:path')>('node:path').win32;
  const missing = (target: string) =>
    Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
  const children = (directory: string) =>
    [...mockFiles.keys()]
      .filter((file) => file.startsWith(`${directory}\\`))
      .map((file) => file.slice(directory.length + 1).split('\\')[0]);
  return {
    mkdir: (directory: string) => {
      mockDirectories.add(path.normalize(directory));
      return Promise.resolve();
    },
    writeFile: (file: string, data: Buffer, options?: { flag?: string }) => {
      if (options?.flag === 'wx' && mockFiles.has(file)) {
        return Promise.reject(
          Object.assign(new Error('EEXIST'), { code: 'EEXIST' }),
        );
      }
      mockFiles.set(file, Buffer.from(data));
      return Promise.resolve();
    },
    readFile: (file: string) =>
      mockFiles.has(file)
        ? Promise.resolve(mockFiles.get(file))
        : Promise.reject(missing(file)),
    unlink: (file: string) =>
      mockFiles.delete(file)
        ? Promise.resolve()
        : Promise.reject(missing(file)),
    rename: (from: string, to: string) => {
      const data = mockFiles.get(from);
      if (!data) return Promise.reject(missing(from));
      mockFiles.delete(from);
      mockFiles.set(to, data);
      return Promise.resolve();
    },
    readdir: (directory: string, options?: { withFileTypes?: boolean }) => {
      const names = [...new Set(children(directory))];
      if (!names.length && !mockDirectories.has(directory)) {
        return Promise.reject(missing(directory));
      }
      if (!options?.withFileTypes) return Promise.resolve(names);
      return Promise.resolve(
        names.map((name) => ({
          name,
          isDirectory: () => !mockFiles.has(`${directory}\\${name}`),
        })),
      );
    },
    rm: (target: string) => {
      for (const file of [...mockFiles.keys()]) {
        if (file === target || file.startsWith(`${target}\\`)) {
          mockFiles.delete(file);
        }
      }
      mockDirectories.delete(target);
      return Promise.resolve();
    },
    rmdir: () => Promise.resolve(),
    open: (file: string, flags: number) => {
      mockOpenFlags.push(flags);
      const data = mockFiles.get(file);
      if (!data) return Promise.reject(missing(file));
      const { Readable } =
        jest.requireActual<typeof import('node:stream')>('node:stream');
      return Promise.resolve({
        stat: () => Promise.resolve({ isFile: () => true, size: data.length }),
        createReadStream: () => Readable.from([data]),
        close: () => Promise.resolve(),
      });
    },
  };
});
jest.mock('node:fs', () => {
  const { Writable } =
    jest.requireActual<typeof import('node:stream')>('node:stream');
  return {
    // Windows has no O_NOFOLLOW.
    constants: { O_RDONLY: 0 },
    createWriteStream: (file: string) => {
      const chunks: Buffer[] = [];
      const stream = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
        final(callback) {
          mockFiles.set(file, Buffer.concat(chunks));
          callback();
        },
      });
      process.nextTick(() => stream.emit('open'));
      return stream;
    },
  };
});

import { join, sep } from 'node:path';
import { PrivateImageStorageService } from './private-image-storage.service';
import {
  isOwnedPrivateImageKey,
  resolvePrivateStorageKey,
} from './private-storage-key';
import { PrivacyExportStorageService } from './privacy-export-storage.service';

const mockFiles = new Map<string, Buffer>();
const mockDirectories = new Set<string>();
const mockOpenFlags: number[] = [];

const IMAGE_ROOT = 'C:\\MuseCue\\private-images';
const EXPORT_ROOT = 'D:\\MuseCue Data\\private-exports';
const OWNER = '0a0a0a0a-0000-4000-8000-00000000000a';
const OTHER = '0b0b0b0b-0000-4000-8000-00000000000b';
const SESSION = 'c4c4c4c4-0000-4000-8000-000000000004';
const EXPORT_ID = 'e3e3e3e3-0000-4000-8000-000000000003';
const UUID_FILE =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

describe('Private storage on Windows (privacy export prerequisites)', () => {
  const env = {
    images: process.env.PRIVATE_UPLOAD_DIR,
    exports: process.env.PRIVATE_EXPORT_DIR,
  };

  beforeEach(() => {
    mockFiles.clear();
    mockDirectories.clear();
    process.env.PRIVATE_UPLOAD_DIR = IMAGE_ROOT;
    process.env.PRIVATE_EXPORT_DIR = EXPORT_ROOT;
  });

  afterAll(() => {
    for (const [key, value] of [
      ['PRIVATE_UPLOAD_DIR', env.images],
      ['PRIVATE_EXPORT_DIR', env.exports],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('really runs with Windows path semantics', () => {
    expect(sep).toBe('\\');
    expect(join('a', 'b')).toBe('a\\b');
  });

  describe('PrivateImageStorageService', () => {
    it.each([
      ['a session photo', SESSION, 'image/jpeg', 'jpg'],
      ['a profile avatar', 'profile', 'image/png', 'png'],
      ['a webp photo', SESSION, 'image/webp', 'webp'],
    ] as const)(
      'saves %s with a portable "/" key and stores it at the Windows path',
      async (_label, scope, mimeType, extension) => {
        const storage = new PrivateImageStorageService();
        const bytes = Buffer.from(`${scope}-bytes`);

        const key = await storage.save(OWNER, scope, mimeType, bytes);

        expect(key).toMatch(
          new RegExp(`^${OWNER}/${scope}/${UUID_FILE}\\.${extension}$`),
        );
        expect(key).not.toContain('\\');
        const fileName = key.split('/')[2];
        expect([...mockFiles.keys()]).toEqual([
          `${IMAGE_ROOT}\\${OWNER}\\${scope}\\${fileName}`,
        ]);
        // The same key reads back, and is accepted by the export's
        // ownership check exactly as on Linux.
        await expect(storage.read(key)).resolves.toEqual(bytes);
        expect(isOwnedPrivateImageKey(key, OWNER, scope)).toBe(true);

        await storage.delete(key);
        expect(mockFiles.size).toBe(0);
      },
    );

    it('keeps rejecting backslash traversal on Windows', async () => {
      const storage = new PrivateImageStorageService();
      mockFiles.set(
        `${IMAGE_ROOT}\\${OTHER}\\${SESSION}\\photo.jpg`,
        Buffer.from('other user'),
      );

      for (const key of [
        `${OWNER}/..\\${OTHER}\\${SESSION}\\photo.jpg`,
        `${OWNER}\\..\\${OTHER}\\${SESSION}\\photo.jpg`,
        `${OWNER}/${SESSION}/..\\..\\${OTHER}\\${SESSION}\\photo.jpg`,
      ]) {
        // Whether read() throws or rejects, the file is never opened.
        await expect(
          Promise.resolve().then(() => storage.read(key)),
        ).rejects.toThrow('Invalid private image storage key');
        expect(isOwnedPrivateImageKey(key, OWNER, SESSION)).toBe(false);
      }
    });

    it('lists and deletes an owner’s files with "/" keys, and refuses other owners', async () => {
      const storage = new PrivateImageStorageService();
      const mine = await storage.save(
        OWNER,
        SESSION,
        'image/jpeg',
        Buffer.from('a'),
      );
      const avatar = await storage.save(
        OWNER,
        'profile',
        'image/png',
        Buffer.from('b'),
      );
      const theirs = await storage.save(
        OTHER,
        SESSION,
        'image/jpeg',
        Buffer.from('c'),
      );

      const keys = await storage.listOwnerFiles(OWNER);

      expect(keys.sort()).toEqual([avatar, mine].sort());
      expect(keys.every((key) => !key.includes('\\'))).toBe(true);
      await expect(storage.deleteOwnerFile(OWNER, theirs)).rejects.toThrow(
        "outside the owner's scope",
      );
      for (const key of keys) {
        await expect(storage.deleteOwnerFile(OWNER, key)).resolves.toBe(true);
      }
      await expect(storage.deleteOwnerFile(OWNER, mine)).resolves.toBe(false);
      expect([...mockFiles.keys()]).toEqual([
        `${IMAGE_ROOT}\\${OTHER}\\${SESSION}\\${theirs.split('/')[2]}`,
      ]);
    });

    it('resolves keys to drive-letter paths inside the root', () => {
      expect(
        resolvePrivateStorageKey(IMAGE_ROOT, `${OWNER}/${SESSION}/a.jpg`),
      ).toBe(`${IMAGE_ROOT}\\${OWNER}\\${SESSION}\\a.jpg`);
    });
  });

  describe('PrivacyExportStorageService', () => {
    const writeArchive = async (storage: PrivacyExportStorageService) => {
      const target = await storage.createArchive(OWNER, EXPORT_ID);
      await new Promise<void>((resolve, reject) =>
        target.stream
          .end(Buffer.from('zip'), () => resolve())
          .on('error', reject),
      );
      return target.storageKey;
    };

    it('writes, commits and cleans up archives under Windows paths (root with a space)', async () => {
      const storage = new PrivacyExportStorageService();
      const directory = `${EXPORT_ROOT}\\${OWNER}\\${EXPORT_ID}`;

      const stale = await writeArchive(storage);
      const published = await writeArchive(storage);
      expect(published).toMatch(
        new RegExp(`^${OWNER}/${EXPORT_ID}/${UUID_FILE}\\.zip$`),
      );
      expect([...mockFiles.keys()].sort()).toEqual(
        [
          `${directory}\\${stale.split('/')[2]}.partial`,
          `${directory}\\${published.split('/')[2]}.partial`,
        ].sort(),
      );

      await storage.commitArchive(published);
      await storage.deleteExportScope(OWNER, EXPORT_ID, { keep: published });
      expect([...mockFiles.keys()]).toEqual([
        `${directory}\\${published.split('/')[2]}`,
      ]);

      await storage.deleteExportScope(OWNER, EXPORT_ID);
      expect(mockFiles.size).toBe(0);
    });

    it('opens a published archive for download (no O_NOFOLLOW on Windows)', async () => {
      const storage = new PrivacyExportStorageService();
      const key = await writeArchive(storage);

      // Not yet committed: only a .partial file exists, nothing is served.
      await expect(storage.openArchive(key)).resolves.toBeNull();
      await storage.commitArchive(key);

      const opened = await storage.openArchive(key);
      expect(opened?.sizeBytes).toBe(3);
      const chunks: Buffer[] = [];
      for await (const chunk of opened!.stream) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks).toString()).toBe('zip');
      expect(mockOpenFlags.at(-1)).toBe(0);
      await expect(storage.openArchive(`${key}${'.partial'}`)).rejects.toThrow(
        'Invalid private export storage key',
      );
    });
  });
});
