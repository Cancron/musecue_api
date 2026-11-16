import { join, resolve } from 'node:path';
import {
  loadPrivateStorageConfig,
  type ConfigReader,
} from './private-storage.config';

const SECRET_KEY = 'sb_secret_abcdefghijklmnopqrstuvwxyz012345';
const SUPABASE_ENV = {
  SUPABASE_URL: 'https://project-ref.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY,
  SUPABASE_STORAGE_BUCKET: 'musecue-private-images',
};

function env(values: Record<string, string | undefined>): ConfigReader {
  return { get: <T>(key: string) => values[key] as T | undefined };
}

function legacyJwt(role: string): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role, iss: 'supabase' })}.signature`;
}

function loadError(values: Record<string, string | undefined>): Error {
  try {
    loadPrivateStorageConfig(env(values));
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected configuration to be rejected');
}

describe('loadPrivateStorageConfig (private cloud storage)', () => {
  it('uses Supabase as the default provider and derives the Storage API URL', () => {
    const config = loadPrivateStorageConfig(
      env({
        ...SUPABASE_ENV,
        SUPABASE_URL: 'https://project-ref.supabase.co/',
      }),
    );

    expect(config.activeProvider).toBe('supabase');
    expect(config.supabase).toEqual({
      storageUrl: 'https://project-ref.supabase.co/storage/v1',
      serviceKey: SECRET_KEY,
      bucket: 'musecue-private-images',
      timeoutMs: 15_000,
    });
  });

  it('fails fast, naming only the missing variables, when Supabase is active but incomplete', () => {
    const error = loadError({
      PRIVATE_STORAGE_PROVIDER: 'supabase',
      SUPABASE_URL: 'https://project-ref.supabase.co',
    });

    expect(error.message).toBe(
      'Supabase private storage requires SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET to be set',
    );
  });

  it('treats blank variables as missing', () => {
    const error = loadError({
      ...SUPABASE_ENV,
      SUPABASE_SERVICE_ROLE_KEY: '  ',
    });

    expect(error.message).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('defaults to local storage only for test runs without explicit configuration', () => {
    expect(
      loadPrivateStorageConfig(env({ NODE_ENV: 'test' })).activeProvider,
    ).toBe('local');
    expect(() =>
      loadPrivateStorageConfig(env({ NODE_ENV: 'production' })),
    ).toThrow('Supabase private storage requires');
  });

  it('allows explicit local storage without Supabase, keeping the local root', () => {
    const config = loadPrivateStorageConfig(
      env({
        PRIVATE_STORAGE_PROVIDER: 'LOCAL',
        PRIVATE_UPLOAD_DIR: 'tmp/imgs',
      }),
    );

    expect(config).toEqual({
      activeProvider: 'local',
      localRoot: resolve('tmp/imgs'),
      supabase: undefined,
    });
    expect(
      loadPrivateStorageConfig(env({ PRIVATE_STORAGE_PROVIDER: 'local' }))
        .localRoot,
    ).toBe(resolve(join(process.cwd(), '.data', 'private-images')));
  });

  it('still validates Supabase settings when present but not active (legacy reads)', () => {
    const config = loadPrivateStorageConfig(
      env({ ...SUPABASE_ENV, PRIVATE_STORAGE_PROVIDER: 'local' }),
    );
    expect(config.supabase?.bucket).toBe('musecue-private-images');

    expect(
      loadError({
        PRIVATE_STORAGE_PROVIDER: 'local',
        SUPABASE_URL: 'https://project-ref.supabase.co',
      }).message,
    ).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('accepts any well-formed provider id (registration is checked at startup by the registry)', () => {
    expect(
      loadPrivateStorageConfig(env({ PRIVATE_STORAGE_PROVIDER: 'fake-s3' }))
        .activeProvider,
    ).toBe('fake-s3');
    // Supabase settings are only required when Supabase is the active provider.
    expect(
      loadPrivateStorageConfig(env({ PRIVATE_STORAGE_PROVIDER: 'r2-eu' }))
        .supabase,
    ).toBeUndefined();
  });

  it.each(['s3_bucket', 'my provider', '../local', '-s3', 'x'.repeat(33)])(
    'rejects the malformed provider id %p',
    (id) => {
      expect(loadError({ PRIVATE_STORAGE_PROVIDER: id }).message).toContain(
        'PRIVATE_STORAGE_PROVIDER must be a provider id',
      );
    },
  );

  it.each([
    ['not a URL', 'project-ref.supabase.co', 'must be a valid URL'],
    ['plain http', 'http://project-ref.supabase.co', 'must use https'],
    [
      'credentials',
      'https://user:pass@project-ref.supabase.co',
      'must not contain credentials',
    ],
    [
      'a query',
      'https://project-ref.supabase.co?x=1',
      'must not contain credentials',
    ],
    ['a path', 'https://project-ref.supabase.co/storage/v1', 'without a path'],
  ])('rejects a SUPABASE_URL with %s', (_label, url, message) => {
    expect(loadError({ ...SUPABASE_ENV, SUPABASE_URL: url }).message).toContain(
      message,
    );
  });

  it('allows http only for a local Supabase stack', () => {
    const config = loadPrivateStorageConfig(
      env({ ...SUPABASE_ENV, SUPABASE_URL: 'http://127.0.0.1:54321' }),
    );
    expect(config.supabase?.storageUrl).toBe(
      'http://127.0.0.1:54321/storage/v1',
    );
  });

  it.each([
    [
      'a publishable key',
      'sb_publishable_abcdefghijklmnop',
      'not a publishable key',
    ],
    ['a legacy anon JWT', legacyJwt('anon'), 'not the anon key'],
  ])(
    'rejects %s in place of the server-side secret',
    (_label, key, message) => {
      expect(
        loadError({ ...SUPABASE_ENV, SUPABASE_SERVICE_ROLE_KEY: key }).message,
      ).toContain(message);
    },
  );

  it('accepts a legacy service_role JWT', () => {
    const key = legacyJwt('service_role');
    const config = loadPrivateStorageConfig(
      env({ ...SUPABASE_ENV, SUPABASE_SERVICE_ROLE_KEY: key }),
    );
    expect(config.supabase?.serviceKey).toBe(key);
  });

  it('rejects invalid bucket names', () => {
    expect(
      loadError({
        ...SUPABASE_ENV,
        SUPABASE_STORAGE_BUCKET: '../Public Bucket',
      }).message,
    ).toContain('valid Supabase bucket name');
  });

  it.each(['abc', '999', '120001', '1500.5'])(
    'rejects SUPABASE_STORAGE_TIMEOUT_MS=%s',
    (timeout) => {
      expect(
        loadError({ ...SUPABASE_ENV, SUPABASE_STORAGE_TIMEOUT_MS: timeout })
          .message,
      ).toContain('SUPABASE_STORAGE_TIMEOUT_MS');
    },
  );

  it('never includes secret values in validation errors', () => {
    const badKeyError = loadError({
      ...SUPABASE_ENV,
      SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_leaky-value',
    });
    const badUrlError = loadError({
      ...SUPABASE_ENV,
      SUPABASE_URL: 'https://user:hunter2@project-ref.supabase.co',
    });

    expect(badKeyError.message).not.toContain('leaky-value');
    expect(badUrlError.message).not.toContain('hunter2');
  });
});
