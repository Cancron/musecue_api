import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeS3CompatibleStorage } from '../../test/support/fake-s3-compatible-storage';
import {
  FAKE_SUPABASE,
  FakeSupabaseStorage,
  unavailable,
} from '../../test/support/fake-supabase-storage';
import {
  PROVIDER_ID_PATTERN,
  type PrivateObjectStorageProvider,
} from './private-object-storage.provider';
import { PrivateStorageError } from './private-storage.error';
import { LocalFilesystemStorageProvider } from './providers/local-filesystem-storage.provider';
import { SupabaseStorageProvider } from './providers/supabase-storage.provider';

/**
 * Provider contract: every storage backend (Supabase, a future S3-compatible
 * adapter, the local filesystem) must behave identically here, so callers
 * and the image workflows never depend on which provider holds an object.
 * A new provider is added by appending a subject below.
 */
interface ContractSubject {
  provider: PrivateObjectStorageProvider;
  /** What the backend really holds, bypassing the provider. */
  stored(key: string): Promise<Buffer | undefined>;
  /** Present when the provider can issue signed URLs. */
  signing?: {
    /** Fetches a signed URL the way a client would. */
    download(url: string): Promise<{ status: number; bytes?: Buffer }>;
    /** Moves the backend's clock forward. */
    advanceClock(ms: number): void;
  };
  /** Makes the next call of `op` fail transiently (when supported). */
  failTransiently?(op: 'put' | 'get' | 'delete' | 'sign'): void;
  /** Strings that must never appear in errors or URLs. */
  secrets: string[];
  dispose?(): Promise<void>;
}

const subjects: Array<[string, () => Promise<ContractSubject>]> = [
  [
    'Supabase (mocked Storage API)',
    () => {
      const fake = new FakeSupabaseStorage();
      const opMap = {
        put: 'upload',
        get: 'download',
        delete: 'remove',
        sign: 'sign',
      } as const;
      return Promise.resolve({
        provider: new SupabaseStorageProvider(
          {
            storageUrl: FAKE_SUPABASE.url,
            serviceKey: FAKE_SUPABASE.serviceKey,
            bucket: FAKE_SUPABASE.bucket,
            timeoutMs: 1_000,
          },
          fake.fetch,
        ),
        stored: (key) => Promise.resolve(fake.objects.get(key)?.bytes),
        signing: {
          download: async (url) => {
            const response = await fake.fetch(url);
            return {
              status: response.status,
              bytes:
                response.status === 200
                  ? Buffer.from(await response.arrayBuffer())
                  : undefined,
            };
          },
          advanceClock: (ms) => {
            fake.clockOffsetMs += ms;
          },
        },
        failTransiently: (op) => fake.failNext(opMap[op], unavailable),
        secrets: [FAKE_SUPABASE.serviceKey],
      });
    },
  ],
  [
    'S3-compatible (fake second provider)',
    () => {
      const fake = new FakeS3CompatibleStorage();
      return Promise.resolve({
        provider: fake,
        stored: (key) => Promise.resolve(fake.objects.get(key)?.bytes),
        signing: {
          download: (url) => Promise.resolve(fake.download(url)),
          advanceClock: (ms) => {
            fake.clockOffsetMs += ms;
          },
        },
        failTransiently: (op) => fake.failNext(op, 'STORAGE_UNAVAILABLE'),
        secrets: [],
      });
    },
  ],
  [
    'local filesystem (legacy, cannot sign)',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'musecue-contract-'));
      return {
        provider: new LocalFilesystemStorageProvider(root),
        stored: (key) =>
          readFile(join(root, ...key.split('/'))).catch(() => undefined),
        secrets: [root],
        dispose: () => rm(root, { recursive: true, force: true }),
      };
    },
  ],
];

const KEY = 'owner-id/session-id/0b7c9a52-8d2f-4d57-9a8c-0d8c1f0a1b2c.jpg';
const SIBLING = 'owner-id/session-id/0b7c9a52-8d2f-4d57-9a8c-0d8c1f0a1b2d.jpg';
/** Every byte value, so encoding bugs cannot hide. */
const BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

async function storageError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PrivateStorageError);
    return error as PrivateStorageError;
  }
  throw new Error('Expected a storage error');
}

