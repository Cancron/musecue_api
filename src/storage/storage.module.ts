import { Module } from '@nestjs/common';
import { PrivateImageStorageService } from './private-image-storage.service';

@Module({
  providers: [PrivateImageStorageService],
  exports: [PrivateImageStorageService],
})
export class StorageModule {}
