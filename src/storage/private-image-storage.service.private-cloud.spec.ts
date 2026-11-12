import { mock } from 'jest-mock-extended';
import type { Logger } from 'winston';
import { PrivateImageStorageService } from './private-image-storage.service';
import type { PrivateObjectStorageProvider } from './private-object-storage.provider';
import type { PrivateStorageConfig } from './private-storage.config';
import { PrivateStorageError } from './private-storage.error';

const AUTH_ID = '5f0c8a3e-2b4d-4c6e-8f10-123456789abc';
const SESSION_ID = '9a8b7c6d-5e4f-4a3b-8c2d-0123456789ab';
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

  describe('save', () => {
    it('writes new images to the active provider and returns provider + key', async () => {
      const bytes = Buffer.from('jpeg-bytes');

      const ref = await storage.save(AUTH_ID, SESSION_ID, 'image/jpeg', bytes);

      expect(ref.provider).toBe('supabase');
      expect(ref.key).toMatch(KEY_PATTERN);
      expect(supabase.put.mock.calls).toEqual([[ref.key, bytes, 'image/jpeg']]);
      expect(local.put.mock.calls).toHaveLength(0);
      expect(storage.activeProviderId).toBe('supabase');
    });

    it('uses the extension matching the validated MIME type and unique keys', async () => {
      const png = await storage.save(
        AUTH_ID,
        'profile',
        'image/png',
        Buffer.from('p'),
      );
      const webp = await storage.save(
        AUTH_ID,
        'profile',
        'image/webp',
        Buffer.from('w'),
      );
      const again = await storage.save(
        AUTH_ID,
        'profile',
        'image/webp',
        Buffer.from('w'),
      );

      expect(png.key).toMatch(/^[^/]+\/profile\/[0-9a-f-]{36}\.png$/);
      expect(webp.key).toMatch(/\.webp$/);
      expect(again.key).not.toBe(webp.key);
    });

    it.each(['..', '../other-user', 'a/b', '', 'session id', 'x'.repeat(129)])(
      'rejects an unsafe scope segment %p before touching storage',
      async (scope) => {
        await expect(
          storage.save(AUTH_ID, scope, 'image/jpeg', Buffer.from('x')),
        ).rejects.toMatchObject({ code: 'INVALID_STORAGE_KEY' });
        expect(supabase.put.mock.calls).toHaveLength(0);
      },
    );

    it('annotates provider errors with context and logs them without keys or bytes', async () => {
      supabase.put.mockRejectedValue(
        new PrivateStorageError('STORAGE_UNAVAILABLE', { httpStatus: 503 }),
      );

      const error = await storage
        .save(AUTH_ID, SESSION_ID, 'image/jpeg', Buffer.from('secret-bytes'))
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
        new Error(
          'socket hang up at https://project.supabase.co with key sb_secret_x',
        ),
      );

      const error = (await storage
        .save(AUTH_ID, SESSION_ID, 'image/jpeg', Buffer.from('x'))
        .catch((caught: unknown) => caught)) as PrivateStorageError;

      expect(error).toBeInstanceOf(PrivateStorageError);
      expect(error.code).toBe('STORAGE_UNAVAILABLE');
      expect(error.message).toBe(
        'Private image storage is temporarily unavailable',
      );
      expect(error.cause).toBeInstanceOf(Error);
    });

    it('can switch the active provider through configuration alone', async () => {
      const localFirst = new PrivateImageStorageService(
        [supabase, local],
        config('local'),
        logger,
      );

      const ref = await localFirst.save(
        AUTH_ID,
        SESSION_ID,
        'image/jpeg',
        Buffer.from('x'),
      );

      expect(ref.provider).toBe('local');
      expect(local.put.mock.calls).toHaveLength(1);
      expect(supabase.put.mock.calls).toHaveLength(0);
    });
  });

  describe('read and delete', () => {
    const key = `${AUTH_ID}/${SESSION_ID}/0b7c9a52-8d2f-4d57-9a8c-0d8c1f0a1b2c.jpg`;

    it('routes each record to the provider that stored it', async () => {
      supabase.get.mockResolvedValue(Buffer.from('cloud'));
      local.get.mockResolvedValue(Buffer.from('legacy'));

      await expect(
        storage.read({ provider: 'supabase', key }),
      ).resolves.toEqual(Buffer.from('cloud'));
      await expect(storage.read({ provider: 'local', key })).resolves.toEqual(
        Buffer.from('legacy'),
      );
      await storage.delete({ provider: 'local', key });

      expect(supabase.get.mock.calls).toEqual([[key]]);
      expect(local.get.mock.calls).toEqual([[key]]);
      expect(local.delete.mock.calls).toEqual([[key]]);
      expect(supabase.delete.mock.calls).toHaveLength(0);
    });

    it('fails safely for records naming an unregistered provider', async () => {
      await expect(
        storage.read({ provider: 'retired-s3', key }),
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
    ])(
      'rejects the unsafe key %p without calling a provider',
      async (badKey) => {
        await expect(
          storage.read({ provider: 'supabase', key: badKey }),
        ).rejects.toMatchObject({ code: 'INVALID_STORAGE_KEY' });
        await expect(
          storage.delete({ provider: 'supabase', key: badKey }),
        ).rejects.toMatchObject({ code: 'INVALID_STORAGE_KEY' });
        expect(supabase.get.mock.calls).toHaveLength(0);
        expect(supabase.delete.mock.calls).toHaveLength(0);
      },
    );

    it('still reads keys produced by the previous filesystem adapter', async () => {
      local.get.mockResolvedValue(Buffer.from('legacy'));
      const legacyKey = `${AUTH_ID}/profile/0b7c9a52-8d2f-4d57-9a8c-0d8c1f0a1b2c.webp`;

      await expect(
        storage.read({ provider: 'local', key: legacyKey }),
      ).resolves.toEqual(Buffer.from('legacy'));
    });

    it('logs a missing object as a warning rather than an error', async () => {
      supabase.get.mockRejectedValue(
        new PrivateStorageError('OBJECT_NOT_FOUND'),
      );

      await expect(
        storage.read({ provider: 'supabase', key }),
      ).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND', operation: 'get' });
      expect(logger.warn.mock.calls).toContainEqual([
        'Private image object is missing',
        expect.objectContaining({ code: 'OBJECT_NOT_FOUND' }),
      ]);
      expect(logger.error.mock.calls).toHaveLength(0);
    });

    it('deleteQuietly never throws and logs the orphaned key for cleanup', async () => {
      supabase.delete.mockRejectedValue(
        new PrivateStorageError('STORAGE_TIMEOUT'),
      );

      await expect(
        storage.deleteQuietly({ provider: 'supabase', key }, 'avatar replaced'),
      ).resolves.toBe(false);
      expect(logger.warn.mock.calls).toContainEqual([
        'Private image cleanup failed; object may be orphaned',
        {
          context: 'PrivateImageStorageService',
          reason: 'avatar replaced',
          provider: 'supabase',
          storageKey: key,
          code: 'STORAGE_TIMEOUT',
        },
      ]);

      supabase.delete.mockResolvedValue();
      await expect(
        storage.deleteQuietly({ provider: 'supabase', key }, 'avatar replaced'),
      ).resolves.toBe(true);
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
