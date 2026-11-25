import { Module } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CreditSettingsController } from './credit-settings.controller';
import { CreditExpirySweepService } from './credit-expiry-sweep.service';
import { CreditSettingsService } from './credit-settings.service';
import { CreditWalletService } from './credit-wallet.service';

/**
 * AI credit management: the administrator configuration and the persistent
 * wallet/ledger foundation. Code that grants or charges credits should
 * import this module and use CreditWalletService.
 */
@Module({
  controllers: [CreditSettingsController],
  providers: [
    CreditSettingsService,
    CreditWalletService,
    CreditExpirySweepService,
    ActivityLogService,
    AuthGuard,
    RolesGuard,
  ],
  exports: [CreditSettingsService, CreditWalletService],
})
export class CreditModule {}
