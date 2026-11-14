import { mock } from 'jest-mock-extended';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import {
  EXPORT_ID,
  OTHER_ID,
  OTHER_PHOTO_KEY,
  OTHER_SESSION_ID,
  OWNER_AVATAR_KEY,
  OWNER_ID,
  OWNER_PHOTO_KEY,
  PHOTO_BYTES,
  SESSION_ID,
  SUBSCRIPTION_STATUS,
  privacyPrismaFake,
} from '../../../test/support/privacy-fixtures';
import { readZip } from '../../../test/support/read-zip';
import { PrivateImageStorageService } from '../../storage/private-image-storage.service';
import {
  isOwnedPrivateImageKey,
  resolvePrivateStorageKey,
} from '../../storage/private-storage-key';
import { PrivacyExportStorageService } from '../../storage/privacy-export-storage.service';
import type { SubscriptionAccessService } from '../../subscription/subscription-access.service';
import { PrivacyExportArchiveService } from './privacy-export-archive.service';
import { PrivacyExportCollectorService } from './privacy-export-collector.service';

const A = OWNER_ID;
const S = SESSION_ID;
const B = OTHER_ID;
const T = OTHER_SESSION_ID;
const FILE = '0f0f0f0f-0000-4000-8000-00000000000f.jpg';

/**
 * Keys that try to reach another user's photo (or are not in the canonical
 * `<authId>/<scope>/<file>` form). The backslash cases are real attacks on
 * Windows, where `\` is a path separator.
 */
const BACKSLASH_ATTACKS = [
  `${A}/..\\${B}\\${T}\\photo.jpg`,
  `${A}\\..\\${B}\\${T}\\photo.jpg`,
  `${A}/${S}\\..\\..\\${B}\\${T}\\photo.jpg`,
  `${A}/${S}/..\\..\\${B}\\${T}\\photo.jpg`,
  `${A}/${S}/photo.jpg\\..\\..\\..\\${B}\\${T}\\photo.jpg`,
  `${A}/${S}/..\\..\\..\\..\\..\\etc\\passwd.jpg`,
];
const OTHER_ATTACKS = [
  `${A}/../${B}/${T}/photo.jpg`,
  `${A}/${S}/../../${B}/${T}/photo.jpg`,
  `${A}/${S}/photo.jpg/../../../${B}/${T}/photo.jpg`,
  `${A}/./${S}/${FILE}`,
  `${A}/${S}//${FILE}`,
  `${A}/${S}/.`,
  `${A}/${S}/...`,
  `/${A}/${S}/${FILE}`,
  `C:/data/${B}/${T}/photo.jpg`,
  `C:\\data\\${B}\\${T}\\photo.jpg`,
  `\\\\server\\share\\${B}\\${T}\\photo.jpg`,
  `${A}/%2e%2e/${B}/${T}/photo.jpg`,
  `${A}/\uFF0E\uFF0E/${B}/${T}/photo.jpg`,
  `${A}/${S}/${FILE}\0.png`,
  `${A}/${S}/photo.exe`,
  `${A}/${S}/photo`,
  `${A}/${S}/.jpg`,
  `${A}/${S}/sub/${FILE}`,
  `${A}/${FILE}`,
  `${B}/${T}/${FILE}`,
  `${A}-evil/${S}/${FILE}`,
  `${A}/${T}/${FILE}`,
  `https://cdn.example.com/${B}/${FILE}`,
];

