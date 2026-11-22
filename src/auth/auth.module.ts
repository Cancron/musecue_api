import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthUtilsService } from './services/auth-utils.service';
import { GoogleOAuthService } from './services/google-oauth.service';
import { ActivityLogService } from '../common/services/activity-log.service';
import { EmailService } from '../common/services/email.service';
import { QueueModule } from '../common/modules';
import { ReferralsModule } from '../referrals/referrals.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthChallengeRepository } from './state/auth-challenge.repository';
import { AuthStateCleanupService } from './state/auth-state-cleanup.service';
import { OAuthStateRepository } from './state/oauth-state.repository';
import { RefreshSessionRepository } from './state/refresh-session.repository';

@Module({
  // Referral codes given at signup are registered with the new account.
  // Security events create notifications.
  imports: [QueueModule, ReferralsModule, NotificationsModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthUtilsService,
    GoogleOAuthService,
    ActivityLogService,
    EmailService,
    AuthGuard,
    // Authentication security state lives in PostgreSQL in both
    // infrastructure modes.
    RefreshSessionRepository,
    AuthChallengeRepository,
    OAuthStateRepository,
    AuthStateCleanupService,
  ],
  exports: [
    AuthService,
    AuthUtilsService,
    GoogleOAuthService,
    AuthChallengeRepository,
  ],
})
export class AuthModule {}
