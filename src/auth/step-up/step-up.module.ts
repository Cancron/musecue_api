import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AuthModule } from '../auth.module';
import { MfaModule } from '../mfa/mfa.module';
import { StepUpController } from './step-up.controller';
import { StepUpService } from './step-up.service';

/**
 * Issues step-up approvals. Routes that require one use @RequireStepUp and
 * provide StepUpGuard in their own module (it needs only PrismaService).
 */
@Module({
  imports: [AuthModule, MfaModule],
  controllers: [StepUpController],
  providers: [StepUpService, AuthGuard],
})
export class StepUpModule {}
