import { Module } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ActivityLogService } from '../common/services/activity-log.service';
import { DiscountSettingsController } from './discount-settings.controller';
import { DiscountSettingsService } from './discount-settings.service';

/**
 * The administrator-managed discount and referral configuration
 * (first-purchase discount, referral discount, referrer reward credits).
 * Configuration only: applying discounts at checkout and granting referral
 * rewards are future work; they read the settings through
 * DiscountSettingsService.getSettings().
 */
@Module({
  controllers: [DiscountSettingsController],
  providers: [
    DiscountSettingsService,
    ActivityLogService,
    AuthGuard,
    RolesGuard,
  ],
  exports: [DiscountSettingsService],
})
export class DiscountsModule {}
