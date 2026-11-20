import { Inject, Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { type MfaKeyring } from './mfa-keys';

/**
 * Encryption of TOTP secrets at rest with AES-256-GCM under the dedicated
 * MFA key (MFA_ENCRYPTION_KEY), never a JWT secret. The associated data
 * binds a ciphertext to its user and to its role, so a stored secret cannot
 * be copied to another account, and a pending enrollment secret cannot be
 * passed off as a confirmed one (or the reverse).
 *
 * Format: `mfa2.<keyId>.<iv>.<tag>.<ciphertext>` (base64url parts). The key
 * ID selects the key among MFA_ENCRYPTION_KEY and
 * MFA_ENCRYPTION_PREVIOUS_KEYS.
 */
export type MfaSecretRole = 'enrollment' | 'confirmed' | 'phone';

export const MFA_KEYRING = Symbol('MFA_KEYRING');

const FORMAT = 'mfa2';
/** Format written by the first MFA build (key derived from JWT_REFRESH_SECRET). */
const LEGACY_FORMAT = 'v1';
const CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HKDF_SALT = 'musecue-mfa-key';
const HKDF_INFO = 'musecue/mfa-totp-secret/v2';
const MAC_INFO = 'musecue/mfa-sms-code/v1';

/** MFA_ENCRYPTION_KEY is not configured. */
export class MfaKeyUnavailableError extends Error {
  constructor() {
    super('MFA_ENCRYPTION_KEY is not configured');
    this.name = 'MfaKeyUnavailableError';
  }
}

/** Wrong key, wrong binding, tampering, or a key that is no longer configured. */
export class MfaSecretDecryptionError extends Error {
  constructor(message = 'MFA secret could not be decrypted') {
    super(message);
    this.name = 'MfaSecretDecryptionError';
  }
}

/** A secret still encrypted by the first MFA build: run `npm run mfa:rekey`. */
export class LegacyMfaSecretError extends MfaSecretDecryptionError {
  constructor() {
    super(
      'MFA secret uses the legacy key derived from JWT_REFRESH_SECRET; run npm run mfa:rekey',
    );
    this.name = 'LegacyMfaSecretError';
  }
}

const associatedData = (role: MfaSecretRole, authId: string) =>
  Buffer.from(`mfa-totp-secret\u0000${role}\u0000${authId}`, 'utf8');

function deriveEncryptionKey(masterKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, HKDF_SALT, HKDF_INFO, 32));
}

@Injectable()
export class MfaSecretCipher {
  private readonly keys = new Map<string, Buffer>();

  constructor(@Inject(MFA_KEYRING) private readonly keyring: MfaKeyring) {
    for (const [id, key] of keyring.keys) {
      this.keys.set(id, deriveEncryptionKey(key));
    }
  }

  /** Whether new secrets can be encrypted (MFA_ENCRYPTION_KEY is set). */
  get available(): boolean {
    return this.keyring.currentKeyId !== null;
  }

  encrypt(role: MfaSecretRole, authId: string, secret: string): string {
    const keyId = this.keyring.currentKeyId;
    const key = keyId ? this.keys.get(keyId) : undefined;
    if (!keyId || !key) throw new MfaKeyUnavailableError();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(CIPHER, key, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(associatedData(role, authId));
    const ciphertext = Buffer.concat([
      cipher.update(secret, 'utf8'),
      cipher.final(),
    ]);
    return [
      FORMAT,
      keyId,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(role: MfaSecretRole, authId: string, encrypted: string): string {
    const parts = encrypted.split('.');
    if (parts[0] === LEGACY_FORMAT) throw new LegacyMfaSecretError();
    if (parts.length !== 5 || parts[0] !== FORMAT) {
      throw new MfaSecretDecryptionError();
    }
    const key = this.keys.get(parts[1]);
    if (!key) {
      if (!this.available) throw new MfaKeyUnavailableError();
      throw new MfaSecretDecryptionError(
        'MFA secret was encrypted with a key that is no longer configured',
      );
    }
    return decryptWith(key, parts[2], parts[3], parts[4], role, authId);
  }

  /**
   * HMAC-SHA256 (hex) of `data` under a key derived from the current
   * MFA_ENCRYPTION_KEY (for one-time SMS codes: a stolen database alone
   * cannot test guesses). Throws MfaKeyUnavailableError without a key.
   */
  mac(data: string): string {
    const keyId = this.keyring.currentKeyId;
    const master = keyId ? this.keyring.keys.get(keyId) : undefined;
    if (!master) throw new MfaKeyUnavailableError();
    const key = Buffer.from(
      hkdfSync('sha256', master, HKDF_SALT, MAC_INFO, 32),
    );
    return createHmac('sha256', key).update(data, 'utf8').digest('hex');
  }

  /** True when `encrypted` uses an older key and should be re-encrypted. */
  needsReencryption(encrypted: string): boolean {
    const parts = encrypted.split('.');
    return (
      this.available &&
      parts[0] === FORMAT &&
      parts[1] !== this.keyring.currentKeyId
    );
  }
}

function decryptWith(
  key: Buffer,
  ivPart: string,
  tagPart: string,
  bodyPart: string,
  role: MfaSecretRole,
  authId: string,
): string {
  try {
    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new MfaSecretDecryptionError();
    }
    const decipher = createDecipheriv(CIPHER, key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(associatedData(role, authId));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(bodyPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new MfaSecretDecryptionError();
  }
}

/**
 * Only for `npm run mfa:rekey`: reads a secret written by the first MFA
 * build (`v1.`, key derived from JWT_REFRESH_SECRET with HKDF), so it can be
 * re-encrypted with MFA_ENCRYPTION_KEY. The application never calls it.
 */
export function decryptLegacyMfaSecret(
  jwtRefreshSecret: string,
  role: MfaSecretRole,
  authId: string,
  encrypted: string,
): string {
  const parts = encrypted.split('.');
  if (parts.length !== 4 || parts[0] !== LEGACY_FORMAT) {
    throw new MfaSecretDecryptionError('Not a legacy MFA secret');
  }
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      jwtRefreshSecret,
      'musecue-derived-secrets',
      'musecue/mfa-totp-secret/v1',
      32,
    ),
  );
  return decryptWith(key, parts[1], parts[2], parts[3], role, authId);
}

export function isLegacyMfaSecret(encrypted: string): boolean {
  return encrypted.startsWith(`${LEGACY_FORMAT}.`);
}
