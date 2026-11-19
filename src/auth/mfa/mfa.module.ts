import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { MfaVerificationService } from './mfa-verification.service';
import { MfaRepository } from './mfa.repository';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';

/** Optional MFA (authenticator app, TOTP, recovery codes) of the signed-in user. */
@Module({
  controllers: [MfaController],
  providers: [
    MfaService,
    MfaVerificationService,
    MfaRepository,
    ActivityLogService,
    AuthGuard,
  ],
  exports: [MfaRepository, MfaVerificationService],
})
export class MfaModule {}
