import { Module } from '@nestjs/common';
import { AuthModule } from '../auth.module';
import { AuthGuard } from '../../common/guards/auth.guard';
import { MfaModule } from '../mfa/mfa.module';
import { StepUpCoreModule } from './step-up-core.module';
import { StepUpController } from './step-up.controller';
import { StepUpService } from './step-up.service';

/**
 * Issuing step-up approvals (/v1/auth/step-up). The check itself lives in
 * StepUpCoreModule, imported by every module with sensitive actions.
 */
@Module({
  imports: [AuthModule, MfaModule, StepUpCoreModule],
  controllers: [StepUpController],
  providers: [StepUpService, AuthGuard],
})
export class StepUpModule {}
