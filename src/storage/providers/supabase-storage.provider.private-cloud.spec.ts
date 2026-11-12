import type { SupabaseStorageConfig } from '../private-storage.config';
import { PrivateStorageError } from '../private-storage.error';
import { SupabaseStorageProvider } from './supabase-storage.provider';

const SERVICE_KEY = 'sb_secret_test-service-key-never-exposed';
const CONFIG: SupabaseStorageConfig = {
  storageUrl: 'https://project-ref.supabase.co/storage/v1',
  serviceKey: SERVICE_KEY,
  bucket: 'musecue-private-images',
  timeoutMs: 5_000,
};
const KEY = 'owner-id/session-id/0b7c9a52-8d2f-4d57-9a8c-0d8c1f0a1b2c.jpg';
const BUCKET_URL = `${CONFIG.storageUrl}/bucket/${CONFIG.bucket}`;
const OBJECT_URL = `${CONFIG.storageUrl}/object/${CONFIG.bucket}/${KEY}`;

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

type Responder = (request: RecordedRequest) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const privateBucket = () =>
  json({ id: CONFIG.bucket, name: CONFIG.bucket, public: false });
const uploaded = () =>
  json({ Key: `${CONFIG.bucket}/${KEY}`, Id: 'object-id' });

/** Fake fetch that records requests and answers them in order. */
function fakeFetch(...responders: Responder[]) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request: RecordedRequest = {
        url:
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: init?.body,
      };
      requests.push(request);
      const responder = responders[requests.length - 1];
      if (!responder) throw new Error(`Unexpected request ${request.url}`);
      return responder(request);
    },
  );
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected the operation to fail');
}

async function expectStorageError(
  promise: Promise<unknown>,
  code: PrivateStorageError['code'],
  retryable: boolean,
) {
  const error = await captureError(promise);
  expect(error).toBeInstanceOf(PrivateStorageError);
  expect(error).toMatchObject({ code, retryable, provider: 'supabase' });
  return error as PrivateStorageError;
}

