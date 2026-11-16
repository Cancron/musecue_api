import {
  deleteOwnedFile,
  pruneOwnerDirectories,
  OwnerScopeViolationError,
} from './private-storage-owner-files';
import { LOCAL_STORAGE_PROVIDER_ID } from './private-storage.config';
import { Inject, Injectable } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import {
  MAX_SIGNED_URL_TTL_SECONDS,
  PROVIDER_ID_PATTERN,
  PRIVATE_OBJECT_STORAGE_PROVIDERS,
  type PrivateObjectRef,
  type PrivateObjectStorageProvider,
} from './private-object-storage.provider';
import {
  PRIVATE_STORAGE_CONFIG,
  type PrivateStorageConfig,
} from './private-storage.config';
import {
  PrivateStorageError,
  type PrivateStorageOperation,
} from './private-storage.error';
import { detectImageMime } from './image-signature';
import {
  assertValidPrivateImageKey,
  buildPrivateImageKey,
  type SupportedImageMime,
} from './private-storage-key';

export type { PrivateObjectRef } from './private-object-storage.provider';
export type { SupportedImageMime } from './private-storage-key';

export { MAX_SIGNED_URL_TTL_SECONDS } from './private-object-storage.provider';

/**
 * Application-facing private image storage.
 *
 * New images go to the configured active provider; each stored record keeps
 * its provider id so reads and deletes are routed to the backend that holds
 * the object, which lets providers change without migrating old objects.
 * All failures surface as `PrivateStorageError` with a safe message.
 */
@Injectable()
export class PrivateImageStorageService {
  private readonly providers: ReadonlyMap<string, PrivateObjectStorageProvider>;
  private readonly activeProvider: PrivateObjectStorageProvider;

  constructor(
    @Inject(PRIVATE_OBJECT_STORAGE_PROVIDERS)
    providers: PrivateObjectStorageProvider[],
    @Inject(PRIVATE_STORAGE_CONFIG)
    private readonly config: PrivateStorageConfig,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {
    const registry = new Map<string, PrivateObjectStorageProvider>();
    for (const provider of providers) {
      if (!PROVIDER_ID_PATTERN.test(provider.id)) {
        throw new Error(
          `Invalid private storage provider id "${provider.id}" (lowercase letters, digits and "-", at most 32 characters)`,
        );
      }
      if (registry.has(provider.id)) {
        throw new Error(
          `Duplicate private storage provider id "${provider.id}"`,
        );
      }
      registry.set(provider.id, provider);
    }
    const active = registry.get(config.activeProvider);
    if (!active) {
      throw new Error(
        `Private storage provider "${config.activeProvider}" is not registered`,
      );
    }
    this.providers = registry;
    this.activeProvider = active;
  }

  /** Owner sweeps use the backend recorded with the erasure reference. */
  async listOwnerFiles(
    authId: string,
    provider = LOCAL_STORAGE_PROVIDER_ID,
  ): Promise<string[]> {
    const backend = this.resolve(provider);
    if (!backend.listOwnerFiles)
      throw new PrivateStorageError('STORAGE_MISCONFIGURED');
    return backend.listOwnerFiles(authId);
  }

  async deleteOwnerFile(
    authId: string,
    key: string,
    provider = LOCAL_STORAGE_PROVIDER_ID,
  ): Promise<boolean> {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(authId) ||
      !key.startsWith(authId + '/')
    ) {
      throw new OwnerScopeViolationError();
    }
    if (provider === LOCAL_STORAGE_PROVIDER_ID)
      return deleteOwnedFile(this.config.localRoot, authId, key);
    await this.delete({ provider, key });
    return true;
  }

  async pruneOwnerDirectories(
    authId: string,
    provider = LOCAL_STORAGE_PROVIDER_ID,
  ): Promise<void> {
    if (provider === LOCAL_STORAGE_PROVIDER_ID)
      await pruneOwnerDirectories(this.config.localRoot, authId);
  }

  /** Provider id used for new uploads. */
  get activeProviderId(): string {
    return this.activeProvider.id;
  }

  /** Ids of every registered provider (active or kept for existing images). */
  get registeredProviderIds(): string[] {
    return [...this.providers.keys()];
  }

  /** True when images stored under `providerId` can be served and deleted. */
  isAvailable(providerId: string): boolean {
    return this.providers.get(providerId)?.isConfigured() ?? false;
  }

  /**
   * Allocates a new, unused location on the active provider without any I/O,
   * so the location can be recorded (see `PrivateImageLifecycleService`)
   * before bytes are written.
   */
  createRef(
    authId: string,
    scopeId: string,
    mimeType: SupportedImageMime,
  ): PrivateObjectRef {
    try {
      return {
        provider: this.activeProvider.id,
        key: buildPrivateImageKey(authId, scopeId, mimeType),
      };
    } catch (cause) {
      const error = this.toStorageError(cause, this.activeProvider.id, 'put');
      this.log(error);
      throw error;
    }
  }