describe('Privacy export photo ownership (path traversal)', () => {
  describe('isOwnedPrivateImageKey', () => {
    it('accepts exactly the keys the image storage writes for this owner and scope', () => {
      expect(isOwnedPrivateImageKey(`${A}/${S}/${FILE}`, A, S)).toBe(true);
      expect(
        isOwnedPrivateImageKey(
          `${A}/profile/${FILE.replace('jpg', 'png')}`,
          A,
          'profile',
        ),
      ).toBe(true);
      expect(isOwnedPrivateImageKey(OWNER_PHOTO_KEY, A, S)).toBe(true);
      expect(isOwnedPrivateImageKey(OWNER_AVATAR_KEY, A, 'profile')).toBe(true);
    });

    it.each(BACKSLASH_ATTACKS)(
      'rejects the backslash traversal %j, which reaches another user on Windows',
      (key) => {
        // The attack is real: with Windows path semantics it leaves the
        // owner's directory even though it starts with the owner's ID.
        const ownerDir = win32.join('C:\\private-images', A);
        const resolved = win32.resolve(
          'C:\\private-images',
          key.replaceAll('/', '\\'),
        );
        expect(win32.relative(ownerDir, resolved).startsWith('..')).toBe(true);

        expect(isOwnedPrivateImageKey(key, A, S)).toBe(false);
        expect(isOwnedPrivateImageKey(key, A, 'profile')).toBe(false);
      },
    );

    it.each(OTHER_ATTACKS)(
      'rejects the non-canonical or foreign key %j',
      (key) => {
        expect(isOwnedPrivateImageKey(key, A, S)).toBe(false);
      },
    );

    it('rejects a key for the right owner but a different session', () => {
      expect(isOwnedPrivateImageKey(`${A}/${S}/${FILE}`, A, T)).toBe(false);
      expect(isOwnedPrivateImageKey(`${A}/${S}/${FILE}`, A, 'profile')).toBe(
        false,
      );
    });

    it('rejects unsafe owner or scope arguments', () => {
      expect(isOwnedPrivateImageKey(`${A}/${S}/${FILE}`, `${A}\\..`, S)).toBe(
        false,
      );
      expect(isOwnedPrivateImageKey(`../${S}/${FILE}`, '..', S)).toBe(false);
      expect(isOwnedPrivateImageKey(`${A}/${S}/${FILE}`, '', S)).toBe(false);
    });
  });

  describe('resolvePrivateStorageKey (all private file access)', () => {
    it.each([
      ...BACKSLASH_ATTACKS,
      `${A}/../${B}/${T}/photo.jpg`,
      `${A}//x.jpg`,
    ])('refuses %j before resolving a path, on every platform', (key) => {
      expect(() => resolvePrivateStorageKey('/private', key)).toThrow(
        'Invalid private storage key',
      );
    });

    it('still resolves canonical keys', () => {
      expect(resolvePrivateStorageKey('/private', `${A}/${S}/${FILE}`)).toBe(
        join('/private', A, S, FILE),
      );
    });
  });

  describe('archive built for a user whose image records were tampered with', () => {
    let root: string;
    const env = {
      images: process.env.PRIVATE_UPLOAD_DIR,
      exports: process.env.PRIVATE_EXPORT_DIR,
    };
    const attacks = [...BACKSLASH_ATTACKS, ...OTHER_ATTACKS];

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'privacy-ownership-'));
      process.env.PRIVATE_UPLOAD_DIR = join(root, 'images');
      process.env.PRIVATE_EXPORT_DIR = join(root, 'exports');
      for (const [key, bytes] of [
        [OWNER_AVATAR_KEY, PHOTO_BYTES.avatar],
        [OWNER_PHOTO_KEY, PHOTO_BYTES.uploaded],
        [OTHER_PHOTO_KEY, PHOTO_BYTES.other],
      ] as const) {
        const path = join(root, 'images', key);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
      }
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

    it('never reads or archives a photo outside the owner’s own scope', async () => {
      const prisma = privacyPrismaFake();
      // The owner's legitimate photo plus one tampered record per attack key.
      prisma.imageAsset.findMany.mockResolvedValue([
        {
          id: 'legit',
          sessionId: S,
          source: 'PRIVATE_UPLOAD',
          mimeType: 'image/jpeg',
          storageKey: OWNER_PHOTO_KEY,
        },
        ...attacks.map((storageKey, index) => ({
          id: `attack-${index}`,
          sessionId: S,
          source: 'PRIVATE_UPLOAD' as const,
          mimeType: 'image/jpeg',
          storageKey,
        })),
      ] as never);
      const subscriptions = mock<SubscriptionAccessService>();
      subscriptions.getStatus.mockResolvedValue(SUBSCRIPTION_STATUS);
      const images = new PrivateImageStorageService();
      // Records every storage read while keeping the real implementation.
      const readSpy = jest.spyOn(images, 'read');
      const collector = new PrivacyExportCollectorService(
        prisma,
        subscriptions,
      );
      const service = new PrivacyExportArchiveService(
        collector,
        images,
        new PrivacyExportStorageService(),
      );

      const snapshot = await collector.collect(A, EXPORT_ID);
      const result = await service.build(A, EXPORT_ID, () => Promise.resolve());

      // Only the owner's canonical keys are ever opened.
      const reads = readSpy.mock.calls.map(([key]) => key);
      expect(reads.sort()).toEqual([OWNER_AVATAR_KEY, OWNER_PHOTO_KEY].sort());
      expect(snapshot.photos.map((photo) => photo.storageKey).sort()).toEqual(
        [OWNER_AVATAR_KEY, OWNER_PHOTO_KEY].sort(),
      );
      expect(
        snapshot.unavailablePhotos
          .filter((photo) => photo.imageId?.startsWith('attack-'))
          .map((photo) => photo.reason),
      ).toEqual(
        // External URLs are never read at all; everything else is refused
        // by the ownership check.
        attacks.map((key) =>
          key.includes('://') ? 'NOT_STORED' : 'UNAVAILABLE',
        ),
      );

      const archive = await readFile(join(root, 'exports', result.storageKey));
      const zip = await readZip(archive);
      expect(archive.includes(PHOTO_BYTES.other)).toBe(false);
      expect(
        zip.names.filter((name) => name.startsWith('photos/')).sort(),
      ).toEqual(
        ['photos/profile/avatar.png', `photos/sessions/${S}/legit.jpg`].sort(),
      );
      const text = Buffer.concat([...zip.files.values()]).toString('utf8');
      for (const key of attacks) expect(text).not.toContain(key);
      expect(text).not.toContain(B);
    });
  });
});
