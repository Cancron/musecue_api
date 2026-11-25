import type { ConfigService } from '@nestjs/config';
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
    super('MFA_ENCRYPTION_KEY is not configured');
    this.name = 'MfaEncryptionUnavailableError';
  }
}

/** Whether MFA_ENCRYPTION_KEY is set, and long enough. */
export function mfaKeyStatus(
  configService: ConfigService,
): 'MISSING' | 'TOO_SHORT' | 'OK' {
  const key = configService.get<string>(MFA_ENCRYPTION_KEY_ENV);
  if (!key) return 'MISSING';
  return key.length < MFA_ENCRYPTION_KEY_MIN_LENGTH ? 'TOO_SHORT' : 'OK';
}

/**
 * A key for one MFA purpose (secret encryption, recovery-code hashing),
 * derived with HKDF only from MFA_ENCRYPTION_KEY (at least 32 characters).
 * It deliberately never falls back to the JWT secrets: those can be rotated
 * at any time, while stored authenticator secrets and recovery-code hashes
 * must stay usable. Without the key, MFA operations fail closed (503);
 * changing it makes stored secrets unreadable and recovery codes unusable.
 */
export function mfaKey(
  configService: ConfigService,
  purpose: SecretPurpose,
): Buffer {
  if (mfaKeyStatus(configService) !== 'OK') {
    throw new MfaEncryptionUnavailableError();
  }
  return deriveKeyFromRoot(
    configService.get<string>(MFA_ENCRYPTION_KEY_ENV) as string,
    purpose,
  );
}
