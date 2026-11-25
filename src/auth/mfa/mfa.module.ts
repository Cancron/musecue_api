import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { MfaCredentialsRepository } from './mfa-credentials.repository';
import { MfaEnrollmentRepository } from './mfa-enrollment.repository';
import { MfaRecoveryCodeHasher } from './mfa-recovery-code.hasher';
import { MfaVerificationService } from './mfa-verification.service';
import { MfaSecretCipher } from './mfa-secret.cipher';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';

/** Optional authenticator-app (TOTP) MFA with recovery codes; state lives in PostgreSQL in both infrastructure modes. */
@Module({
  controllers: [MfaController],
  providers: [
    MfaService,
    MfaVerificationService,
    MfaEnrollmentRepository,
    MfaCredentialsRepository,
    MfaSecretCipher,
    MfaRecoveryCodeHasher,
    ActivityLogService,
    AuthGuard,
  ],
  // MfaVerificationService: the second-factor check for a future sign-in step.
  exports: [
    MfaEnrollmentRepository,
    MfaCredentialsRepository,
    MfaSecretCipher,
    MfaVerificationService,
  ],
})
export class MfaModule {}