describe.each(subjects)('Storage provider contract: %s', (_name, create) => {
  let subject: ContractSubject;
  let provider: PrivateObjectStorageProvider;

  beforeEach(async () => {
    subject = await create();
    provider = subject.provider;
  });
  afterEach(() => subject.dispose?.());

  it('has a storable id and reports itself configured', () => {
    expect(provider.id).toMatch(PROVIDER_ID_PATTERN);
    expect(provider.isConfigured()).toBe(true);
  });

  it('stores and returns exactly the same bytes', async () => {
    await provider.put(KEY, BYTES, 'image/jpeg');

    await expect(provider.get(KEY)).resolves.toEqual(BYTES);
    await expect(subject.stored(KEY)).resolves.toEqual(BYTES);
  });

  it('never overwrites an existing object', async () => {
    await provider.put(KEY, BYTES, 'image/jpeg');

    const error = await storageError(
      provider.put(KEY, Buffer.from('other'), 'image/jpeg'),
    );
    expect(error).toMatchObject({
      code: 'OBJECT_ALREADY_EXISTS',
      retryable: false,
    });
    await expect(provider.get(KEY)).resolves.toEqual(BYTES);
  });

  it('reports a missing object as OBJECT_NOT_FOUND (not retryable)', async () => {
    const error = await storageError(provider.get(KEY));

    expect(error).toMatchObject({ code: 'OBJECT_NOT_FOUND', retryable: false });
  });

  it('deletes only the exact key, idempotently', async () => {
    await provider.put(KEY, BYTES, 'image/jpeg');
    await provider.put(SIBLING, BYTES, 'image/jpeg');

    await provider.delete(KEY);
    await expect(provider.delete(KEY)).resolves.toBeUndefined();

    await expect(subject.stored(KEY)).resolves.toBeUndefined();
    await expect(provider.get(SIBLING)).resolves.toEqual(BYTES);
  });

  describe('signed URLs', () => {
    it('issues a read URL whose window comes from the provider and lasts at most the request', async () => {
      if (!subject.signing) {
        await provider.put(KEY, BYTES, 'image/jpeg');
        const error = await storageError(provider.createSignedUrl(KEY, 60));
        expect(error.code).toBe('SIGNED_URL_UNSUPPORTED');
        return;
      }
      await provider.put(KEY, BYTES, 'image/jpeg');

      const signed = await provider.createSignedUrl(KEY, 60);

      const lifetime =
        (signed.expiresAt.getTime() - signed.issuedAt.getTime()) / 1000;
      expect(Number.isInteger(lifetime)).toBe(true);
      expect(lifetime).toBeGreaterThan(0);
      expect(lifetime).toBeLessThanOrEqual(60);
      for (const secret of subject.secrets) {
        expect(signed.url).not.toContain(secret);
      }
      await expect(subject.signing.download(signed.url)).resolves.toEqual({
        status: 200,
        bytes: BYTES,
      });
    });

    it('stops working once the provider-reported window has passed', async () => {
      if (!subject.signing) return;
      await provider.put(KEY, BYTES, 'image/jpeg');
      const signed = await provider.createSignedUrl(KEY, 60);

      subject.signing.advanceClock(
        signed.expiresAt.getTime() - signed.issuedAt.getTime() + 1_000,
      );

      expect((await subject.signing.download(signed.url)).status).not.toBe(200);
    });

    it('honours a shorter requested lifetime', async () => {
      if (!subject.signing) return;
      await provider.put(KEY, BYTES, 'image/jpeg');

      const signed = await provider.createSignedUrl(KEY, 10);

      expect(
        signed.expiresAt.getTime() - signed.issuedAt.getTime(),
      ).toBeLessThanOrEqual(10_000);
    });

    it.each([0, 61, 3600, 1.5])(
      'refuses to request a lifetime of %p seconds',
      async (ttl) => {
        if (!subject.signing) return;
        await provider.put(KEY, BYTES, 'image/jpeg');

        await expect(provider.createSignedUrl(KEY, ttl)).rejects.toThrow(
          RangeError,
        );
      },
    );

    it('reports signing a missing object as OBJECT_NOT_FOUND', async () => {
      if (!subject.signing) return;

      const error = await storageError(provider.createSignedUrl(KEY, 60));
      expect(error.code).toBe('OBJECT_NOT_FOUND');
    });
  });

  describe('failures', () => {
    it.each(['put', 'get', 'delete', 'sign'] as const)(
      'reports a transient %s failure as a retryable, safe PrivateStorageError',
      async (op) => {
        if (!subject.failTransiently) return;
        if (op !== 'put') await provider.put(KEY, BYTES, 'image/jpeg');
        subject.failTransiently(op);

        const error = await storageError(
          op === 'put'
            ? provider.put(KEY, BYTES, 'image/jpeg')
            : op === 'get'
              ? provider.get(KEY)
              : op === 'delete'
                ? provider.delete(KEY)
                : provider.createSignedUrl(KEY, 60),
        );

        expect(error).toMatchObject({
          code: 'STORAGE_UNAVAILABLE',
          retryable: true,
          provider: provider.id,
        });
        const exposed = `${error.message} ${JSON.stringify(error)}`;
        expect(exposed).not.toContain(KEY);
        for (const secret of subject.secrets) {
          expect(exposed).not.toContain(secret);
        }
      },
    );
  });
});
