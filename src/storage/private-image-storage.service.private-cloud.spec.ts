import { mock } from 'jest-mock-extended';
import type { Logger } from 'winston';
import { PrivateImageStorageService } from './private-image-storage.service';
import type { PrivateObjectStorageProvider } from './private-object-storage.provider';
import type { PrivateStorageConfig } from './private-storage.config';
import { PrivateStorageError } from './private-storage.error';

const AUTH_ID = '5f0c8a3e-2b4d-4c6e-8f10-123456789abc';
const SESSION_ID = '9a8b7c6d-5e4f-4a3b-8c2d-0123456789ab';
const KEY = `${AUTH_ID}/${SESSION_ID}/0b7c9a52-8d2f-4d57-9a8c-0d8c1f0a1b2c.jpg`;
const KEY_PATTERN = new RegExp(
  `^${AUTH_ID}/${SESSION_ID}/[0-9a-f-]{36}\\.jpg$`,
);

function provider(id: string) {
  const instance = mock<PrivateObjectStorageProvider>();
  Object.defineProperty(instance, 'id', { value: id });
  return instance;
}

function config(activeProvider: string): PrivateStorageConfig {
  return { activeProvider, localRoot: '/unused' };
}

describe('PrivateImageStorageService (private cloud storage)', () => {
  const supabase = provider('supabase');
  const local = provider('local');
  const logger = mock<Logger>();
  let storage: PrivateImageStorageService;

  beforeEach(() => {
    jest.resetAllMocks();
    storage = new PrivateImageStorageService(
      [supabase, local],
      config('supabase'),
      logger,
    );
  });
  afterEach(() => jest.restoreAllMocks());

  describe('createRef and put', () => {
    it('allocates keys on the active provider without any I/O', () => {
      const ref = storage.createRef(AUTH_ID, SESSION_ID, 'image/jpeg');
      const again = storage.createRef(AUTH_ID, SESSION_ID, 'image/jpeg');

      expect(ref.provider).toBe('supabase');
      expect(ref.key).toMatch(KEY_PATTERN);
      expect(again.key).not.toBe(ref.key);
      expect(supabase.put.mock.calls).toHaveLength(0);
      expect(storage.activeProviderId).toBe('supabase');
    });

    it('uses the extension matching the validated MIME type', () => {
      expect(storage.createRef(AUTH_ID, 'profile', 'image/png').key).toMatch(
        /^[^/]+\/profile\/[0-9a-f-]{36}\.png$/,
      );
      expect(storage.createRef(AUTH_ID, 'profile', 'image/webp').key).toMatch(
        /\.webp$/,
      );
    });

    it.each(['..', '../other-user', 'a/b', '', 'session id', 'x'.repeat(129)])(
      'rejects an unsafe scope segment %p',
      (scope) => {
        let error: unknown;
        try {
          storage.createRef(AUTH_ID, scope, 'image/jpeg');
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(PrivateStorageError);
        expect((error as PrivateStorageError).code).toBe('INVALID_STORAGE_KEY');
      },
    );

    it('writes to the provider named in the reference', async () => {
      const bytes = Buffer.from('jpeg-bytes');
      const ref = storage.createRef(AUTH_ID, SESSION_ID, 'image/jpeg');

      await storage.put(ref, bytes, 'image/jpeg');

      expect(supabase.put.mock.calls).toEqual([[ref.key, bytes, 'image/jpeg']]);
      expect(local.put.mock.calls).toHaveLength(0);
    });

    it('can switch the active provider through configuration alone', () => {
      const localFirst = new PrivateImageStorageService(
        [supabase, local],
        config('local'),
        logger,
      );

      expect(
        localFirst.createRef(AUTH_ID, SESSION_ID, 'image/jpeg').provider,
      ).toBe('local');
    });

    it('annotates provider errors with context and logs them without keys or bytes', async () => {
      supabase.put.mockRejectedValue(
        new PrivateStorageError('STORAGE_UNAVAILABLE', { httpStatus: 503 }),
      );

      const error = await storage
        .put(
          { provider: 'supabase', key: KEY },
          Buffer.from('secret-bytes'),
          'image/jpeg',
        )
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: 'STORAGE_UNAVAILABLE',
        provider: 'supabase',
        operation: 'put',
        retryable: true,
        httpStatus: 503,
      });
      expect(logger.error.mock.calls).toContainEqual([
        'Private image storage operation failed',
        {
          context: 'PrivateImageStorageService',
          provider: 'supabase',
          operation: 'put',
          code: 'STORAGE_UNAVAILABLE',
          httpStatus: 503,
          retryable: true,
        },
      ]);
      const logged = JSON.stringify(logger.error.mock.calls);
      expect(logged).not.toContain(AUTH_ID);
      expect(logged).not.toContain('secret-bytes');
    });

    it('wraps unexpected provider exceptions in a safe retryable error', async () => {
      supabase.put.mockRejectedValue(
        new Error('socket hang up at https://x.supabase.co key sb_secret_x'),
      );

      const error = (await storage
        .put({ provider: 'supabase', key: KEY }, Buffer.from('x'), 'image/jpeg')
        .catch((caught: unknown) => caught)) as PrivateStorageError;

      expect(error).toBeInstanceOf(PrivateStorageError);
      expect(error.code).toBe('STORAGE_UNAVAILABLE');
      expect(error.message).toBe(
        'Private image storage is temporarily unavailable',
      );
      expect(error.cause).toBeInstanceOf(Error);
    });
  });

  describe('read and delete', () => {
    it('routes each record to the provider that stored it', async () => {
      supabase.get.mockResolvedValue(Buffer.from('cloud'));
      local.get.mockResolvedValue(Buffer.from('legacy'));

      await expect(
        storage.read({ provider: 'supabase', key: KEY }),
      ).resolves.toEqual(Buffer.from('cloud'));
      await expect(
        storage.read({ provider: 'local', key: KEY }),
      ).resolves.toEqual(Buffer.from('legacy'));
      await storage.delete({ provider: 'local', key: KEY });

      expect(supabase.get.mock.calls).toEqual([[KEY]]);
      expect(local.get.mock.calls).toEqual([[KEY]]);
      expect(local.delete.mock.calls).toEqual([[KEY]]);
      expect(supabase.delete.mock.calls).toHaveLength(0);
    });

    it('fails safely for records naming an unregistered provider', async () => {
      await expect(
        storage.read({ provider: 'retired-s3', key: KEY }),
      ).rejects.toMatchObject({
        code: 'UNKNOWN_STORAGE_PROVIDER',
        provider: 'retired-s3',
        operation: 'get',
        retryable: false,
      });
    });

    it.each([
      '../../etc/passwd.jpg',
      `${AUTH_ID}/../other/x.jpg`,
      '/absolute/path.jpg',
      'https://images.example.com/avatar.jpg',
      `${AUTH_ID}\\${SESSION_ID}\\x.jpg`,
      `${AUTH_ID}//x.jpg`,
      `${AUTH_ID}/${SESSION_ID}/no-extension`,
      `${AUTH_ID}/${SESSION_ID}/script.svg`,
      'x.jpg',
    ])('rejects the unsafe key %p without calling a provider', async (bad) => {
      const ref = { provider: 'supabase', key: bad };
      await expect(storage.read(ref)).rejects.toMatchObject({
        code: 'INVALID_STORAGE_KEY',
      });
      await expect(storage.delete(ref)).rejects.toMatchObject({
        code: 'INVALID_STORAGE_KEY',
      });
      await expect(storage.createSignedUrl(ref, 60)).rejects.toMatchObject({
        code: 'INVALID_STORAGE_KEY',
      });
      expect(supabase.get.mock.calls).toHaveLength(0);
      expect(supabase.delete.mock.calls).toHaveLength(0);
      expect(supabase.createSignedUrl.mock.calls).toHaveLength(0);
    });

    it('logs a missing object as a warning rather than an error', async () => {
      supabase.get.mockRejectedValue(
        new PrivateStorageError('OBJECT_NOT_FOUND'),
      );

      await expect(
        storage.read({ provider: 'supabase', key: KEY }),
      ).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND', operation: 'get' });
      expect(logger.warn.mock.calls).toContainEqual([
        'Private image object is missing',
        expect.objectContaining({ code: 'OBJECT_NOT_FOUND' }),
      ]);
      expect(logger.error.mock.calls).toHaveLength(0);
    });
  });

  describe('createSignedUrl', () => {
    const SIGNED = `https://project.supabase.co/storage/v1/object/sign/bucket/${KEY}?token=abc`;

    const grant = (issuedAtMs: number, lifetimeMs: number) => ({
      url: SIGNED,
      issuedAt: new Date(issuedAtMs),
      expiresAt: new Date(issuedAtMs + lifetimeMs),
    });

    it("reports the provider's own expiry, never a locally computed one", async () => {
      const now = jest.spyOn(Date, 'now');
      // Provider clock 10 minutes ahead of ours, and it signed 3 s later.
      const providerIssuedAt = Date.parse('2026-11-12T12:10:03.000Z');
      supabase.createSignedUrl.mockResolvedValue(
        grant(providerIssuedAt, 60_000),
      );
      now.mockClear();

      await expect(
        storage.createSignedUrl({ provider: 'supabase', key: KEY }, 60),
      ).resolves.toEqual({
        url: SIGNED,
        expiresAt: new Date('2026-11-12T12:11:03.000Z'),
        expiresInSeconds: 60,
      });
      expect(now).not.toHaveBeenCalled();
      expect(supabase.createSignedUrl.mock.calls).toEqual([[KEY, 60]]);
      expect(local.createSignedUrl.mock.calls).toHaveLength(0);
    });

    it('reports a shorter provider lifetime as it is, keeping both fields consistent', async () => {
      supabase.createSignedUrl.mockResolvedValue(grant(5_000_000, 30_000));

      const signed = await storage.createSignedUrl(
        { provider: 'supabase', key: KEY },
        60,
      );

      expect(signed.expiresInSeconds).toBe(30);
      expect(signed.expiresAt).toEqual(new Date(5_030_000));
    });

    it.each([
      ['longer than requested', grant(0, 61_000)],
      ['far longer than requested', grant(0, 3_600_000)],
      ['not a whole number of seconds', grant(0, 59_500)],
      ['zero', grant(0, 0)],
      ['negative (expires before it was issued)', grant(10_000, -1_000)],
      ['missing a URL', { ...grant(0, 60_000), url: '' }],
    ])(
      'rejects any provider grant whose lifetime is %s',
      async (_label, signed) => {
        supabase.createSignedUrl.mockResolvedValue(signed);

        await expect(
          storage.createSignedUrl({ provider: 'supabase', key: KEY }, 60),
        ).rejects.toMatchObject({
          code: 'INVALID_PROVIDER_RESPONSE',
          provider: 'supabase',
          operation: 'sign',
        });
      },
    );

    it.each([0, 61, 3600, 1.5])(
      'refuses a lifetime of %p seconds',
      async (ttl) => {
        await expect(
          storage.createSignedUrl({ provider: 'supabase', key: KEY }, ttl),
        ).rejects.toThrow(RangeError);
        expect(supabase.createSignedUrl.mock.calls).toHaveLength(0);
      },
    );

    it('never logs the signed URL when signing fails', async () => {
      supabase.createSignedUrl.mockRejectedValue(
        new PrivateStorageError('INVALID_PROVIDER_RESPONSE'),
      );

      await expect(
        storage.createSignedUrl({ provider: 'supabase', key: KEY }, 60),
      ).rejects.toMatchObject({
        code: 'INVALID_PROVIDER_RESPONSE',
        operation: 'sign',
      });
      const logged = JSON.stringify(logger.error.mock.calls);
      expect(logged).not.toContain('token');
      expect(logged).not.toContain(KEY);
    });
  });

  describe('registry validation', () => {
    it('refuses to start when the active provider is not registered', () => {
      expect(
        () =>
          new PrivateImageStorageService([local], config('supabase'), logger),
      ).toThrow('Private storage provider "supabase" is not registered');
    });

    it('refuses duplicate provider ids', () => {
      expect(
        () =>
          new PrivateImageStorageService(
            [supabase, provider('supabase')],
            config('supabase'),
            logger,
          ),
      ).toThrow('Duplicate private storage provider id "supabase"');
    });
  });
});
