import { mock, mockDeep } from 'jest-mock-extended';
import type { Logger } from 'winston';
import { PrismaService } from '../common/services/prisma.service';
import type { AuthService } from '../auth/auth.service';
import type { AccountDeletionCodeService } from '../privacy/account-deletion/account-deletion-code.service';
import { AccountErasureService } from '../privacy/account-deletion/account-erasure.service';
import { PrivacyExportStorageService } from './privacy-export-storage.service';
import { PrivateImageStorageService } from './private-image-storage.service';
import { SupabaseStorageProvider } from './providers/supabase-storage.provider';
import { FakeS3CompatibleStorage } from '../../test/support/fake-s3-compatible-storage';
import {
  FakeSupabaseStorage,
  FAKE_SUPABASE,
  unavailable,
} from '../../test/support/fake-supabase-storage';

const OWNER = 'owner';
const KEY = OWNER + '/profile/avatar.jpg';

describe('Merged privacy and cloud storage', () => {
  const logger = mock<Logger>();
  let api: FakeSupabaseStorage;
  let other: FakeS3CompatibleStorage;
  let storage: PrivateImageStorageService;
  beforeEach(() => {
    api = new FakeSupabaseStorage();
    other = new FakeS3CompatibleStorage();
    storage = new PrivateImageStorageService(
      [
        new SupabaseStorageProvider(
          {
            storageUrl: FAKE_SUPABASE.url,
            serviceKey: FAKE_SUPABASE.serviceKey,
            bucket: FAKE_SUPABASE.bucket,
            timeoutMs: 1000,
          },
          api.fetch,
        ),
        other,
      ],
      { activeProvider: 'supabase', localRoot: '/unused' },
      logger,
    );
  });
  it('enumerates only owned objects, through nested folders and paginated responses', async () => {
    for (let i = 0; i < 105; i++)
      api.objects.set(OWNER + '/session/photo-' + i + '.jpg', {
        bytes: Buffer.from('photo'),
        contentType: 'image/jpeg',
      });
    api.objects.set('another/profile/avatar.jpg', {
      bytes: Buffer.from('other'),
      contentType: 'image/jpeg',
    });
    const files = await storage.listOwnerFiles(OWNER, 'supabase');
    expect(files).toHaveLength(105);
    expect(files.every((key) => key.startsWith(OWNER + '/'))).toBe(true);
    expect(api.count('list')).toBeGreaterThan(2);
  });
  it('deletes from the recorded provider without touching an identical key elsewhere', async () => {
    api.objects.set(KEY, {
      bytes: Buffer.from('a'),
      contentType: 'image/jpeg',
    });
    await other.put(KEY, Buffer.from('b'), 'image/jpeg');
    await storage.deleteOwnerFile(OWNER, KEY, 'supabase');
    expect(api.objects.has(KEY)).toBe(false);
    await expect(other.get(KEY)).resolves.toEqual(Buffer.from('b'));
    await expect(
      storage.deleteOwnerFile(OWNER, 'another/profile/a.jpg', 'supabase'),
    ).rejects.toThrow();
  });
  it('reports enumeration failures rather than claiming an owner has no files', async () => {
    api.failNext('list', unavailable);
    await expect(
      storage.listOwnerFiles(OWNER, 'supabase'),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });
  it('records the provider separately on cloud photo and avatar erasure references', async () => {
    const prisma = mockDeep<PrismaService>();
    prisma.imageAsset.findMany.mockResolvedValue([
      {
        sessionId: 'session',
        source: 'PRIVATE_UPLOAD',
        storageKey: OWNER + '/session/a.jpg',
        storageProvider: 'fake-s3',
      },
    ] as never);
    prisma.userProfile.findUnique.mockResolvedValue({
      avatarUrl: KEY,
      avatarStorageProvider: 'supabase',
    } as never);
    prisma.dataExport.findMany.mockResolvedValue([]);
    const service = new AccountErasureService(
      prisma,
      mock<AuthService>(),
      mock<AccountDeletionCodeService>(),
      storage,
      mock<PrivacyExportStorageService>(),
      logger,
    );
    const inspect = service as unknown as {
      collectFiles(
        tx: PrismaService,
        owner: string,
      ): Promise<
        Array<{ kind: string; storageKey: string; storageProvider?: string }>
      >;
    };
    const files = await inspect.collectFiles(prisma, OWNER);
    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'PRIVATE_IMAGE',
          storageKey: KEY,
          storageProvider: 'supabase',
        }),
        expect.objectContaining({
          kind: 'PRIVATE_IMAGE',
          storageKey: OWNER + '/session/a.jpg',
          storageProvider: 'fake-s3',
        }),
        expect.objectContaining({
          kind: 'IMAGE_OWNER_DIRECTORY',
          storageProvider: 'fake-s3',
        }),
        expect.objectContaining({
          kind: 'IMAGE_OWNER_DIRECTORY',
          storageProvider: 'supabase',
        }),
      ]),
    );
  });
});
