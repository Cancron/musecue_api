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
  /** Stable identifier persisted next to each storage key, e.g. "supabase". */
  readonly id: string;

  put(key: string, bytes: Buffer, contentType: string): Promise<void>;

  get(key: string): Promise<Buffer>;

  delete(key: string): Promise<void>;

  /**
   * Returns a URL granting read access to one object for `expiresInSeconds`.
   * The URL must embed only a short-lived, object-scoped token, never the
   * provider credentials. Providers that cannot sign throw
   * `SIGNED_URL_UNSUPPORTED`.
   */
  createSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
}

/** Multi-provider injection token: every registered provider instance. */
export const PRIVATE_OBJECT_STORAGE_PROVIDERS = Symbol(
  'PRIVATE_OBJECT_STORAGE_PROVIDERS',
);

/** Location of a stored object: the provider that owns it and its key. */
export interface PrivateObjectRef {
  provider: string;
  key: string;
}
