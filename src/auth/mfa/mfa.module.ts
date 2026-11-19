import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { MfaEnrollmentRepository } from './mfa-enrollment.repository';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';

/** Optional MFA (authenticator app, TOTP) of the signed-in user. */
@Module({
  controllers: [MfaController],
  providers: [
    MfaService,
    MfaEnrollmentRepository,
    ActivityLogService,
    AuthGuard,
  ],
  exports: [MfaEnrollmentRepository],
})
export class MfaModule {}
