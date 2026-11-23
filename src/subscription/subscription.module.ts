import { Module } from '@nestjs/common';
import Stripe from 'stripe';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CreditsModule } from '../credits/credits.module';
import { CreditPackageCheckoutService } from '../credit-packages/purchases/credit-package-checkout.service';
import { CreditPackagePaymentService } from '../credit-packages/purchases/credit-package-payment.service';
import { CreditPackagePurchaseController } from '../credit-packages/purchases/credit-package-purchase.controller';
import { CheckoutDiscountService } from './discounts/checkout-discount.service';
import { ReferralsModule } from '../referrals/referrals.module';
import { CreditAllocationScheduler } from './credit-allocation.scheduler';
import { CreditAllowanceService } from './credit-allowance.service';
import { CreditEligibilityService } from './credit-eligibility.service';
import { ProAccessGuard } from './pro-access.guard';
import { SubscriptionAccessService } from './subscription-access.service';
import { SubscriptionBillingService } from './subscription-billing.service';
import { SubscriptionPlanController } from './subscription-plan.controller';
import { SubscriptionPlanService } from './subscription-plan.service';
import { SubscriptionTrialService } from './subscription-trial.service';
import { SubscriptionController } from './subscription.controller';
import { StripeCancellationService } from './stripe/stripe-cancellation.service';
import { StripeCheckoutService } from './stripe/stripe-checkout.service';
import { StripeRefundService } from './stripe/stripe-refund.service';
import { StripeWebhookController } from './stripe/stripe-webhook.controller';
import { StripeWebhookService } from './stripe/stripe-webhook.service';
import {
  readStripeSettings,
  STRIPE_SETTINGS,
  type StripeSettings,
} from './stripe/stripe.config';
import { STRIPE_CLIENT, StripeGateway } from './stripe/stripe.gateway';

@Module({
  // Credit wallet and settings: allowances and POST /v1/sessions eligibility.
  // Referrals: rewards with the verified payments recorded by the webhook.
  // Credit package purchases share the Stripe checkout, discounts and
  // webhook (src/credit-packages/purchases; the packages themselves are
  // configured through CreditPackagesModule).
  imports: [CreditsModule, ReferralsModule],
  controllers: [
    SubscriptionPlanController,
    SubscriptionController,
    StripeWebhookController,
    CreditPackagePurchaseController,
  ],
  providers: [
    SubscriptionPlanService,
    SubscriptionAccessService,
    SubscriptionBillingService,
    SubscriptionTrialService,
    CreditEligibilityService,
    CreditAllowanceService,
    CreditAllocationScheduler,
    ActivityLogService,
    AuthGuard,
    RolesGuard,
    ProAccessGuard,
    // Stripe checkout and webhooks (see src/subscription/stripe).
    {
      provide: STRIPE_SETTINGS,
      useFactory: (): StripeSettings => readStripeSettings(process.env),
    },
    {
      provide: STRIPE_CLIENT,
      inject: [STRIPE_SETTINGS],
      useFactory: (settings: StripeSettings): Stripe | null =>
        settings.secretKey
          ? new Stripe(settings.secretKey, {
              maxNetworkRetries: 2,
              timeout: 20_000,
              appInfo: { name: 'MuseCue API' },
            })
          : null,
    },
    StripeGateway,
    CheckoutDiscountService,
    StripeCheckoutService,
    StripeCancellationService,
    StripeRefundService,
    StripeWebhookService,
    CreditPackageCheckoutService,
    CreditPackagePaymentService,
  ],
  // Modules with Pro feature endpoints import SubscriptionModule and use
  // @UseGuards(AuthGuard, ProAccessGuard), adding @RequireCredits() where
  // credits (rather than Pro) are required.
  exports: [
    SubscriptionAccessService,
    CreditEligibilityService,
    ProAccessGuard,
  ],
})
export class SubscriptionModule {}
