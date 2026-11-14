import { Module } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ActivityLogService } from '../common/services/activity-log.service';
import { RedisService } from '../common/services/redis.service';
import { CheckoutService } from './checkout.service';
import { ProAccessGuard } from './pro-access.guard';
import { StripeClientService } from './stripe/stripe-client.service';
import { StripeWebhookController } from './stripe/stripe-webhook.controller';
import { StripeWebhookService } from './stripe/stripe-webhook.service';
import { SubscriptionAccessService } from './subscription-access.service';
import { SubscriptionPlanController } from './subscription-plan.controller';
import { SubscriptionPlanService } from './subscription-plan.service';
import { SubscriptionTrialService } from './subscription-trial.service';
import { SubscriptionController } from './subscription.controller';

@Module({
  controllers: [
    SubscriptionPlanController,
    SubscriptionController,
    StripeWebhookController,
  ],
  providers: [
    SubscriptionPlanService,
    SubscriptionAccessService,
    SubscriptionTrialService,
    CheckoutService,
    StripeClientService,
    StripeWebhookService,
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
