import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { MfaEnrollmentRepository } from './mfa-enrollment.repository';
import { MfaSecretCipher } from './mfa-secret.cipher';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';

/** Optional authenticator-app (TOTP) MFA; state lives in PostgreSQL in both infrastructure modes. */
@Module({
  controllers: [MfaController],
  providers: [
    MfaService,
    MfaEnrollmentRepository,
    MfaSecretCipher,
    ActivityLogService,
    AuthGuard,
  ],
  exports: [MfaEnrollmentRepository, MfaSecretCipher],
})
export class MfaModule {}
