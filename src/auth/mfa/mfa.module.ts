import { Logger, Module } from '@nestjs/common';
import { QueueModule } from '../../common/modules';
import { MfaSecurityNotifier } from './mfa-security-notifier';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { loadMfaKeyring, MFA_ENCRYPTION_KEY_ENV } from './mfa-keys';
import { MfaLoginService } from './mfa-login.service';
import { MFA_KEYRING, MfaSecretCipher } from './mfa-secret.cipher';
import { MfaVerificationService } from './mfa-verification.service';
import { MfaController } from './mfa.controller';
import { MfaRepository } from './mfa.repository';
import { MfaService } from './mfa.service';
import { RefreshSessionRepository } from '../state/refresh-session.repository';
import { SecurityEventLog } from '../security-events/security-event.log';
import { StepUpGuard } from '../step-up/step-up.guard';
import {
  MfaSmsController,
  MfaSmsSignInController,
} from './sms/mfa-sms.controller';
import { MfaSmsRepository } from './sms/mfa-sms.repository';
import { MfaSmsService } from './sms/mfa-sms.service';
import { MFA_SMS_SERVICE } from './sms/mfa-sms.tokens';
import { createSmsSender, SMS_SENDER } from './sms/sms-sender';

/**
 * Optional MFA of the signed-in user (authenticator app, recovery codes,
 * trusted devices, SMS sign-in codes) and the MFA step of sign-in.
 */
@Module({
  imports: [QueueModule],
  controllers: [MfaController, MfaSmsController, MfaSmsSignInController],
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
    {
      provide: SMS_SENDER,
      // Read once at startup: an invalid configuration stops the
      // application; without a provider SMS answers 503.
      useFactory: () => {
        const sender = createSmsSender(process.env);
        if (!sender.configured) {
          new Logger('MfaSms').log(
            'SMS_PROVIDER is disabled: SMS sign-in codes are unavailable',
          );
        }
        return sender;
      },
    },
    MfaSecretCipher,
    MfaSecurityNotifier,
    MfaSmsRepository,
    MfaSmsService,
    { provide: MFA_SMS_SERVICE, useExisting: MfaSmsService },
    MfaService,
    MfaVerificationService,
    MfaLoginService,
    MfaRepository,
    ActivityLogService,
    AuthGuard,
    StepUpGuard,
    // Stateless, PrismaService only (also provided by AuthModule, which
    // imports this module).
    RefreshSessionRepository,
    SecurityEventLog,
  ],
  exports: [
    MfaRepository,
    MfaVerificationService,
    MfaLoginService,
    MfaSmsService,
  ],
})
export class MfaModule {}
