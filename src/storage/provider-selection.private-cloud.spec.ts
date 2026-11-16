import { ConfigService } from '@nestjs/config';
import { mock, mockDeep } from 'jest-mock-extended';
import type { Logger } from 'winston';
import { FakeS3CompatibleStorage } from '../../test/support/fake-s3-compatible-storage';
import {
  FAKE_SUPABASE,
  FakeSupabaseStorage,
} from '../../test/support/fake-supabase-storage';
import { PrismaService } from '../common/services/prisma.service';
import { PrivateImageLifecycleService } from './private-image-lifecycle.service';
import { PrivateImageStorageService } from './private-image-storage.service';
import type { PrivateObjectStorageProvider } from './private-object-storage.provider';
import { PrivateStorageError } from './private-storage.error';
import { SupabaseStorageProvider } from './providers/supabase-storage.provider';

const AUTH_ID = '5f0c8a3e-2b4d-4c6e-8f10-123456789abc';
const SESSION_ID = '9a8b7c6d-5e4f-4a3b-8c2d-0123456789ab';
const BYTES = Buffer.from('image-bytes');

describe('Storage provider selection (private cloud storage)', () => {
  const logger = mock<Logger>();
  let supabaseApi: FakeSupabaseStorage;
  let supabase: SupabaseStorageProvider;
  let s3: FakeS3CompatibleStorage;

  const facade = (
    activeProvider: string,
    providers: PrivateObjectStorageProvider[] = [supabase, s3],
  ) =>
    new PrivateImageStorageService(
      providers,
      { activeProvider, localRoot: '/unused' },
      logger,
    );

  async function upload(storage: PrivateImageStorageService) {
    const ref = storage.createRef(AUTH_ID, SESSION_ID, 'image/jpeg');
    await storage.put(ref, BYTES, 'image/jpeg');
    return ref;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    supabaseApi = new FakeSupabaseStorage();
    supabase = new SupabaseStorageProvider(
      {
        storageUrl: FAKE_SUPABASE.url,
        serviceKey: FAKE_SUPABASE.serviceKey,
        bucket: FAKE_SUPABASE.bucket,
        timeoutMs: 1_000,
      },
      supabaseApi.fetch,
    );
    s3 = new FakeS3CompatibleStorage();
  });

  describe('new uploads use the configured provider', () => {
    it.each([
      ['supabase', () => supabaseApi.objects.size, () => s3.objects.size],
      ['fake-s3', () => s3.objects.size, () => supabaseApi.objects.size],
    ])('writes to %s only', async (active, inActive, inOther) => {
      const ref = await upload(facade(active));

      expect(ref.provider).toBe(active);
      expect(inActive()).toBe(1);
      expect(inOther()).toBe(0);
    });
  });

  describe('existing images follow their own provider after the default changes', () => {
    it('reads, signs and deletes Supabase images while S3 is the default, and vice versa', async () => {
      const fromSupabase = await upload(facade('supabase'));
      const fromS3 = await upload(facade('fake-s3'));

      for (const active of ['supabase', 'fake-s3']) {
        const storage = facade(active);
        await expect(storage.read(fromSupabase)).resolves.toEqual(BYTES);
        await expect(storage.read(fromS3)).resolves.toEqual(BYTES);
      }

      const storage = facade('fake-s3');
      const supabaseUrl = await storage.createSignedUrl(fromSupabase, 60);
      const s3Url = await storage.createSignedUrl(fromS3, 60);
      expect(supabaseUrl.url.startsWith(FAKE_SUPABASE.url)).toBe(true);
      expect(s3Url.url.startsWith(s3.endpoint)).toBe(true);
      expect(s3Url.expiresInSeconds).toBe(60);
      expect(s3.download(s3Url.url)).toEqual({ status: 200, bytes: BYTES });

      await storage.delete(fromSupabase);
      await storage.delete(fromS3);
      expect(supabaseApi.objects.size).toBe(0);
      expect(s3.objects.size).toBe(0);
    });

    it("reports each provider's own expiry, even when their clocks differ", async () => {
      const storage = facade('fake-s3');
      const ref = await upload(storage);
      s3.clockOffsetMs = -7 * 60_000;

      const signed = await storage.createSignedUrl(ref, 60);

      expect(signed.expiresInSeconds).toBe(60);
      const amzDate = new URL(signed.url).searchParams.get('X-Amz-Date');
      const issuedAt = Date.parse(
        (amzDate as string).replace(
          /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
          '$1-$2-$3T$4:$5:$6Z',
        ),
      );
      expect(signed.expiresAt.getTime()).toBe(issuedAt + 60_000);
      expect(signed.expiresAt.getTime()).toBeLessThan(Date.now());
    });
  });

  describe('missing providers', () => {
    it('fails every operation on an image whose provider is no longer registered, without touching others', async () => {
      const ref = await upload(facade('fake-s3'));
      const withoutS3 = facade('supabase', [supabase]);
      const requestsBefore = supabaseApi.requests.length;

      for (const operation of [
        () => withoutS3.read(ref),
        () => withoutS3.delete(ref),
        () => withoutS3.createSignedUrl(ref, 60),
        () => withoutS3.put(ref, BYTES, 'image/jpeg'),
      ]) {
        await expect(operation()).rejects.toMatchObject({
          code: 'UNKNOWN_STORAGE_PROVIDER',
          provider: 'fake-s3',
          retryable: false,
        });
      }
      expect(withoutS3.isAvailable('fake-s3')).toBe(false);
      expect(supabaseApi.requests).toHaveLength(requestsBefore);
      expect(s3.objects.size).toBe(1);
    });

    it('treats a registered but unconfigured provider as unavailable', async () => {
      const unconfiguredS3 = new FakeS3CompatibleStorage(
        'fake-s3',
        undefined,
        undefined,
        false,
      );
      const unconfiguredSupabase = new SupabaseStorageProvider(undefined);
      const storage = facade('supabase', [supabase, unconfiguredS3]);

      expect(storage.isAvailable('supabase')).toBe(true);
      expect(storage.isAvailable('fake-s3')).toBe(false);
      expect(
        facade('supabase', [unconfiguredSupabase]).isAvailable('supabase'),
      ).toBe(false);
      await expect(
        storage.read({ provider: 'fake-s3', key: `${AUTH_ID}/s/x.jpg` }),
      ).rejects.toMatchObject({ code: 'STORAGE_MISCONFIGURED' });
    });

    it.each([
      [
        'an unregistered default provider',
        's3',
        () => [supabase],
        'is not registered',
      ],
      [
        'an invalid provider id',
        'supabase',
        () => [supabase, new FakeS3CompatibleStorage('S3 Backup')],
        'Invalid private storage provider id',
      ],
      [
        'an id too long to store',
        'supabase',
        () => [supabase, new FakeS3CompatibleStorage('x'.repeat(33))],
        'Invalid private storage provider id',
      ],
      [
        'duplicate ids',
        'supabase',
        () => [supabase, new FakeS3CompatibleStorage('supabase')],
        'Duplicate private storage provider id',
      ],
    ])('refuses to start with %s', (_label, active, providers, message) => {
      expect(() => facade(active, providers())).toThrow(message);
    });

    it('lists every registered provider', () => {
      expect(facade('supabase').registeredProviderIds).toEqual([
        'supabase',
        'fake-s3',
      ]);
    });
  });

  describe('failures of the second provider', () => {
    it.each([
      ['put', 'STORAGE_UNAVAILABLE', true],
      ['get', 'STORAGE_TIMEOUT', true],
      ['delete', 'STORAGE_ACCESS_DENIED', false],
      ['sign', 'STORAGE_UNAVAILABLE', true],
    ] as const)(
      'surfaces a %s failure (%s) with provider context and safe logs',
      async (op, code, retryable) => {
        const storage = facade('fake-s3');
        const ref =
          op === 'put'
            ? storage.createRef(AUTH_ID, SESSION_ID, 'image/jpeg')
            : await upload(storage);
        s3.failNext(op, code);

        const error = (await (
          op === 'put'
            ? storage.put(ref, BYTES, 'image/jpeg')
            : op === 'get'
              ? storage.read(ref)
              : op === 'delete'
                ? storage.delete(ref)
                : storage.createSignedUrl(ref, 60)
        ).catch((caught: unknown) => caught)) as PrivateStorageError;

        expect(error).toBeInstanceOf(PrivateStorageError);
        expect(error).toMatchObject({
          code,
          retryable,
          provider: 'fake-s3',
          operation: op,
        });
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain(ref.key);
      },
    );
  });
});

