import { Module } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CreditPackageSettingsController } from './credit-package-settings.controller';
import { CreditPackageSettingsService } from './credit-package-settings.service';

/**
 * The administrator-managed credit packages (credits, USD price in cents,
 * availability). Configuration only: buying packages is future work; it
 * reads them through CreditPackageSettingsService.
 */
@Module({
  controllers: [CreditPackageSettingsController],
  providers: [
    CreditPackageSettingsService,
    ActivityLogService,
    AuthGuard,
    RolesGuard,
  ],
  exports: [CreditPackageSettingsService],
})
export class CreditPackagesModule {}
