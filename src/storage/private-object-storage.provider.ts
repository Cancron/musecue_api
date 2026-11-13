/**
 * Contract for a private object storage backend (Supabase Storage, the local
 * filesystem, and future S3-compatible services).
 *
 * Providers are only responsible for moving bytes for an already validated
 * key. Key generation, ownership checks, image validation and provider
 * selection stay in `PrivateImageStorageService` and the calling services, so
 * adding a provider never changes the image processing flow.
 *
 * Implementations must:
 * - never make objects publicly readable;
 * - treat keys as write-once (`put` fails with `OBJECT_ALREADY_EXISTS`);
 * - make `delete` idempotent (deleting a missing object succeeds);
 * - throw `PrivateStorageError` with a stable code, never raw provider errors
 *   (the facade wraps anything else as `STORAGE_UNAVAILABLE`);
 * - never include credentials, signed URLs or object contents in errors.
 */
export interface PrivateObjectStorageProvider {
  /**
   * Stable identifier persisted next to each storage key, e.g. "supabase".
   * Must match `PROVIDER_ID_PATTERN`. Never rename a provider that stored
   * images reference: reads, deletions and signing look it up by this id.
   */
  readonly id: string;

  /**
   * Whether the provider has the settings it needs. A registered but
   * unconfigured provider fails every operation with STORAGE_MISCONFIGURED.
   */
  isConfigured(): boolean;

  put(key: string, bytes: Buffer, contentType: string): Promise<void>;

  get(key: string): Promise<Buffer>;

  delete(key: string): Promise<void>;

  /**
   * Returns a URL granting read access to one object for `expiresInSeconds`
   * (an integer from 1 to `MAX_SIGNED_URL_TTL_SECONDS`). The URL must embed
   * only a short-lived, object-scoped token, never the provider credentials,
   * and must not stay valid longer than requested. `issuedAt`/`expiresAt`
   * must be the validity window as the provider enforces it (e.g. a token's
   * signed `iat`/`exp`, or an S3 presign's `X-Amz-Date` + `X-Amz-Expires`),
   * never computed from the local clock. Providers that cannot sign throw
   * `SIGNED_URL_UNSUPPORTED`.
   */
  createSignedUrl(
    key: string,
    expiresInSeconds: number,
  ): Promise<SignedObjectUrl>;
}

/** A provider-issued, time-limited read URL and its provider-side validity. */
export interface SignedObjectUrl {
  url: string;
  issuedAt: Date;
  expiresAt: Date;
}

/**
 * Hard upper bound for signed URL lifetimes, enforced by the facade and by
 * every provider (requests above it are refused; longer-lived provider
 * tokens are rejected).
 */
export const MAX_SIGNED_URL_TTL_SECONDS = 60;

/** Provider ids are stored in VARCHAR(32) columns. */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Multi-provider injection token: every registered provider instance. */
export const PRIVATE_OBJECT_STORAGE_PROVIDERS = Symbol(
  'PRIVATE_OBJECT_STORAGE_PROVIDERS',
);

/** Location of a stored object: the provider that owns it and its key. */
export interface PrivateObjectRef {
  provider: string;
  key: string;
}
