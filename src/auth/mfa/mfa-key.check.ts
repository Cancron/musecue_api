import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import { PrismaService } from '../../common/services/prisma.service';
import { MFA_ENCRYPTION_KEY_MIN_LENGTH } from './mfa.constants';
import { mfaKeyStatus } from './mfa-keys';

/**
 * Checks MFA_ENCRYPTION_KEY at startup. A key that is set but too short
 * stops the application (a misconfiguration must not silently disable MFA).
 * A missing key is reported: MFA operations then answer 503 and MFA-enabled
 * users cannot complete sign-in until it is configured (MFA is never
 * skipped).
 */
@Injectable()
export class MfaKeyCheck implements OnModuleInit {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    const status = mfaKeyStatus(this.configService);
    if (status === 'TOO_SHORT') {
      throw new Error(
        `MFA_ENCRYPTION_KEY must be at least ${MFA_ENCRYPTION_KEY_MIN_LENGTH} characters`,
      );
    }
    if (status === 'OK') return;
    let enabled = 0;
    try {
      enabled = await this.prisma.authSecurity.count({
        where: { mfaEnabled: true },
      });
    } catch {
      // Reported below without the count.
    }
    const message =
      'MFA_ENCRYPTION_KEY is not set: MFA enrollment and verification are unavailable (503)';
    if (enabled > 0) {
      this.logger.error(
        `${message}; ${enabled} MFA-enabled account(s) cannot complete sign-in`,
        { context: 'MfaKeyCheck' },
      );
    } else {
      this.logger.warn(message, { context: 'MfaKeyCheck' });
    }
  }
}
