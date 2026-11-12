import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrivateImageStorageService } from './private-image-storage.service';
import {
  PRIVATE_OBJECT_STORAGE_PROVIDERS,
  type PrivateObjectStorageProvider,
} from './private-object-storage.provider';
import {
  PRIVATE_STORAGE_CONFIG,
  loadPrivateStorageConfig,
  type PrivateStorageConfig,
} from './private-storage.config';
import { LocalFilesystemStorageProvider } from './providers/local-filesystem-storage.provider';
import { SupabaseStorageProvider } from './providers/supabase-storage.provider';

/**
 * Private image storage. To add a backend (e.g. an S3-compatible service),
 * implement `PrivateObjectStorageProvider`, register it below and add it to
 * `PRIVATE_OBJECT_STORAGE_PROVIDERS`; callers and the image flow are unchanged.
 */
@Module({
  providers: [
    {
      provide: PRIVATE_STORAGE_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PrivateStorageConfig =>
        loadPrivateStorageConfig(config),
    },
    {
      provide: SupabaseStorageProvider,
      inject: [PRIVATE_STORAGE_CONFIG],
      useFactory: (config: PrivateStorageConfig) =>
        new SupabaseStorageProvider(config.supabase),
    },
    {
      provide: LocalFilesystemStorageProvider,
      inject: [PRIVATE_STORAGE_CONFIG],
      useFactory: (config: PrivateStorageConfig) =>
        new LocalFilesystemStorageProvider(config.localRoot),
    },
    {
      provide: PRIVATE_OBJECT_STORAGE_PROVIDERS,
      inject: [SupabaseStorageProvider, LocalFilesystemStorageProvider],
      useFactory: (
        ...providers: PrivateObjectStorageProvider[]
      ): PrivateObjectStorageProvider[] => providers,
    },
    PrivateImageStorageService,
  ],
  exports: [PrivateImageStorageService],
})
export class StorageModule {}
