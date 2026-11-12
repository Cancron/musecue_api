import { Inject, Injectable } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import {
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
import {
  assertValidPrivateImageKey,
  buildPrivateImageKey,
  type SupportedImageMime,
} from './private-storage-key';

export type { PrivateObjectRef } from './private-object-storage.provider';
export type { SupportedImageMime } from './private-storage-key';

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
    @Inject(PRIVATE_STORAGE_CONFIG) config: PrivateStorageConfig,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {
    const registry = new Map<string, PrivateObjectStorageProvider>();
    for (const provider of providers) {
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

  /** Provider id used for new uploads. */
  get activeProviderId(): string {
    return this.activeProvider.id;
  }

  /** Stores a new private image and returns where it was written. */
  async save(
    authId: string,
    scopeId: string,
    mimeType: SupportedImageMime,
    bytes: Buffer,
  ): Promise<PrivateObjectRef> {
    const provider = this.activeProvider;
    return this.run(provider.id, 'put', async () => {
      const key = buildPrivateImageKey(authId, scopeId, mimeType);
      await provider.put(key, bytes, mimeType);
      return { provider: provider.id, key };
    });
  }

  read(ref: PrivateObjectRef): Promise<Buffer> {
    return this.run(ref.provider, 'get', () => {
      assertValidPrivateImageKey(ref.key);
      return this.resolve(ref.provider).get(ref.key);
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
   * Cleanup that must not mask the caller's outcome (rollback after a failed
   * database write, or removing replaced/deleted images after a commit).
   * Failures are logged with the key so orphaned objects can be removed.
   */
  async deleteQuietly(ref: PrivateObjectRef, reason: string): Promise<boolean> {
    try {
      await this.delete(ref);
      return true;
    } catch (error) {
      // The key (opaque ids only) is logged so operators can remove the orphan.
      this.logger.warn('Private image cleanup failed; object may be orphaned', {
        context: PrivateImageStorageService.name,
        reason,
        provider: ref.provider,
        storageKey: ref.key,
        code: error instanceof PrivateStorageError ? error.code : undefined,
      });
      return false;
    }
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
      const error =
        cause instanceof PrivateStorageError
          ? cause.withContext(providerId, operation)
          : new PrivateStorageError('STORAGE_UNAVAILABLE', {
              provider: providerId,
              operation,
              cause,
            });
      this.log(error);
      throw error;
    }
  }

  /** Logs codes and statuses only: never URLs, credentials or image bytes. */
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
