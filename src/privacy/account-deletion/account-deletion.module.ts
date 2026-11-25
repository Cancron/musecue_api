import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { QueueModule } from '../../common/modules';
import { StorageModule } from '../../storage/storage.module';
import { AccountDeletionCodeService } from './account-deletion-code.service';
import { AccountDeletionRecoveryService } from './account-deletion-recovery.service';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionService } from './account-deletion.service';
import { StepUpCoreModule } from '../../auth/step-up/step-up-core.module';
import { AccountErasureService } from './account-erasure.service';

@Module({
  // Requesting the deletion requires a step-up approval.
  imports: [AuthModule, QueueModule, StorageModule, StepUpCoreModule],
  controllers: [AccountDeletionController],
  providers: [
    AccountDeletionService,
    AccountDeletionCodeService,
    AccountDeletionRecoveryService,
    AccountErasureService,
    AuthGuard,
  ],
})
export class AccountDeletionModule {}
