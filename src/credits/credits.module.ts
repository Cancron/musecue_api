import { Module } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CreditExpirationSweepService } from './credit-expiration-sweep.service';
import { CreditSettingsController } from './credit-settings.controller';
import { CreditSettingsService } from './credit-settings.service';
import { CreditWalletService } from './credit-wallet.service';

/**
 * AI credit management: the administrator-managed configuration
 * (CreditSettingsService) and the persistent wallet and ledger
 * (CreditWalletService), with a periodic sweep that records expirations
 * (CreditExpirationSweepService). Trial and monthly Pro allowances are
 * granted by SubscriptionModule (CreditEligibilityService); purchases,
 * referrals and AI-usage debits are future work.
 */
@Module({
  controllers: [CreditSettingsController],
  providers: [
    CreditSettingsService,
    CreditWalletService,
    CreditExpirationSweepService,
    ActivityLogService,
    AuthGuard,
    RolesGuard,
  ],
  exports: [CreditSettingsService, CreditWalletService],
})
export class CreditsModule {}
