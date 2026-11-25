import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import config from '../config/app.config';

/**
 * Purpose-separated keys derived from JWT_REFRESH_SECRET with HKDF-SHA-256.
 *
 * Every use gets its own key (the purpose is the HKDF `info`), so a value
 * computed for one purpose can never be replayed for another, and no derived
 * key reveals the refresh-token signing secret. Rotating JWT_REFRESH_SECRET
 * invalidates everything derived from it: outstanding codes, OAuth states,
 * rate-limit buckets and queued PostgreSQL job payloads.
 */
export const SECRET_PURPOSES = {
  AUTH_CHALLENGE: 'musecue/auth-challenge-code/v1',
  OAUTH_STATE: 'musecue/oauth-state/v1',
  JOB_PAYLOAD: 'musecue/infrastructure-job-payload/v1',
  RATE_LIMIT_KEY: 'musecue/rate-limit-key/v1',
  // Long-lived authenticator secrets. The root key is MFA_ENCRYPTION_KEY when
  // configured (see MfaSecretCipher), otherwise JWT_REFRESH_SECRET.
  MFA_SECRET: 'musecue/mfa-totp-secret/v1',
} as const;

export type SecretPurpose =
  (typeof SECRET_PURPOSES)[keyof typeof SECRET_PURPOSES];

const HKDF_SALT = 'musecue-derived-secrets';

export class MissingRootSecretError extends Error {
  constructor() {
    super(
      'JWT_REFRESH_SECRET must be configured to protect authentication and queue data',
    );
    this.name = 'MissingRootSecretError';
  }
}

const cache = new Map<string, Buffer>();

/**
 * A 32-byte key for `purpose`. Read on every call (cached per secret), so a
 * changed configuration takes effect without restarting.
 */
export function deriveKey(purpose: SecretPurpose): Buffer {
  const root = config.jwt_refresh_secret;
  if (!root) throw new MissingRootSecretError();
  return deriveKeyFromRoot(root, purpose);
}

/**
 * A 32-byte key for `purpose` derived from an explicit root secret (for data
 * that has its own, separately rotated root key). Cached per root.
 */
export function deriveKeyFromRoot(
  root: string,
  purpose: SecretPurpose,
): Buffer {
  if (!root) throw new MissingRootSecretError();
  const cacheKey = `${purpose}\u0000${root}`;
  let key = cache.get(cacheKey);
  if (!key) {
    key = Buffer.from(hkdfSync('sha256', root, HKDF_SALT, purpose, 32));
    if (cache.size > 32) cache.clear();
    cache.set(cacheKey, key);
  }
  return key;
}

/** HMAC-SHA-256 (hex) of `message` under the key of `purpose`. */
export function keyedHash(purpose: SecretPurpose, message: string): string {
  return createHmac('sha256', deriveKey(purpose))
    .update(message, 'utf8')
    .digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function hexDigestsEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(actual, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

const CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT = 'v1';

export class SecretDecryptionError extends Error {
  constructor() {
    super('Encrypted data could not be decrypted');
    this.name = 'SecretDecryptionError';
  }
}

/**
 * Encrypts `plaintext` with AES-256-GCM under the key of `purpose`. The
 * associated data binds the ciphertext to its record (e.g. a row id), so it
 * cannot be moved to another record. Output: `v1.<iv>.<tag>.<ciphertext>`
 * (base64url).
 */
export function encryptSecret(
  purpose: SecretPurpose,
  plaintext: string,
  associatedData: string,
): string {
  return encryptWithKey(deriveKey(purpose), plaintext, associatedData);
}

/** encryptSecret with an explicit 32-byte key (same output format). */
export function encryptWithKey(
  key: Buffer,
  plaintext: string,
  associatedData: string,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return [
    FORMAT,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** Reverses encryptSecret; throws SecretDecryptionError on any mismatch. */
export function decryptSecret(
  purpose: SecretPurpose,
  encrypted: string,
  associatedData: string,
): string {
  return decryptWithKey(() => deriveKey(purpose), encrypted, associatedData);
}

/**
 * decryptSecret with an explicit key (or a function returning it, read only
 * once the format is known to be valid).
 */
export function decryptWithKey(
  key: Buffer | (() => Buffer),
  encrypted: string,
  associatedData: string,
): string {
  const parts = encrypted.split('.');
  if (parts.length !== 4 || parts[0] !== FORMAT) {
    throw new SecretDecryptionError();
  }
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new SecretDecryptionError();
    }
    const decipher = createDecipheriv(
      CIPHER,
      typeof key === 'function' ? key() : key,
      iv,
      {
        authTagLength: TAG_BYTES,
      },
    );
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    if (error instanceof MissingRootSecretError) throw error;
    throw new SecretDecryptionError();
  }
}
