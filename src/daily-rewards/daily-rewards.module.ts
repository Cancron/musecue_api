import { Module } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CreditAccountModule } from '../credits/account/credit-account.module';
import { CreditsModule } from '../credits/credits.module';
import { DailyRewardClaimService } from './daily-reward-claim.service';
import { DailyRewardController } from './daily-reward.controller';
import { DailyRewardSettingsController } from './daily-reward-settings.controller';
import { DailyRewardSettingsService } from './daily-reward-settings.service';

/**
 * Daily rewards: the administrator-managed configuration (starting reward,
 * daily increment, maximum daily reward) and the users' daily claims,
 * granted as DAILY_REWARD credits through CreditWalletService, with the
 * fixed cap of 600 daily reward credits per user and UTC calendar month.
 */
@Module({
  imports: [CreditsModule, CreditAccountModule],
  controllers: [DailyRewardSettingsController, DailyRewardController],
  providers: [
    DailyRewardSettingsService,
    DailyRewardClaimService,
    ActivityLogService,
    AuthGuard,
    RolesGuard,
  ],
  exports: [DailyRewardSettingsService],
})
export class DailyRewardsModule {}
