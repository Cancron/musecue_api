import { Module } from '@nestjs/common';
import { PrivateImageStorageService } from './private-image-storage.service';
import { PrivacyExportStorageService } from './privacy-export-storage.service';

@Module({
  providers: [PrivateImageStorageService, PrivacyExportStorageService],
  exports: [PrivateImageStorageService, PrivacyExportStorageService],
})
export class StorageModule {}
