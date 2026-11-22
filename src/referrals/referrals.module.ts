import { Module } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CreditsModule } from '../credits/credits.module';
import { NotificationsModule } from '../notifications/notifications.module';
import {
  ReferralMilestoneAdminController,
  ReferralReviewAdminController,
} from './referral-admin.controllers';
import { ReferralMilestoneService } from './referral-milestone.service';
import { ReferralRegistrationService } from './referral-registration.service';
import { ReferralReviewService } from './referral-review.service';
import { ReferralRewardService } from './referral-reward.service';
import { ReferralController } from './referral.controller';
import { ReferralService } from './referral.service';

/**
 * Referrals: every user's own referral code, referral registration at
 * signup (used by AuthModule), rewards on the referred user's first
 * verified paying purchase (ReferralRewardService, called by the Stripe
 * webhook in SubscriptionModule) with holds for suspicious referrals and
 * their administrator review, milestones, and the referral APIs.
 */
@Module({
  imports: [CreditsModule, NotificationsModule],
  controllers: [
    ReferralController,
    ReferralMilestoneAdminController,
    ReferralReviewAdminController,
  ],
  providers: [
    ReferralRegistrationService,
    ReferralService,
    ReferralRewardService,
    ReferralMilestoneService,
    ReferralReviewService,
    ActivityLogService,
    AuthGuard,
    RolesGuard,
  ],
  exports: [ReferralRegistrationService, ReferralRewardService],
})
export class ReferralsModule {}
