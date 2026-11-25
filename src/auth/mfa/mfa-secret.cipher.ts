import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  decryptWithKey,
  encryptWithKey,
  SECRET_PURPOSES,
} from '../../common/security/derived-secrets';
import { MfaEncryptionUnavailableError, mfaKey } from './mfa-keys';

export { MfaEncryptionUnavailableError };

/**
 * Where an encrypted authenticator secret is stored. Part of the associated
 * data, so a pending secret cannot be copied into the confirmed column (or
 * back) without failing authentication.
 */
export type MfaSecretSlot = 'enrollment' | 'active';

/**
 * Encrypts authenticator (TOTP) secrets for PostgreSQL with AES-256-GCM.
 *
 * The key is derived with HKDF from MFA_ENCRYPTION_KEY (at least 32
 * characters) when configured, otherwise from JWT_REFRESH_SECRET, under an
 * MFA-specific purpose. Each ciphertext is bound to its user and slot, so it
 * cannot be moved to another account. Changing the root key makes stored
 * secrets unreadable (affected users must enroll again).
 */
@Injectable()
export class MfaSecretCipher {
  constructor(private readonly configService: ConfigService) {}

  encrypt(authId: string, slot: MfaSecretSlot, secret: string): string {
    return encryptWithKey(this.key(), secret, this.aad(authId, slot));
  }

  /** Throws SecretDecryptionError when the value was not encrypted for this user and slot. */
  decrypt(authId: string, slot: MfaSecretSlot, encrypted: string): string {
    return decryptWithKey(() => this.key(), encrypted, this.aad(authId, slot));
  }

  private aad(authId: string, slot: MfaSecretSlot): string {
    return `musecue:mfa-totp:${slot}:${authId}`;
  }

  private key(): Buffer {
    return mfaKey(this.configService, SECRET_PURPOSES.MFA_SECRET);
  }
}
