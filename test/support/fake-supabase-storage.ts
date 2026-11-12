import { randomUUID } from 'node:crypto';

/**
 * In-memory stand-in for the Supabase Storage REST API, used through the real
 * `@supabase/storage-js` client via an injected `fetch`. No network, no real
 * credentials. Mirrors the response shapes the provider has to handle,
 * including the legacy "HTTP 400 with the real status in the body" errors.
 */
export type FakeOperation =
  | 'bucket'
  | 'upload'
  | 'download'
  | 'remove'
  | 'sign';

export type FakeFailure =
  | { kind: 'http'; status: number; statusCode: string; error: string }
  /** Connection-level failure (fetch rejects). */
  | { kind: 'network' }
  /** Stores the upload, then never answers: the client times out. */
  | { kind: 'store-then-hang' };

export interface FakeStoredObject {
  bytes: Buffer;
  contentType: string;
}

export const FAKE_SUPABASE = {
  url: 'https://fake-project.supabase.co/storage/v1',
  serviceKey: 'sb_secret_fake-test-key-not-real',
  bucket: 'musecue-private-images',
} as const;

export const unavailable: FakeFailure = {
  kind: 'http',
  status: 503,
  statusCode: '503',
  error: 'Service Unavailable',
};
export const accessDenied: FakeFailure = {
  kind: 'http',
  status: 400,
  statusCode: '403',
  error: 'Unauthorized',
};

export class FakeSupabaseStorage {
  readonly objects = new Map<string, FakeStoredObject>();
  readonly requests: Array<{ op: FakeOperation; key?: string }> = [];
  /** Artificial latency so concurrent requests overlap. */
  latencyMs = 0;
  /** Runs after an upload is stored, before the response is sent. */
  afterUploadStored?: (key: string) => Promise<void>;
  private readonly failures = new Map<FakeOperation, FakeFailure[]>();

  readonly fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    this.handle(input, init)) as typeof fetch;

  failNext(op: FakeOperation, failure: FakeFailure, times = 1): void {
    const queue = this.failures.get(op) ?? [];
    for (let i = 0; i < times; i += 1) queue.push(failure);
    this.failures.set(op, queue);
  }

  reset(): void {
    this.objects.clear();
    this.requests.length = 0;
    this.failures.clear();
    this.latencyMs = 0;
    this.afterUploadStored = undefined;
  }

  count(op: FakeOperation): number {
    return this.requests.filter((request) => request.op === op).length;
  }

  private async handle(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const href =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(href);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const path = decodeURIComponent(
      url.pathname.slice(new URL(FAKE_SUPABASE.url).pathname.length),
    );
    const { op, key } = this.route(method, path);
    this.requests.push({ op, key });

    if (this.latencyMs) await sleep(this.latencyMs);

    if (
      headers.get('apikey') !== FAKE_SUPABASE.serviceKey ||
      headers.get('authorization') !== `Bearer ${FAKE_SUPABASE.serviceKey}`
    ) {
      return json(400, {
        statusCode: '403',
        error: 'Unauthorized',
        message: 'invalid signature',
      });
    }

    const failure = this.failures.get(op)?.shift();
    if (failure?.kind === 'network') throw new TypeError('fetch failed');
    if (failure?.kind === 'http') {
      return json(failure.status, {
        statusCode: failure.statusCode,
        error: failure.error,
        message: failure.error,
      });
    }

    const bucketPrefix = `/object/${FAKE_SUPABASE.bucket}/`;
    switch (op) {
      case 'bucket':
        return json(200, {
          id: FAKE_SUPABASE.bucket,
          name: FAKE_SUPABASE.bucket,
          public: false,
        });
      case 'upload': {
        const objectKey = path.slice(bucketPrefix.length);
        if (this.objects.has(objectKey)) {
          return json(400, {
            statusCode: '409',
            error: 'Duplicate',
            message: 'The resource already exists',
          });
        }
        this.objects.set(objectKey, {
          bytes: Buffer.from(init?.body as Uint8Array),
          contentType: headers.get('content-type') ?? '',
        });
        await this.afterUploadStored?.(objectKey);
        if (failure?.kind === 'store-then-hang') {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(init.signal?.reason as Error),
            );
          });
        }
        return json(200, {
          Key: `${FAKE_SUPABASE.bucket}/${objectKey}`,
          Id: randomUUID(),
        });
      }
      case 'download': {
        const object = this.objects.get(path.slice(bucketPrefix.length));
        return object
          ? new Response(new Uint8Array(object.bytes), {
              status: 200,
              headers: { 'content-type': object.contentType },
            })
          : json(400, {
              statusCode: '404',
              error: 'not_found',
              message: 'Object not found',
            });
      }
      case 'remove': {
        const { prefixes } = JSON.parse(init?.body as string) as {
          prefixes: string[];
        };
        const removed = prefixes.filter((prefix) =>
          this.objects.delete(prefix),
        );
        return json(
          200,
          removed.map((name) => ({ name })),
        );
      }
      case 'sign': {
        const objectKey = key ?? '';
        if (!this.objects.has(objectKey)) {
          return json(400, {
            statusCode: '404',
            error: 'not_found',
            message: 'Object not found',
          });
        }
        const { expiresIn } = JSON.parse(init?.body as string) as {
          expiresIn: number;
        };
        const iat = Math.floor(Date.now() / 1000);
        const token = [
          Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
          Buffer.from(
            JSON.stringify({
              url: `${FAKE_SUPABASE.bucket}/${objectKey}`,
              iat,
              exp: iat + expiresIn,
            }),
          ).toString('base64url'),
          'fake-signature',
        ].join('.');
        return json(200, {
          signedURL: `/object/sign/${FAKE_SUPABASE.bucket}/${objectKey}?token=${token}`,
        });
      }
    }
  }

  private route(
    method: string,
    path: string,
  ): { op: FakeOperation; key?: string } {
    const bucket = FAKE_SUPABASE.bucket;
    if (method === 'GET' && path === `/bucket/${bucket}`)
      return { op: 'bucket' };
    if (method === 'DELETE' && path === `/object/${bucket}`) {
      return { op: 'remove' };
    }
    if (method === 'POST' && path.startsWith(`/object/sign/${bucket}/`)) {
      return {
        op: 'sign',
        key: path.slice(`/object/sign/${bucket}/`.length),
      };
    }
    if (path.startsWith(`/object/${bucket}/`)) {
      const key = path.slice(`/object/${bucket}/`.length);
      if (method === 'POST') return { op: 'upload', key };
      if (method === 'GET') return { op: 'download', key };
    }
    throw new Error(`Unexpected Supabase request ${method} ${path}`);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
