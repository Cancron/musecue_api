import { Module } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { ReferralRegistrationService } from './referral-registration.service';
import { ReferralController } from './referral.controller';
import { ReferralService } from './referral.service';

/**
 * Referrals: every user's own referral code, referral registration at
 * signup (used by AuthModule) and the referral APIs. Rewards are granted by
 * ReferralRewardService (SubscriptionModule) with the referred user's first
 * verified paying purchase.
 */
@Module({
  controllers: [ReferralController],
  providers: [ReferralRegistrationService, ReferralService, AuthGuard],
  exports: [ReferralRegistrationService],
})
export class ReferralsModule {}