  /** Writes a new object; existing objects are never overwritten. */
  put(
    ref: PrivateObjectRef,
    bytes: Buffer,
    mimeType: SupportedImageMime,
  ): Promise<void> {
    return this.run(ref.provider, 'put', () => {
      assertValidPrivateImageKey(ref.key);
      return this.resolve(ref.provider).put(ref.key, bytes, mimeType);
    });
  }

  read(ref: PrivateObjectRef): Promise<Buffer> {
    return this.run(ref.provider, 'get', () => {
      assertValidPrivateImageKey(ref.key);
      return this.resolve(ref.provider).get(ref.key);
    });
  }

  /**
   * Reads an image and verifies the bytes really are the format recorded
   * when it was stored, so a corrupted object, a provider error page or a
   * different file is never served or processed as that image.
   */
  readImage(
    ref: PrivateObjectRef,
    expectedMimeType: SupportedImageMime,
  ): Promise<Buffer> {
    return this.run(ref.provider, 'get', async () => {
      assertValidPrivateImageKey(ref.key);
      const bytes = await this.resolve(ref.provider).get(ref.key);
      if (detectImageMime(bytes) !== expectedMimeType) {
        throw new PrivateStorageError('INVALID_PROVIDER_RESPONSE');
      }
      return bytes;
    });
  }

  /** Idempotent: deleting an object that no longer exists succeeds. */
  delete(ref: PrivateObjectRef): Promise<void> {
    return this.run(ref.provider, 'delete', () => {
      assertValidPrivateImageKey(ref.key);
      return this.resolve(ref.provider).delete(ref.key);
    });
  }

  /**
   * Issues a short-lived read URL from the provider that stores the object.
   * `expiresAt` is the provider's own expiry and `expiresInSeconds` the
   * provider's issued lifetime (`expiresAt - issuedAt`), so the two always
   * agree and nothing is derived from the local clock. Any provider's grant
   * longer than requested (at most 60 s) is rejected. Nothing is cached or
   * persisted; URLs are not logged.
   */
  async createSignedUrl(
    ref: PrivateObjectRef,
    expiresInSeconds: number,
  ): Promise<{ url: string; expiresAt: Date; expiresInSeconds: number }> {
    if (
      !Number.isInteger(expiresInSeconds) ||
      expiresInSeconds < 1 ||
      expiresInSeconds > MAX_SIGNED_URL_TTL_SECONDS
    ) {
      throw new RangeError(
        `Signed URL lifetime must be 1-${MAX_SIGNED_URL_TTL_SECONDS} seconds`,
      );
    }
    return this.run(ref.provider, 'sign', async () => {
      assertValidPrivateImageKey(ref.key);
      const signed = await this.resolve(ref.provider).createSignedUrl(
        ref.key,
        expiresInSeconds,
      );
      const lifetimeMs = signed.expiresAt.getTime() - signed.issuedAt.getTime();
      const lifetimeSeconds = lifetimeMs / 1000;
      if (
        !signed.url ||
        !Number.isInteger(lifetimeSeconds) ||
        lifetimeSeconds < 1 ||
        lifetimeSeconds > expiresInSeconds
      ) {
        throw new PrivateStorageError('INVALID_PROVIDER_RESPONSE');
      }
      return {
        url: signed.url,
        expiresAt: signed.expiresAt,
        expiresInSeconds: lifetimeSeconds,
      };
    });
  }

  private resolve(providerId: string): PrivateObjectStorageProvider {
    const provider = this.providers.get(providerId);
    if (!provider) throw new PrivateStorageError('UNKNOWN_STORAGE_PROVIDER');
    return provider;
  }

  private async run<T>(
    providerId: string,
    operation: PrivateStorageOperation,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (cause) {
      const error = this.toStorageError(cause, providerId, operation);
      this.log(error);
      throw error;
    }
  }

  private toStorageError(
    cause: unknown,
    providerId: string,
    operation: PrivateStorageOperation,
  ): PrivateStorageError {
    return cause instanceof PrivateStorageError
      ? cause.withContext(providerId, operation)
      : new PrivateStorageError('STORAGE_UNAVAILABLE', {
          provider: providerId,
          operation,
          cause,
        });
  }

  /** Logs codes and statuses only: never URLs, keys, credentials or bytes. */
  private log(error: PrivateStorageError): void {
    const entry = {
      context: PrivateImageStorageService.name,
      provider: error.provider,
      operation: error.operation,
      code: error.code,
      httpStatus: error.httpStatus,
      retryable: error.retryable,
    };
    if (error.code === 'OBJECT_NOT_FOUND') {
      this.logger.warn('Private image object is missing', entry);
    } else {
      this.logger.error('Private image storage operation failed', entry);
    }
  }
}
