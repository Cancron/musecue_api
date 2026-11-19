import { Logger, Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { loadMfaKeyring, MFA_ENCRYPTION_KEY_ENV } from './mfa-keys';
import { MfaLoginService } from './mfa-login.service';
import { MFA_KEYRING, MfaSecretCipher } from './mfa-secret.cipher';
import { MfaVerificationService } from './mfa-verification.service';
import { MfaController } from './mfa.controller';
import { MfaRepository } from './mfa.repository';
import { MfaService } from './mfa.service';

/**
 * Optional MFA of the signed-in user (authenticator app, recovery codes,
 * trusted devices) and the MFA step of sign-in.
 */
@Module({
  controllers: [MfaController],
  providers: [
    {
      provide: MFA_KEYRING,
      // Read once at startup: an invalid key stops the application; a
      // missing one disables what needs it (503) and is reported here.
      useFactory: () => {
        const keyring = loadMfaKeyring(process.env);
        if (!keyring.currentKeyId) {
          new Logger('MfaKeys').warn(
            `${MFA_ENCRYPTION_KEY_ENV} is not set: MFA enrollment and authenticator codes are unavailable (recovery codes still work)`,
          );
        }
        return keyring;
      },
    },
    MfaSecretCipher,
    MfaService,
    MfaVerificationService,
    MfaLoginService,
    MfaRepository,
    ActivityLogService,
    AuthGuard,
  ],
  exports: [MfaRepository, MfaVerificationService, MfaLoginService],
})
export class MfaModule {}
