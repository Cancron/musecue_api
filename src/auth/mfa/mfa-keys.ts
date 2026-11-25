import type { ConfigService } from '@nestjs/config';
import config from '../../common/config/app.config';
import {
  deriveKeyFromRoot,
  type SecretPurpose,
} from '../../common/security/derived-secrets';
import {
  MFA_ENCRYPTION_KEY_ENV,
  MFA_ENCRYPTION_KEY_MIN_LENGTH,
} from './mfa.constants';

/** No usable key: MFA operations fail closed (never store plaintext). */
export class MfaEncryptionUnavailableError extends Error {
  constructor() {
    super('MFA secret encryption is not configured');
    this.name = 'MfaEncryptionUnavailableError';
  }
}

/**
 * A key for one MFA purpose (secret encryption, recovery-code hashing),
 * derived with HKDF from MFA_ENCRYPTION_KEY (at least 32 characters) when
 * configured, otherwise from JWT_REFRESH_SECRET. Changing the root key makes
 * stored MFA secrets unreadable and recovery codes unusable.
 */
export function mfaKey(
  configService: ConfigService,
  purpose: SecretPurpose,
): Buffer {
  const dedicated = configService.get<string>(MFA_ENCRYPTION_KEY_ENV);
  if (dedicated) {
    if (dedicated.length < MFA_ENCRYPTION_KEY_MIN_LENGTH) {
      throw new MfaEncryptionUnavailableError();
    }
    return deriveKeyFromRoot(dedicated, purpose);
  }
  if (!config.jwt_refresh_secret) throw new MfaEncryptionUnavailableError();
  return deriveKeyFromRoot(config.jwt_refresh_secret, purpose);
}
