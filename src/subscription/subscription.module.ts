import { Module } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ActivityLogService } from '../common/services/activity-log.service';
import { RedisService } from '../common/services/redis.service';
import { ProAccessGuard } from './pro-access.guard';
import { SubscriptionAccessService } from './subscription-access.service';
import { SubscriptionPlanController } from './subscription-plan.controller';
import { SubscriptionPlanService } from './subscription-plan.service';
import { SubscriptionTrialService } from './subscription-trial.service';
import { SubscriptionController } from './subscription.controller';

@Module({
  controllers: [SubscriptionPlanController, SubscriptionController],
  providers: [
    SubscriptionPlanService,
    SubscriptionAccessService,
    SubscriptionTrialService,
    ActivityLogService,
    AuthGuard,
    RolesGuard,
    ProAccessGuard,
    RedisService,
  ],
  // Modules with Pro feature endpoints import SubscriptionModule and use
  // @UseGuards(AuthGuard, ProAccessGuard).
  exports: [SubscriptionAccessService, ProAccessGuard],
})
export class SubscriptionModule {}
