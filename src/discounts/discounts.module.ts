import { Module } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CreditPackagesModule } from '../credit-packages/credit-packages.module';
import {
  DiscountCampaignsAdminController,
  DiscountCodesAdminController,
} from './discount-offer-admin.controllers';
import { DiscountOfferAdminService } from './discount-offer-admin.service';
import { DiscountRedemptionController } from './discount-redemption.controller';
import { DiscountRedemptionService } from './discount-redemption.service';
import { DiscountSettingsController } from './discount-settings.controller';
import { DiscountSettingsService } from './discount-settings.service';

/**
 * Discounts: the administrator-managed discount and referral settings
 * (first-purchase discount, referral discount, referrer reward credits),
 * discount codes and promotional campaigns (DiscountOfferAdminService), and
 * their redemption by users for a configured credit package
 * (DiscountRedemptionService). Charging the discounted price at checkout is
 * future work; it reads the redemption.
 */
@Module({
  imports: [CreditPackagesModule],
  controllers: [
    DiscountSettingsController,
    DiscountCodesAdminController,
    DiscountCampaignsAdminController,
    DiscountRedemptionController,
  ],
  providers: [
    DiscountSettingsService,
    DiscountOfferAdminService,
    DiscountRedemptionService,
    ActivityLogService,
    AuthGuard,
    RolesGuard,
  ],
  exports: [DiscountSettingsService, DiscountRedemptionService],
})
export class DiscountsModule {}
