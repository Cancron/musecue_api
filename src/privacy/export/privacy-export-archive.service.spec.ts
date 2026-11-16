import { FakeS3CompatibleStorage } from '../../../test/support/fake-s3-compatible-storage';
import type { Logger } from 'winston';
import { PrivateImageStorageService } from '../../storage/private-image-storage.service';
import { localImageStorage } from '../../../test/support/local-image-storage';
import { mock } from 'jest-mock-extended';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  EXPORT_ID,
  FORBIDDEN_VALUES,
  IMAGE_FOREIGN_KEY,
  IMAGE_MISSING_FILE,
  IMAGE_MOCK_CAPTURE,
  IMAGE_UPLOADED,
  OTHER_ID,
  OTHER_PHOTO_KEY,
  OWNER_AVATAR_KEY,
  OWNER_ID,
  OWNER_PHOTO_KEY,
  PHOTO_BYTES,
  SESSION_ID,
  SUBSCRIPTION_STATUS,
  privacyPrismaFake,
  type PrivacyPrismaFake,
} from '../../../test/support/privacy-fixtures';
import { readZip, type ZipContents } from '../../../test/support/read-zip';
import { PrivacyExportStorageService } from '../../storage/privacy-export-storage.service';
import type { SubscriptionAccessService } from '../../subscription/subscription-access.service';
import { PrivacyExportArchiveService } from './privacy-export-archive.service';
import { PrivacyExportCollectorService } from './privacy-export-collector.service';
import {
  PrivacyExportPermanentError,
  PrivacyExportSupersededError,
} from './privacy-export.errors';

interface Manifest {
  formatVersion: number;
  exportId: string;
  accountId: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  photos: {
    included: number;
    unavailable: Array<{ imageId: string | null; reason: string }>;
  };
}

const anyString: unknown = expect.any(String);
const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

