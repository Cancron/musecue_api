import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { MfaCredentialsRepository } from './mfa-credentials.repository';
import { MfaEnrollmentRepository } from './mfa-enrollment.repository';
import { MfaKeyCheck } from './mfa-key.check';
import { MfaLoginRepository } from './mfa-login.repository';
import { MfaLoginService } from './mfa-login.service';
import { MfaRecoveryCodeHasher } from './mfa-recovery-code.hasher';
import { MfaVerificationService } from './mfa-verification.service';
import { MfaSecretCipher } from './mfa-secret.cipher';
import { StepUpCoreModule } from '../step-up/step-up-core.module';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';

/** Optional authenticator-app (TOTP) MFA with recovery codes; state lives in PostgreSQL in both infrastructure modes. */
@Module({
  // Sensitive MFA changes require a step-up approval.
  imports: [StepUpCoreModule],
  controllers: [MfaController],
  providers: [
    MfaService,
    MfaVerificationService,
    MfaLoginService,
    MfaLoginRepository,
    MfaKeyCheck,
    MfaEnrollmentRepository,
    MfaCredentialsRepository,
    MfaSecretCipher,
    MfaRecoveryCodeHasher,
    ActivityLogService,
    AuthGuard,
  ],
  // MfaLoginService: the second step of password and Google sign-in.
  exports: [
    MfaEnrollmentRepository,
    MfaCredentialsRepository,
    MfaLoginRepository,
    MfaSecretCipher,
    MfaVerificationService,
    MfaLoginService,
  ],
})
export class MfaModule {}