describe('SupabaseStorageProvider (private cloud storage)', () => {
  describe('put', () => {
    it('verifies the bucket is private, then uploads write-once with server-side credentials', async () => {
      const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
      const { fetchImpl, requests } = fakeFetch(privateBucket, uploaded);
      const provider = new SupabaseStorageProvider(CONFIG, fetchImpl);

      await provider.put(KEY, bytes, 'image/jpeg');

      expect(requests.map((r) => [r.method, r.url])).toEqual([
        ['GET', BUCKET_URL],
        ['POST', OBJECT_URL],
      ]);
      const upload = requests[1];
      expect(upload.headers.get('apikey')).toBe(SERVICE_KEY);
      expect(upload.headers.get('authorization')).toBe(`Bearer ${SERVICE_KEY}`);
      expect(upload.headers.get('content-type')).toBe('image/jpeg');
      expect(upload.headers.get('x-upsert')).toBe('false');
      expect(Buffer.from(upload.body as Uint8Array)).toEqual(bytes);
    });

    it('refuses to upload into a public bucket', async () => {
      const { fetchImpl, requests } = fakeFetch(() =>
        json({ id: CONFIG.bucket, name: CONFIG.bucket, public: true }),
      );
      const provider = new SupabaseStorageProvider(CONFIG, fetchImpl);

      await expectStorageError(
        provider.put(KEY, Buffer.from('x'), 'image/jpeg'),
        'STORAGE_MISCONFIGURED',
        false,
      );
      expect(requests).toHaveLength(1);
    });

    it('reports a missing bucket as misconfiguration, not a missing object', async () => {
      const { fetchImpl } = fakeFetch(() =>
        json(
          {
            statusCode: '404',
            error: 'Bucket not found',
            message: 'Bucket not found',
          },
          400,
        ),
      );
      const provider = new SupabaseStorageProvider(CONFIG, fetchImpl);

      await expectStorageError(
        provider.put(KEY, Buffer.from('x'), 'image/jpeg'),
        'STORAGE_MISCONFIGURED',
        false,
      );
    });

    it('caches a successful visibility check and re-verifies after the TTL', async () => {
      let now = 1_000;
      const { fetchImpl, requests } = fakeFetch(
        privateBucket,
        uploaded,
        uploaded,
        privateBucket,
        uploaded,
      );
      const provider = new SupabaseStorageProvider(
        CONFIG,
        fetchImpl,
        () => now,
      );

      await provider.put(KEY, Buffer.from('a'), 'image/jpeg');
      now += 60_000;
      await provider.put(KEY, Buffer.from('b'), 'image/jpeg');
      now += 5 * 60_000;
      await provider.put(KEY, Buffer.from('c'), 'image/jpeg');

      expect(requests.map((r) => r.url)).toEqual([
        BUCKET_URL,
        OBJECT_URL,
        OBJECT_URL,
        BUCKET_URL,
        OBJECT_URL,
      ]);
    });

    it('does not cache a failed visibility check', async () => {
      const { fetchImpl, requests } = fakeFetch(
        () => json({ message: 'unavailable' }, 503),
        privateBucket,
        uploaded,
      );
      const provider = new SupabaseStorageProvider(CONFIG, fetchImpl);

      await expectStorageError(
        provider.put(KEY, Buffer.from('x'), 'image/jpeg'),
        'STORAGE_UNAVAILABLE',
        true,
      );
      await provider.put(KEY, Buffer.from('x'), 'image/jpeg');
      expect(requests.map((r) => r.url)).toEqual([
        BUCKET_URL,
        BUCKET_URL,
        OBJECT_URL,
      ]);
    });

    it('shares one in-flight visibility check between concurrent uploads', async () => {
      const { fetchImpl, requests } = fakeFetch(
        privateBucket,
        uploaded,
        uploaded,
      );
      const provider = new SupabaseStorageProvider(CONFIG, fetchImpl);

      await Promise.all([
        provider.put(KEY, Buffer.from('a'), 'image/jpeg'),
        provider.put(KEY, Buffer.from('b'), 'image/jpeg'),
      ]);
      expect(requests.filter((r) => r.url === BUCKET_URL)).toHaveLength(1);
    });

    it.each([
      [
        'a legacy duplicate (HTTP 400, body 409)',
        () =>
          json(
            {
              statusCode: '409',
              error: 'Duplicate',
              message: 'The resource already exists',
            },
            400,
          ),
      ],
      [
        'a duplicate error code',
        () =>
          json(
            { statusCode: '409', code: 'KeyAlreadyExists', message: 'exists' },
            409,
          ),
      ],
    ])('maps %s to OBJECT_ALREADY_EXISTS', async (_label, responder) => {
      const { fetchImpl } = fakeFetch(privateBucket, responder);
      const provider = new SupabaseStorageProvider(CONFIG, fetchImpl);

      await expectStorageError(
        provider.put(KEY, Buffer.from('x'), 'image/jpeg'),
        'OBJECT_ALREADY_EXISTS',
        false,
      );
    });
  });

  describe('get', () => {
    it('downloads the object bytes from the private bucket', async () => {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);
      const { fetchImpl, requests } = fakeFetch(
        () => new Response(bytes, { status: 200 }),
      );
      const provider = new SupabaseStorageProvider(CONFIG, fetchImpl);

      await expect(provider.get(KEY)).resolves.toEqual(bytes);
      expect(requests[0]).toMatchObject({ method: 'GET', url: OBJECT_URL });
      expect(requests[0].headers.get('authorization')).toBe(
        `Bearer ${SERVICE_KEY}`,
      );
    });

    it.each([
      [
        'HTTP 404',
        () =>
          json(
            {
              statusCode: '404',
              error: 'not_found',
              message: 'Object not found',
            },
            404,
          ),
      ],
      [
        'HTTP 400 with a 404 body',
        () =>
          json(
            {
              statusCode: '404',
              error: 'not_found',
              message: 'Object not found',
            },
            400,
          ),
      ],
      [
        'the NoSuchKey code',
        () =>
          json(
            {
              statusCode: '404',
              code: 'NoSuchKey',
              message: 'Object not found',
            },
            400,
          ),
      ],
    ])('maps %s to OBJECT_NOT_FOUND', async (_label, responder) => {
      const { fetchImpl } = fakeFetch(responder);
      const provider = new SupabaseStorageProvider(CONFIG, fetchImpl);

      const error = await expectStorageError(
        provider.get(KEY),
        'OBJECT_NOT_FOUND',
        false,
      );
      expect(error.operation).toBe('get');
    });
  });

  describe('delete', () => {
    it('removes the object by key and treats an already-missing object as success', async () => {
      const { fetchImpl, requests } = fakeFetch(() => json([]));
      const provider = new SupabaseStorageProvider(CONFIG, fetchImpl);

      await expect(provider.delete(KEY)).resolves.toBeUndefined();
      expect(requests[0]).toMatchObject({
        method: 'DELETE',
        url: `${CONFIG.storageUrl}/object/${CONFIG.bucket}`,
      });
      expect(JSON.parse(requests[0].body as string)).toEqual({
        prefixes: [KEY],
      });
    });

    it('treats a 404 for the object as already deleted', async () => {
      const { fetchImpl } = fakeFetch(() =>
        json(
          {
            statusCode: '404',
            error: 'not_found',
            message: 'Object not found',
          },
          404,
        ),
      );
      const provider = new SupabaseStorageProvider(CONFIG, fetchImpl);

      await expect(provider.delete(KEY)).resolves.toBeUndefined();
    });

    it('still reports a missing bucket on delete', async () => {
      const { fetchImpl } = fakeFetch(() =>
        json(
          {
            statusCode: '404',
            error: 'Bucket not found',
            message: 'Bucket not found',
          },
          400,
        ),
      );
      const provider = new SupabaseStorageProvider(CONFIG, fetchImpl);

      await expectStorageError(
        provider.delete(KEY),
        'STORAGE_MISCONFIGURED',
        false,
      );
    });
  });

  describe('createSignedUrl', () => {
    const NOW_MS = Date.parse('2026-11-12T12:00:00.000Z');
    const nowSeconds = Math.floor(NOW_MS / 1000);
    const SIGN_URL = `${CONFIG.storageUrl}/object/sign/${CONFIG.bucket}/${KEY}`;
    const token = (payload: object) =>
      [
        Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
        Buffer.from(JSON.stringify(payload)).toString('base64url'),
        'signature',
      ].join('.');
    const signed = (value: string) =>
      json({
        signedURL: `/object/sign/${CONFIG.bucket}/${KEY}?token=${value}`,
      });
    const provider = (...responders: Responder[]) => {
      const fake = fakeFetch(...responders);
      return {
        ...fake,
        provider: new SupabaseStorageProvider(
          CONFIG,
          fake.fetchImpl,
          () => NOW_MS,
        ),
      };
    };

    it('requests a 60 second URL with server-side credentials and returns it', async () => {
      const jwt = token({
        url: `${CONFIG.bucket}/${KEY}`,
        iat: nowSeconds,
        exp: nowSeconds + 60,
      });
      const { provider: supabase, requests } = provider(() => signed(jwt));

      const url = await supabase.createSignedUrl(KEY, 60);

      expect(url).toBe(`${SIGN_URL}?token=${jwt}`);
      expect(requests[0]).toMatchObject({ method: 'POST', url: SIGN_URL });
      expect(JSON.parse(requests[0].body as string)).toEqual({ expiresIn: 60 });
      expect(requests[0].headers.get('authorization')).toBe(
        `Bearer ${SERVICE_KEY}`,
      );
      expect(url).not.toContain(SERVICE_KEY);
    });

    it.each([
      ['exactly 60 s', 60],
      ['a shorter lifetime', 30],
      ['one second', 1],
    ])('accepts a token with a lifetime of %s', async (_label, lifetime) => {
      const { provider: supabase } = provider(() =>
        signed(token({ iat: nowSeconds, exp: nowSeconds + lifetime })),
      );

      await expect(supabase.createSignedUrl(KEY, 60)).resolves.toContain(
        'token=',
      );
    });

    it('measures the lifetime from the signed claims, independent of the local clock', async () => {
      // Supabase's clock 10 minutes ahead: still a 60 s token, so accepted.
      const ahead = nowSeconds + 600;
      const { provider: supabase } = provider(() =>
        signed(token({ iat: ahead, exp: ahead + 60 })),
      );

      await expect(supabase.createSignedUrl(KEY, 60)).resolves.toContain(
        'token=',
      );
    });

    it('never accepts more than the requested lifetime, even below 60 s', async () => {
      const { provider: supabase } = provider(() =>
        signed(token({ iat: nowSeconds, exp: nowSeconds + 31 })),
      );

      await expectStorageError(
        supabase.createSignedUrl(KEY, 30),
        'INVALID_PROVIDER_RESPONSE',
        false,
      );
    });

    it.each([0, 61, 90, 3600, 1.5, -60])(
      'refuses to request a lifetime of %p seconds without calling Supabase',
      async (ttl) => {
        const { provider: supabase, requests } = provider(() =>
          signed(token({ iat: nowSeconds, exp: nowSeconds + 60 })),
        );

        await expect(supabase.createSignedUrl(KEY, ttl)).rejects.toThrow(
          RangeError,
        );
        expect(requests).toHaveLength(0);
      },
    );

    const VALID = token({ iat: nowSeconds, exp: nowSeconds + 60 });

    it.each([
      [
        'a 61 s token (one second over the maximum)',
        () => signed(token({ iat: nowSeconds, exp: nowSeconds + 61 })),
      ],
      [
        'a 90 s token (the former skew allowance)',
        () => signed(token({ iat: nowSeconds, exp: nowSeconds + 90 })),
      ],
      [
        'a token valid for an hour',
        () => signed(token({ iat: nowSeconds, exp: nowSeconds + 3600 })),
      ],
      [
        'a token without iat (lifetime cannot be verified)',
        () => signed(token({ exp: nowSeconds + 60 })),
      ],
      [
        'a token without exp (never expires)',
        () => signed(token({ iat: nowSeconds })),
      ],
      [
        'a token expiring before it was issued',
        () => signed(token({ iat: nowSeconds, exp: nowSeconds })),
      ],
      [
        'non-integer claims',
        () => signed(token({ iat: nowSeconds, exp: nowSeconds + 59.5 })),
      ],
      [
        'string claims',
        () =>
          signed(
            token({ iat: String(nowSeconds), exp: String(nowSeconds + 60) }),
          ),
      ],
      ['an opaque (non-JWT) token', () => signed('opaque-token')],
      ['a JWT with an unreadable payload', () => signed('a.%%%.c')],
      [
        'a URL for another object',
        () =>
          json({
            signedURL: `/object/sign/${CONFIG.bucket}/other/x.jpg?token=${VALID}`,
          }),
      ],
      [
        'a URL for another bucket',
        () =>
          json({
            signedURL: `/object/sign/public-bucket/${KEY}?token=${VALID}`,
          }),
      ],
      [
        'a URL without a token',
        () => json({ signedURL: `/object/sign/${CONFIG.bucket}/${KEY}` }),
      ],
      ['a missing signedURL', () => json({})],
      [
        'a public (unsigned) object URL',
        () =>
          json({
            signedURL: `/object/public/${CONFIG.bucket}/${KEY}?token=${VALID}`,
          }),
      ],
    ])('rejects %s', async (_label, responder) => {
      const { provider: supabase } = provider(responder);

      await expectStorageError(
        supabase.createSignedUrl(KEY, 60),
        'INVALID_PROVIDER_RESPONSE',
        false,
      );
    });

    it.each([
      [
        'a missing object',
        () =>
          json(
            {
              statusCode: '404',
              error: 'not_found',
              message: 'Object not found',
            },
            400,
          ),
        'OBJECT_NOT_FOUND',
        false,
      ],
      [
        'a missing bucket',
        () =>
          json(
            {
              statusCode: '404',
              error: 'Bucket not found',
              message: 'Bucket not found',
            },
            400,
          ),
        'STORAGE_MISCONFIGURED',
        false,
      ],
      [
        'rejected credentials',
        () =>
          json(
            {
              statusCode: '403',
              error: 'Unauthorized',
              message: 'invalid signature',
            },
            400,
          ),
        'STORAGE_ACCESS_DENIED',
        false,
      ],
      [
        'a provider outage',
        () => json({ message: 'unavailable' }, 503),
        'STORAGE_UNAVAILABLE',
        true,
      ],
      [
        'a network failure',
        () => {
          throw new TypeError('fetch failed');
        },
        'STORAGE_UNAVAILABLE',
        true,
      ],
    ] as const)('maps %s to %s', async (_label, responder, code, retryable) => {
      const { provider: supabase } = provider(responder);

      const error = await expectStorageError(
        supabase.createSignedUrl(KEY, 60),
        code,
        retryable,
      );
      expect(error.operation).toBe('sign');
    });
  });

  describe('failure classification', () => {
    it.each([
      [401, 'STORAGE_ACCESS_DENIED', false],
      [403, 'STORAGE_ACCESS_DENIED', false],
      [413, 'STORAGE_REJECTED', false],
      [415, 'STORAGE_REJECTED', false],
      [429, 'STORAGE_UNAVAILABLE', true],
      [500, 'STORAGE_UNAVAILABLE', true],
      [502, 'STORAGE_UNAVAILABLE', true],
      [503, 'STORAGE_UNAVAILABLE', true],
      [504, 'STORAGE_TIMEOUT', true],
    ] as const)(
      'maps HTTP %i to %s (retryable: %s)',
      async (status, code, retryable) => {
        const { fetchImpl } = fakeFetch(() =>
          json(
            { statusCode: String(status), error: 'err', message: 'err' },
            status,
          ),
        );
        const provider = new SupabaseStorageProvider(CONFIG, fetchImpl);

        const error = await expectStorageError(
          provider.get(KEY),
          code,
          retryable,
        );
        expect(error.httpStatus).toBe(status);
      },
    );

    it('maps an RLS/permission error reported in the body (HTTP 400, body 403)', async () => {
      const { fetchImpl } = fakeFetch(() =>
        json(
          {
            statusCode: '403',
            error: 'Unauthorized',
            message: 'new row violates row-level security policy',
          },
          400,
        ),
      );
      const provider = new SupabaseStorageProvider(CONFIG, fetchImpl);

      await expectStorageError(
        provider.get(KEY),
        'STORAGE_ACCESS_DENIED',
        false,
      );
    });

    it('maps a non-JSON gateway error by HTTP status', async () => {
      const { fetchImpl } = fakeFetch(
        () => new Response('<html>Bad gateway</html>', { status: 502 }),
      );
      const provider = new SupabaseStorageProvider(CONFIG, fetchImpl);

      await expectStorageError(provider.get(KEY), 'STORAGE_UNAVAILABLE', true);
    });

    it('maps network failures to a retryable STORAGE_UNAVAILABLE', async () => {
      const { fetchImpl } = fakeFetch(() => {
        throw new TypeError('fetch failed');
      });
      const provider = new SupabaseStorageProvider(CONFIG, fetchImpl);

      await expectStorageError(
        provider.delete(KEY),
        'STORAGE_UNAVAILABLE',
        true,
      );
    });

    it('aborts requests that exceed the configured timeout', async () => {
      const hanging = jest.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(init.signal?.reason as Error),
            );
          }),
      );
      const provider = new SupabaseStorageProvider(
        { ...CONFIG, timeoutMs: 25 },
        hanging as unknown as typeof fetch,
      );

      await expectStorageError(provider.get(KEY), 'STORAGE_TIMEOUT', true);
      const init = hanging.mock.calls[0]?.[1];
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('never exposes credentials, URLs or keys in error messages', async () => {
      const { fetchImpl } = fakeFetch(() =>
        json(
          {
            statusCode: '500',
            error: 'internal',
            message: `failed for ${OBJECT_URL} using ${SERVICE_KEY}`,
          },
          500,
        ),
      );
      const provider = new SupabaseStorageProvider(CONFIG, fetchImpl);

      const error = await expectStorageError(
        provider.get(KEY),
        'STORAGE_UNAVAILABLE',
        true,
      );
      for (const exposed of [
        error.message,
        error.stack ?? '',
        JSON.stringify(error),
      ]) {
        expect(exposed).not.toContain(SERVICE_KEY);
        expect(exposed).not.toContain('supabase.co');
        expect(exposed).not.toContain(KEY);
      }
    });
  });

  it('fails every operation as misconfigured when Supabase is not configured', async () => {
    const fetchImpl = jest.fn();
    const provider = new SupabaseStorageProvider(
      undefined,
      fetchImpl as unknown as typeof fetch,
    );

    await expectStorageError(
      provider.put(KEY, Buffer.from('x'), 'image/jpeg'),
      'STORAGE_MISCONFIGURED',
      false,
    );
    await expectStorageError(provider.get(KEY), 'STORAGE_MISCONFIGURED', false);
    await expectStorageError(
      provider.delete(KEY),
      'STORAGE_MISCONFIGURED',
      false,
    );
    await expectStorageError(
      provider.createSignedUrl(KEY, 60),
      'STORAGE_MISCONFIGURED',
      false,
    );
    expect(fetchImpl.mock.calls).toHaveLength(0);
  });
});
