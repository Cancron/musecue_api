import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthUtilsService } from './services/auth-utils.service';
import { GoogleOAuthService } from './services/google-oauth.service';
import { ActivityLogService } from '../common/services/activity-log.service';
import { EmailService } from '../common/services/email.service';
import { QueueModule } from '../common/modules';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthChallengeRepository } from './state/auth-challenge.repository';
import { AuthStateCleanupService } from './state/auth-state-cleanup.service';
import { OAuthStateRepository } from './state/oauth-state.repository';
import { RefreshSessionRepository } from './state/refresh-session.repository';
import { MfaModule } from './mfa/mfa.module';
import { StepUpCoreModule } from './step-up/step-up-core.module';

@Module({
  // MfaModule: optional authenticator MFA (/v1/auth/mfa); its stale
  // enrollments are removed by AuthStateCleanupService.
  // StepUpCoreModule: the Google callback forwards step-up re-authentications.
  imports: [QueueModule, MfaModule, StepUpCoreModule],
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
