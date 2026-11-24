import { Module } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CreditSettingsController } from './credit-settings.controller';
import { CreditSettingsService } from './credit-settings.service';

/**
 * AI credit management. Currently only the administrator configuration;
 * future balance and charging code should import this module and read the
 * configuration through CreditSettingsService.
 */
@Module({
  controllers: [CreditSettingsController],
  providers: [CreditSettingsService, ActivityLogService, AuthGuard, RolesGuard],
  exports: [CreditSettingsService],
})
export class CreditModule {}
