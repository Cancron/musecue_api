import { Module } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CreditSettingsController } from './credit-settings.controller';
import { CreditSettingsService } from './credit-settings.service';
import { CreditWalletService } from './credit-wallet.service';

/**
 * AI credit management: the administrator-managed configuration
 * (CreditSettingsService) and the persistent wallet and ledger
 * (CreditWalletService). Nothing grants or debits credits yet; future
 * trial, subscription, purchase, referral and AI-usage flows should use
 * CreditWalletService.
 */
@Module({
  controllers: [CreditSettingsController],
  providers: [
    CreditSettingsService,
    CreditWalletService,
    ActivityLogService,
    AuthGuard,
    RolesGuard,
  ],
  exports: [CreditSettingsService, CreditWalletService],
})
export class CreditsModule {}
