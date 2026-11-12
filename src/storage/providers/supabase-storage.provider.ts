import {
  StorageApiError,
  StorageClient,
  StorageUnknownError,
  isStorageError,
} from '@supabase/storage-js';
import type { PrivateObjectStorageProvider } from '../private-object-storage.provider';
import {
  SUPABASE_STORAGE_PROVIDER_ID,
  type SupabaseStorageConfig,
} from '../private-storage.config';
import {
  PrivateStorageError,
  type PrivateStorageErrorCode,
  type PrivateStorageOperation,
} from '../private-storage.error';

type FetchLike = typeof fetch;

/** Re-check bucket visibility periodically so a bucket made public is noticed. */
const BUCKET_VISIBILITY_TTL_MS = 5 * 60_000;
/** Tolerated clock difference when checking a signed token's expiry. */
const SIGNED_URL_CLOCK_SKEW_SECONDS = 30;

/**
 * Supabase Storage adapter for a private bucket.
 *
 * Runs server-side only with a secret (service role) key, which bypasses RLS;
 * clients never receive the key, the bucket name or object URLs. Ownership is
 * enforced by the calling services before any key reaches this provider.
 */
export class SupabaseStorageProvider implements PrivateObjectStorageProvider {
  readonly id = SUPABASE_STORAGE_PROVIDER_ID;

  private readonly client?: StorageClient;
  private bucketCheck?: Promise<void>;
  private bucketVerifiedAt = 0;

