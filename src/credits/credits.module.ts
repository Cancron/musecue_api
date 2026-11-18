import { Module } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CreditSettingsController } from './credit-settings.controller';
import { CreditSettingsService } from './credit-settings.service';

/**
 * AI credit management. Currently only the administrator-managed
 * configuration; granting, deducting and enforcing credits are not
 * implemented yet and should read their values from CreditSettingsService.
 */
@Module({
  controllers: [CreditSettingsController],
  providers: [CreditSettingsService, ActivityLogService, AuthGuard, RolesGuard],
  exports: [CreditSettingsService],
})
export class CreditsModule {}
