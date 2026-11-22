import { Module } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ActivityLogService } from '../common/services/activity-log.service';
import { DailyRewardSettingsController } from './daily-reward-settings.controller';
import { DailyRewardSettingsService } from './daily-reward-settings.service';

/**
 * The administrator-managed daily reward configuration (starting reward,
 * daily increment, maximum daily reward) and the fixed 600-credit monthly
 * cap. Configuration only: claiming daily rewards is future work; it reads
 * the settings through DailyRewardSettingsService.getSettings().
 */
@Module({
  controllers: [DailyRewardSettingsController],
  providers: [
    DailyRewardSettingsService,
    ActivityLogService,
    AuthGuard,
    RolesGuard,
  ],
  exports: [DailyRewardSettingsService],
})
export class DailyRewardsModule {}