  constructor(
    private readonly config: SupabaseStorageConfig | undefined,
    fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {
    if (!config) return;
    const key = config.serviceKey;
    this.client = new StorageClient(
      config.storageUrl,
      { apikey: key, Authorization: `Bearer ${key}` },
      withTimeout(fetchImpl, config.timeoutMs),
    );
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const client = this.requireClient('put');
    await this.ensurePrivateBucket(client);
    const { error } = await this.call('put', () =>
      client.from(this.bucket).upload(key, bytes, {
        contentType,
        upsert: false,
        cacheControl: '0',
      }),
    );
    if (error) throw this.toStorageError(error, 'put');
  }

  async get(key: string): Promise<Buffer> {
    const client = this.requireClient('get');
    const { data, error } = await this.call('get', () =>
      client.from(this.bucket).download(key),
    );
    if (error) throw this.toStorageError(error, 'get');
    if (!data) {
      throw new PrivateStorageError('STORAGE_UNAVAILABLE', {
        provider: this.id,
        operation: 'get',
      });
    }
    try {
      return Buffer.from(await data.arrayBuffer());
    } catch (cause) {
      throw this.toStorageError(cause, 'get');
    }
  }

  async delete(key: string): Promise<void> {
    const client = this.requireClient('delete');
    // Bulk removal by prefix succeeds with an empty list for missing objects.
    const { error } = await this.call('delete', () =>
      client.from(this.bucket).remove([key]),
    );
    if (!error) return;
    const mapped = this.toStorageError(error, 'delete');
    // Deleting an object that is already gone is a success.
    if (mapped.code !== 'OBJECT_NOT_FOUND') throw mapped;
  }

  async createSignedUrl(
    key: string,
    expiresInSeconds: number,
  ): Promise<string> {
    const client = this.requireClient('sign');
    const { data, error } = await this.call('sign', () =>
      client.from(this.bucket).createSignedUrl(key, expiresInSeconds),
    );
    if (error) throw this.toStorageError(error, 'sign');
    const url = data?.signedUrl;
    if (!url || !this.isExpectedSignedUrl(url, key, expiresInSeconds)) {
      throw new PrivateStorageError('INVALID_PROVIDER_RESPONSE', {
        provider: this.id,
        operation: 'sign',
      });
    }
    return url;
  }

  /**
   * Accepts only a URL on the configured Storage origin, for exactly this
   * bucket/key, carrying a token. When the token is a readable JWT its expiry
   * must not exceed the requested lifetime, so a misbehaving or spoofed
   * response can never hand out long-lived access.
   */
  private isExpectedSignedUrl(
    value: string,
    key: string,
    expiresInSeconds: number,
  ): boolean {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    const base = new URL(this.config?.storageUrl ?? '');
    const expectedPath = `${base.pathname}/object/sign/${this.bucket}/${key}`;
    const token = url.searchParams.get('token');
    if (
      url.origin !== base.origin ||
      url.pathname !== expectedPath ||
      url.username ||
      url.password ||
      !token
    ) {
      return false;
    }
    const exp = jwtExpiry(token);
    return (
      exp === undefined ||
      exp <=
        Math.floor(this.now() / 1000) +
          expiresInSeconds +
          SIGNED_URL_CLOCK_SKEW_SECONDS
    );
  }

  /**
   * Refuses writes unless the configured bucket exists and is private, so a
   * misconfigured (public) bucket can never receive face images.
   */
  private async ensurePrivateBucket(client: StorageClient): Promise<void> {
    if (
      this.bucketVerifiedAt &&
      this.now() - this.bucketVerifiedAt < BUCKET_VISIBILITY_TTL_MS
    ) {
      return;
    }
    this.bucketCheck ??= this.verifyBucketIsPrivate(client).finally(() => {
      this.bucketCheck = undefined;
    });
    await this.bucketCheck;
  }

  private async verifyBucketIsPrivate(client: StorageClient): Promise<void> {
    this.bucketVerifiedAt = 0;
    const { data, error } = await this.call('put', () =>
      client.getBucket(this.bucket),
    );
    if (error) {
      const mapped = this.toStorageError(error, 'put');
      // A missing bucket is a deployment problem, not a missing object.
      throw mapped.code === 'OBJECT_NOT_FOUND'
        ? new PrivateStorageError('STORAGE_MISCONFIGURED', {
            provider: this.id,
            operation: 'put',
            httpStatus: mapped.httpStatus,
            cause: error,
          })
        : mapped;
    }
    if (!data || data.public !== false) {
      throw new PrivateStorageError('STORAGE_MISCONFIGURED', {
        provider: this.id,
        operation: 'put',
      });
    }
    this.bucketVerifiedAt = this.now();
  }

  /** Runs an SDK call, converting unexpected throws into `{ error }`. */
  private async call<T>(
    operation: PrivateStorageOperation,
    request: () => PromiseLike<{ data: T | null; error: unknown }>,
  ): Promise<{ data: T | null; error: unknown }> {
    try {
      return await request();
    } catch (error) {
      return { data: null, error: this.toStorageError(error, operation) };
    }
  }

  private requireClient(operation: PrivateStorageOperation): StorageClient {
    if (!this.client) {
      throw new PrivateStorageError('STORAGE_MISCONFIGURED', {
        provider: this.id,
        operation,
      });
    }
    return this.client;
  }

  private get bucket(): string {
    // requireClient() guarantees the config is present before this is read.
    return this.config?.bucket ?? '';
  }

  private toStorageError(
    error: unknown,
    operation: PrivateStorageOperation,
  ): PrivateStorageError {
    if (error instanceof PrivateStorageError) return error;

    const details = { provider: this.id, operation, cause: error };
    if (error instanceof StorageApiError) {
      const status = effectiveStatus(error);
      return new PrivateStorageError(
        classifyApiError(error, status, operation),
        {
          ...details,
          httpStatus: status,
        },
      );
    }
    const underlying =
      error instanceof StorageUnknownError ? error.originalError : error;
    if (isTimeout(underlying)) {
      return new PrivateStorageError('STORAGE_TIMEOUT', details);
    }
    if (isStorageError(error) && error.status !== undefined) {
      return new PrivateStorageError(
        classifyStatus(error.status, operation, undefined),
        { ...details, httpStatus: error.status },
      );
    }
    return new PrivateStorageError('STORAGE_UNAVAILABLE', details);
  }
}

/**
 * Supabase Storage has historically answered some errors with HTTP 400 and
 * the real status in the body (`{ statusCode: "404" }`); newer versions use
 * the HTTP status directly. Prefer the body status when it is a valid code.
 */
function effectiveStatus(error: StorageApiError): number {
  const bodyStatus = Number(error.statusCode);
  if (Number.isInteger(bodyStatus) && bodyStatus >= 400 && bodyStatus <= 599) {
    return bodyStatus;
  }
  return error.status;
}

function classifyApiError(
  error: StorageApiError,
  status: number,
  operation: PrivateStorageOperation,
): PrivateStorageErrorCode {
  const code = error.code ?? '';
  if (code === 'NoSuchBucket' || /bucket not found/i.test(error.message)) {
    return 'STORAGE_MISCONFIGURED';
  }
  if (code === 'NoSuchKey') return 'OBJECT_NOT_FOUND';
  if (code === 'KeyAlreadyExists' || code === 'ResourceAlreadyExists') {
    return 'OBJECT_ALREADY_EXISTS';
  }
  if (code === 'InvalidKey') return 'INVALID_STORAGE_KEY';
  return classifyStatus(status, operation, code);
}

function classifyStatus(
  status: number,
  operation: PrivateStorageOperation,
  code: string | undefined,
): PrivateStorageErrorCode {
  if (status === 404) {
    // Reads and signing can miss an object; for writes a 404 means the bucket
    // (or endpoint) is missing.
    return operation === 'put' ? 'STORAGE_MISCONFIGURED' : 'OBJECT_NOT_FOUND';
  }
  if (status === 409) return 'OBJECT_ALREADY_EXISTS';
  if (status === 401 || status === 403) return 'STORAGE_ACCESS_DENIED';
  if (status === 408 || status === 429 || status >= 500) {
    return code === 'DatabaseTimeout' || status === 504
      ? 'STORAGE_TIMEOUT'
      : 'STORAGE_UNAVAILABLE';
  }
  return 'STORAGE_REJECTED';
}

/** `exp` claim of a JWT-shaped token, or undefined when it is not readable. */
function jwtExpiry(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    );
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'exp' in payload &&
      typeof payload.exp === 'number'
    ) {
      return payload.exp;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Abort reasons are `DOMException`s, which are not `instanceof Error` across
 * realms, so match on the name instead of the prototype.
 */
function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

/** Applies a per-request deadline covering both headers and body transfer. */
function withTimeout(fetchImpl: FetchLike, timeoutMs: number): FetchLike {
  return (input: string | URL | Request, init?: RequestInit) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, deadline])
      : deadline;
    return fetchImpl(input, { ...init, signal });
  };
}