describe('Referenced-provider audit at startup (private cloud storage)', () => {
  it('reports every referenced provider that is unregistered or unconfigured', async () => {
    const prisma = mockDeep<PrismaService>();
    const logger = mock<Logger>();
    const storage = mock<PrivateImageStorageService>();
    storage.isAvailable.mockImplementation(
      (provider) => provider === 'supabase',
    );
    prisma.$queryRaw.mockResolvedValue([
      { provider: 'supabase' },
      { provider: 'retired-s3' },
      { provider: 'fake-s3' },
    ]);
    const lifecycle = new PrivateImageLifecycleService(
      prisma,
      storage,
      new ConfigService({ NODE_ENV: 'test' }),
      logger,
    );

    await expect(lifecycle.auditReferencedProviders()).resolves.toEqual([
      'fake-s3',
      'retired-s3',
    ]);
    expect(
      logger.error.mock.calls.map((call) => (call as unknown[])[1]),
    ).toEqual([
      expect.objectContaining({ provider: 'fake-s3' }),
      expect.objectContaining({ provider: 'retired-s3' }),
    ]);
  });

  it('never blocks startup when the audit cannot run', async () => {
    const prisma = mockDeep<PrismaService>();
    const logger = mock<Logger>();
    prisma.$queryRaw.mockRejectedValue(new Error('database down'));
    const lifecycle = new PrivateImageLifecycleService(
      prisma,
      mock<PrivateImageStorageService>(),
      new ConfigService({ NODE_ENV: 'test' }),
      logger,
    );

    await expect(lifecycle.auditReferencedProviders()).resolves.toEqual([]);
    expect(logger.warn.mock.calls).toHaveLength(1);
  });
});