describe('PrivacyExportArchiveService (privacy ZIP archive)', () => {
  let root: string;
  let imageRoot: string;
  let exportRoot: string;
  let prisma: PrivacyPrismaFake;
  let subscriptions: ReturnType<typeof mock<SubscriptionAccessService>>;
  let service: PrivacyExportArchiveService;
  const env = {
    images: process.env.PRIVATE_UPLOAD_DIR,
    exports: process.env.PRIVATE_EXPORT_DIR,
  };

  const putImage = async (key: string, bytes: Buffer) => {
    await mkdir(dirname(join(imageRoot, key)), { recursive: true });
    await writeFile(join(imageRoot, key), bytes);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'privacy-archive-'));
    imageRoot = join(root, 'images');
    exportRoot = join(root, 'exports');
    process.env.PRIVATE_UPLOAD_DIR = imageRoot;
    process.env.PRIVATE_EXPORT_DIR = exportRoot;
    await putImage(OWNER_AVATAR_KEY, PHOTO_BYTES.avatar);
    await putImage(OWNER_PHOTO_KEY, PHOTO_BYTES.uploaded);
    await putImage(OTHER_PHOTO_KEY, PHOTO_BYTES.other);

    prisma = privacyPrismaFake();
    subscriptions = mock<SubscriptionAccessService>();
    subscriptions.getStatus.mockResolvedValue(SUBSCRIPTION_STATUS);
    service = new PrivacyExportArchiveService(
      new PrivacyExportCollectorService(prisma, subscriptions),
      localImageStorage(),
      new PrivacyExportStorageService(),
    );
  });

  afterEach(async () => {
    for (const [key, value] of [
      ['PRIVATE_UPLOAD_DIR', env.images],
      ['PRIVATE_EXPORT_DIR', env.exports],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await chmod(join(imageRoot, OWNER_PHOTO_KEY), 0o600).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const build = async (
    onProgress: (progress: number) => Promise<void> = () => Promise.resolve(),
  ) => {
    const result = await service.build(OWNER_ID, EXPORT_ID, onProgress);
    const bytes = await readFile(join(exportRoot, result.storageKey));
    return { result, bytes, zip: await readZip(bytes) };
  };
  const json = <T>(zip: ZipContents, path: string): T =>
    JSON.parse(zip.files.get(path)!.toString('utf8')) as T;

  it('stores the archive in the owner-scoped private export root', async () => {
    const { result, bytes } = await build();

    expect(result.storageKey).toMatch(
      new RegExp(`^${OWNER_ID}/${EXPORT_ID}/[0-9a-f-]{36}\\.zip$`),
    );
    expect(result.sizeBytes).toBe(bytes.length);
    expect(result.sha256).toBe(sha256(bytes));
  });

  it('contains structured data files, owned photos, a README and a manifest', async () => {
    const { zip, result } = await build();

    expect([...zip.names].sort()).toEqual(
      [
        'README.txt',
        'data/account.json',
        'data/email-history.json',
        'data/makeup-history.json',
        'data/profile.json',
        'data/sign-in-history.json',
        'data/subscription.json',
        'manifest.json',
        'photos/profile/avatar.png',
        `photos/sessions/${SESSION_ID}/${IMAGE_UPLOADED}.jpg`,
      ].sort(),
    );
    expect(zip.files.get('photos/profile/avatar.png')).toEqual(
      PHOTO_BYTES.avatar,
    );
    expect(
      zip.files.get(`photos/sessions/${SESSION_ID}/${IMAGE_UPLOADED}.jpg`),
    ).toEqual(PHOTO_BYTES.uploaded);
    // Photos are already compressed and stored as-is; JSON is deflated.
    expect(zip.methods.get('photos/profile/avatar.png')).toBe(0);
    expect(zip.methods.get('data/makeup-history.json')).toBe(8);
    expect(result.photoCount).toBe(2);
  });

  it('exports the owner account, profile, history and subscription data', async () => {
    const { zip } = await build();

    const account = json<{
      account: Record<string, unknown>;
      security: Record<string, unknown>;
    }>(zip, 'data/account.json');
    expect(account.account).toEqual({
      id: OWNER_ID,
      email: 'owner@example.com',
      username: 'owner',
      role: 'USER',
      verified: true,
      status: 'ACTIVE',
      provider: 'google',
      createdAt: anyString,
      updatedAt: anyString,
    });
    expect(account.security).toEqual({
      mfaEnabled: true,
      mfaMethod: 'totp',
      lastPasswordChange: anyString,
    });

    const adaProfile: unknown = expect.objectContaining({
      firstName: 'Ada',
      bio: 'Loves soft glam',
    });
    expect(json(zip, 'data/profile.json')).toEqual({
      profile: adaProfile,
      avatar: { file: 'photos/profile/avatar.png', externalUrl: null },
    });

    const history = json<{
      sessions: Array<{
        id: string;
        preferences: { notes: string };
        images: Array<{ id: string; file: string | null }>;
        guide: { steps: Array<{ questions: unknown[]; attempts: unknown[] }> };
      }>;
      aiProcessing: Array<Record<string, unknown>>;
    }>(zip, 'data/makeup-history.json');
    expect(history.sessions.map((session) => session.id)).toEqual([SESSION_ID]);
    expect(history.sessions[0].preferences.notes).toBe('Sensitive eyes');
    expect(history.sessions[0].guide.steps[0].questions).toHaveLength(1);
    expect(history.sessions[0].guide.steps[0].attempts).toHaveLength(1);
    // Documents only reference files that are actually in the archive.
    expect(
      Object.fromEntries(
        history.sessions[0].images.map((image) => [image.id, image.file]),
      ),
    ).toEqual({
      [IMAGE_UPLOADED]: `photos/sessions/${SESSION_ID}/${IMAGE_UPLOADED}.jpg`,
      [IMAGE_MISSING_FILE]: null,
      [IMAGE_MOCK_CAPTURE]: null,
      [IMAGE_FOREIGN_KEY]: null,
    });
    expect(history.aiProcessing).toEqual([
      expect.objectContaining({
        operation: 'PERSONALIZATION',
        model: 'test-model',
      }),
    ]);
    expect(Object.keys(history.aiProcessing[0])).not.toContain('result');

    const subscription = json<Record<string, unknown>>(
      zip,
      'data/subscription.json',
    );
    expect(subscription.currentStatus).toEqual(SUBSCRIPTION_STATUS);
    expect(subscription.record).toEqual(
      expect.objectContaining({ status: 'PRO', billingInterval: 'MONTHLY' }),
    );
    expect(subscription.payments).toEqual([
      expect.objectContaining({ amountCents: 1900, status: 'SUCCEEDED' }),
    ]);
    expect(subscription.events).toEqual([
      expect.objectContaining({ type: 'CREATED' }),
    ]);

    expect(
      json<{ entries: Array<{ ipAddress: string }> }>(
        zip,
        'data/sign-in-history.json',
      ).entries.map((entry) => entry.ipAddress),
    ).toEqual(['203.0.113.10']);
    expect(
      json<{ entries: unknown[] }>(zip, 'data/email-history.json').entries,
    ).toHaveLength(1);
  });

  it('never contains credentials, internal references or another user’s data', async () => {
    const { zip, bytes } = await build();
    const everything = Buffer.concat([...zip.files.values()]).toString('utf8');

    for (const forbidden of FORBIDDEN_VALUES) {
      expect(everything).not.toContain(forbidden);
    }
    expect(everything).not.toContain(PHOTO_BYTES.other.toString('utf8'));
    expect(bytes.includes(PHOTO_BYTES.other)).toBe(false);
    for (const field of [
      '"password"',
      '"tokenVersion"',
      '"mfaSecret"',
      '"storageKey"',
      '"idempotencyKey"',
      '"providerId"',
    ]) {
      expect(everything).not.toContain(field);
    }
  });

  it('scopes every query to the owner', async () => {
    await build();

    expect(prisma.authUser.findUnique.mock.calls[0][0].where).toEqual({
      id: OWNER_ID,
    });
    for (const calls of [
      prisma.makeupSession.findMany.mock.calls,
      prisma.aiRun.findMany.mock.calls,
      prisma.loginHistory.findMany.mock.calls,
      prisma.emailHistory.findMany.mock.calls,
    ]) {
      expect(calls[0][0]?.where).toEqual({ authId: OWNER_ID });
    }
    expect(prisma.userSubscription.findUnique.mock.calls[0][0].where).toEqual({
      authId: OWNER_ID,
    });
    expect(prisma.imageAsset.findMany.mock.calls[0][0]?.where).toEqual({
      session: { authId: OWNER_ID },
    });
    expect(subscriptions.getStatus.mock.calls).toContainEqual([
      OWNER_ID,
      expect.any(Date),
    ]);
  });

  it('lists photos that could not be included and checksums every file', async () => {
    const { zip, result } = await build();
    const manifest = json<Manifest>(zip, 'manifest.json');

    expect(manifest).toMatchObject({
      formatVersion: 1,
      exportId: EXPORT_ID,
      accountId: OWNER_ID,
      photos: { included: 2 },
    });
    expect(
      Object.fromEntries(
        manifest.photos.unavailable.map((photo) => [
          photo.imageId,
          photo.reason,
        ]),
      ),
    ).toEqual({
      [IMAGE_MOCK_CAPTURE]: 'NOT_STORED',
      [IMAGE_FOREIGN_KEY]: 'UNAVAILABLE',
      [IMAGE_MISSING_FILE]: 'FILE_MISSING',
    });
    // Mock captures never had a file, so only the other two count as missing.
    expect(result.missingPhotoCount).toBe(2);

    const listed = manifest.files.map((file) => file.path).sort();
    expect(listed).toEqual(
      zip.names.filter((name) => name !== 'manifest.json').sort(),
    );
    for (const file of manifest.files) {
      const content = zip.files.get(file.path)!;
      expect(file.bytes).toBe(content.length);
      expect(file.sha256).toBe(sha256(content));
    }
  });

  it('reports monotonically increasing progress', async () => {
    const progress: number[] = [];
    await build((value) => {
      progress.push(value);
      return Promise.resolve();
    });

    expect(progress[0]).toBe(15);
    expect(progress.at(-1)).toBe(95);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  });

  it('does not export anything for an account that no longer exists', async () => {
    prisma.authUser.findUnique.mockResolvedValue(null);

    await expect(
      service.build(OTHER_ID.replace('b', 'c'), EXPORT_ID, () =>
        Promise.resolve(),
      ),
    ).rejects.toBeInstanceOf(PrivacyExportPermanentError);
    await expect(readdir(exportRoot)).rejects.toThrow();
  });

  it('removes the partial archive when reading a photo fails', async () => {
    await chmod(join(imageRoot, OWNER_PHOTO_KEY), 0o000);
    if (process.platform === 'win32' || process.getuid?.() === 0) return; // Windows chmod/root cannot simulate read denial

    await expect(build()).rejects.toMatchObject({
      code: 'STORAGE_MISCONFIGURED',
    });
    expect(await readdir(join(exportRoot, OWNER_ID))).toEqual([]);
  });

  it('exports cloud photos through their saved provider after the active provider changes', async () => {
    const saved = new FakeS3CompatibleStorage('previous-store');
    const active = new FakeS3CompatibleStorage('new-store');
    await saved.put(OWNER_PHOTO_KEY, PHOTO_BYTES.uploaded, 'image/jpeg');
    await saved.put(OWNER_AVATAR_KEY, PHOTO_BYTES.avatar, 'image/png');
    const collector = new PrivacyExportCollectorService(prisma, subscriptions);
    const snapshot = await collector.collect(OWNER_ID, EXPORT_ID);
    const collect = jest.spyOn(collector, 'collect').mockResolvedValue({
      ...snapshot,
      photos: snapshot.photos.map((photo) => ({
        ...photo,
        storageProvider: 'previous-store',
      })),
    });
    const storage = new PrivateImageStorageService(
      [saved, active],
      { activeProvider: 'new-store', localRoot: imageRoot },
      mock<Logger>(),
    );
    const cloudArchive = new PrivacyExportArchiveService(
      collector,
      storage,
      new PrivacyExportStorageService(),
    );
    const result = await cloudArchive.build(OWNER_ID, EXPORT_ID, () =>
      Promise.resolve(),
    );
    expect(result.photoCount).toBe(2);
    expect(active.calls).toEqual([]);
    expect(
      saved.calls.filter((call) => call.op === 'get').map((call) => call.key),
    ).toEqual(expect.arrayContaining([OWNER_PHOTO_KEY, OWNER_AVATAR_KEY]));
    collect.mockRestore();
  });

  it('stops and removes the partial archive when the attempt is superseded', async () => {
    await expect(
      build((value) =>
        value > 15
          ? Promise.reject(new PrivacyExportSupersededError())
          : Promise.resolve(),
      ),
    ).rejects.toBeInstanceOf(PrivacyExportSupersededError);
    expect(await readdir(join(exportRoot, OWNER_ID))).toEqual([]);
  });
});
