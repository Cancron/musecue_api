import { Module } from '@nestjs/common';
import { StepUpGuard } from './step-up.guard';
import { StepUpRepository } from './step-up.repository';

/**
 * The step-up check itself (guard and storage), without the flows that issue
 * approvals, so every feature module can protect its sensitive handlers
 * without depending on the authentication modules.
 */
@Module({
  providers: [StepUpRepository, StepUpGuard],
  exports: [StepUpRepository, StepUpGuard],
})
export class StepUpCoreModule {}
