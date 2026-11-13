import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  MAX_SIGNED_URL_TTL_SECONDS,
  type PrivateObjectStorageProvider,
  type SignedObjectUrl,
} from '../../src/storage/private-object-storage.provider';
import {
  PrivateStorageError,
  type PrivateStorageErrorCode,
} from '../../src/storage/private-storage.error';

export type FakeS3Operation = 'put' | 'get' | 'delete' | 'sign';

/**
 * Test-only, in-memory stand-in for an S3-compatible object store (no real
 * cloud service). It follows the provider contract the way an S3 adapter
 * would: write-once puts, idempotent exact-key deletes, and presigned GET
 * URLs using the `X-Amz-Date` + `X-Amz-Expires` scheme, with the validity
 * window reported from the store's own clock.
 */
export class FakeS3CompatibleStorage implements PrivateObjectStorageProvider {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();
  readonly calls: Array<{ op: FakeS3Operation; key: string }> = [];
  /** The store's clock relative to the test process, to emulate skew/delay. */
  clockOffsetMs = 0;
  latencyMs = 0;
  private readonly failures = new Map<
    FakeS3Operation,
    PrivateStorageErrorCode[]
  >();
  private readonly signingSecret = randomBytes(32);

  constructor(
    readonly id = 'fake-s3',
    readonly endpoint = 'https://fake-s3.example.test',
    readonly bucket = 'musecue-private-images',
    private configured = true,
  ) {}

  isConfigured(): boolean {
    return this.configured;
  }

  failNext(op: FakeS3Operation, code: PrivateStorageErrorCode, times = 1) {
    const queue = this.failures.get(op) ?? [];
    for (let i = 0; i < times; i += 1) queue.push(code);
    this.failures.set(op, queue);
  }

  reset(): void {
    this.objects.clear();
    this.calls.length = 0;
    this.failures.clear();
    this.clockOffsetMs = 0;
    this.latencyMs = 0;
  }

  count(op: FakeS3Operation): number {
    return this.calls.filter((call) => call.op === op).length;
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.begin('put', key);
    if (this.objects.has(key)) this.fail('OBJECT_ALREADY_EXISTS', 'put');
    this.objects.set(key, { bytes: Buffer.from(bytes), contentType });
  }

  async get(key: string): Promise<Buffer> {
    await this.begin('get', key);
    const object = this.objects.get(key);
    if (!object) this.fail('OBJECT_NOT_FOUND', 'get');
    return Buffer.from(object.bytes);
  }

  async delete(key: string): Promise<void> {
    await this.begin('delete', key);
    this.objects.delete(key); // exact key only; missing keys succeed
  }

  async createSignedUrl(
    key: string,
    expiresInSeconds: number,
  ): Promise<SignedObjectUrl> {
    if (
      !Number.isInteger(expiresInSeconds) ||
      expiresInSeconds < 1 ||
      expiresInSeconds > MAX_SIGNED_URL_TTL_SECONDS
    ) {
      throw new RangeError(
        `Signed URL lifetime must be 1-${MAX_SIGNED_URL_TTL_SECONDS} seconds`,
      );
    }
    await this.begin('sign', key);
    if (!this.objects.has(key)) this.fail('OBJECT_NOT_FOUND', 'sign');
    const issuedAtSeconds = Math.floor(this.now() / 1000);
    const amzDate = toAmzDate(issuedAtSeconds);
    const url = new URL(`${this.endpoint}/${this.bucket}/${key}`);
    url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
    url.searchParams.set('X-Amz-Date', amzDate);
    url.searchParams.set('X-Amz-Expires', String(expiresInSeconds));
    url.searchParams.set(
      'X-Amz-Signature',
      this.signature(key, amzDate, expiresInSeconds),
    );
    return {
      url: url.toString(),
      issuedAt: new Date(issuedAtSeconds * 1000),
      expiresAt: new Date((issuedAtSeconds + expiresInSeconds) * 1000),
    };
  }

  /** Emulates the S3 endpoint serving a presigned GET. */
  download(value: string): { status: number; bytes?: Buffer } {
    const url = new URL(value);
    const prefix = `/${this.bucket}/`;
    if (url.origin !== this.endpoint || !url.pathname.startsWith(prefix)) {
      return { status: 404 };
    }
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    const amzDate = url.searchParams.get('X-Amz-Date') ?? '';
    const expires = Number(url.searchParams.get('X-Amz-Expires'));
    const given = Buffer.from(url.searchParams.get('X-Amz-Signature') ?? '');
    const expected = Buffer.from(this.signature(key, amzDate, expires));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { status: 403 };
    }
    const issuedAtMs = fromAmzDate(amzDate);
    if (this.now() >= issuedAtMs + expires * 1000) return { status: 403 };
    const object = this.objects.get(key);
    return object
      ? { status: 200, bytes: Buffer.from(object.bytes) }
      : { status: 404 };
  }

  private now(): number {
    return Date.now() + this.clockOffsetMs;
  }

  private signature(key: string, amzDate: string, expires: number): string {
    return createHmac('sha256', this.signingSecret)
      .update(`${this.bucket}/${key}\n${amzDate}\n${expires}`)
      .digest('hex');
  }

  private async begin(op: FakeS3Operation, key: string): Promise<void> {
    this.calls.push({ op, key });
    if (!this.configured) this.fail('STORAGE_MISCONFIGURED', op);
    if (this.latencyMs) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
    const code = this.failures.get(op)?.shift();
    if (code) this.fail(code, op);
  }

  private fail(code: PrivateStorageErrorCode, op: FakeS3Operation): never {
    throw new PrivateStorageError(code, { provider: this.id, operation: op });
  }
}

function toAmzDate(seconds: number): string {
  return new Date(seconds * 1000)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function fromAmzDate(value: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return Number.NaN;
  const [, y, mo, d, h, mi, s] = match;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
}
