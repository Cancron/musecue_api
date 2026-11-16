import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { QueueModule } from '../../common/modules';
import { StorageModule } from '../../storage/storage.module';
import { RedisService } from '../../common/services/redis.service';
import { AccountDeletionCodeService } from './account-deletion-code.service';
import { AccountDeletionRecoveryService } from './account-deletion-recovery.service';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionService } from './account-deletion.service';
import { AccountErasureService } from './account-erasure.service';

@Module({
  imports: [AuthModule, QueueModule, StorageModule],
  controllers: [AccountDeletionController],
  providers: [
    AccountDeletionService,
    AccountDeletionCodeService,
    AccountDeletionRecoveryService,
    AccountErasureService,
    AuthGuard,
    RedisService,
  ],
})
export class AccountDeletionModule {}
