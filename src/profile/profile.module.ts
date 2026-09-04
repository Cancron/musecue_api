import { Module } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { RedisService } from '../common/services/redis.service';
import { ImageValidationService } from '../makeup/services/image-validation.service';
import { StorageModule } from '../storage/storage.module';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';

@Module({
  imports: [StorageModule],
  controllers: [ProfileController],
  providers: [ProfileService, ImageValidationService, AuthGuard, RedisService],
})
export class ProfileModule {}
