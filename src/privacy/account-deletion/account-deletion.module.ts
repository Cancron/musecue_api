import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { QueueModule } from '../../common/modules';
import { RedisService } from '../../common/services/redis.service';
import { AccountDeletionCodeService } from './account-deletion-code.service';
import { AccountDeletionRecoveryService } from './account-deletion-recovery.service';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionService } from './account-deletion.service';

@Module({
  imports: [AuthModule, QueueModule],
  controllers: [AccountDeletionController],
  providers: [
    AccountDeletionService,
    AccountDeletionCodeService,
    AccountDeletionRecoveryService,
    AuthGuard,
    RedisService,
  ],
})
export class AccountDeletionModule {}
