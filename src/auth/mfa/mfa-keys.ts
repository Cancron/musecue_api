import { createHash } from 'node:crypto';

/**
 * The dedicated encryption key(s) of MFA authenticator secrets. They are
 * independent of every JWT secret: rotating JWT_ACCESS_SECRET or
 * JWT_REFRESH_SECRET never affects MFA.
 *
 * - MFA_ENCRYPTION_KEY: the current key (32 random bytes, as 64 hex
 *   characters or base64/base64url). New secrets are encrypted with it.
 * - MFA_ENCRYPTION_PREVIOUS_KEYS: optional comma-separated older keys, only
 *   used to decrypt secrets stored before a rotation (each is re-encrypted
 *   with the current key the next time it verifies a code).
 *
 * Every ciphertext names the key that encrypted it (a key ID derived from
 * the key), so the right key is always chosen.
 */
export const MFA_ENCRYPTION_KEY_ENV = 'MFA_ENCRYPTION_KEY';
export const MFA_PREVIOUS_KEYS_ENV = 'MFA_ENCRYPTION_PREVIOUS_KEYS';

export const MFA_KEY_BYTES = 32;

export class InvalidMfaKeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMfaKeyConfigError';
  }
}

export interface MfaKeyring {
  /** Key ID of MFA_ENCRYPTION_KEY, or null when it is not configured. */
  readonly currentKeyId: string | null;
  /** Every configured key (current and previous) by key ID. */
  readonly keys: ReadonlyMap<string, Buffer>;
}

/** A short, non-secret identifier of a key (stored in each ciphertext). */
export function mfaKeyId(key: Buffer): string {
  return createHash('sha256')
    .update('musecue-mfa-key-id\u0000')
    .update(key)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Decodes one key: exactly 32 bytes given as 64 hex characters or as
 * base64/base64url. Errors name the variable, never the value.
 */
export function parseMfaKey(raw: string, variable: string): Buffer {
  const value = raw.trim();
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, 'hex');
  } else if (/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(value)) {
    key = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }
  if (!key || key.length !== MFA_KEY_BYTES) {
    throw new InvalidMfaKeyConfigError(
      `${variable} must be ${MFA_KEY_BYTES} random bytes as 64 hex characters or base64 (for example: openssl rand -base64 32)`,
    );
  }
  if (key.equals(Buffer.alloc(MFA_KEY_BYTES))) {
    throw new InvalidMfaKeyConfigError(`${variable} must not be all zeros`);
  }
  return key;
}

/**
 * Reads the keyring from the environment. An unset MFA_ENCRYPTION_KEY is
 * allowed (MFA features that need it answer 503); an invalid one, or one
 * that reuses a JWT secret, stops the application at startup.
 */
export function loadMfaKeyring(
  env: Record<string, string | undefined> = process.env,
): MfaKeyring {
  const keys = new Map<string, Buffer>();
  const raw = env[MFA_ENCRYPTION_KEY_ENV]?.trim();
  let currentKeyId: string | null = null;

  if (raw) {
    for (const jwtVariable of ['JWT_REFRESH_SECRET', 'JWT_ACCESS_SECRET']) {
      if (env[jwtVariable] && env[jwtVariable]?.trim() === raw) {
        throw new InvalidMfaKeyConfigError(
          `${MFA_ENCRYPTION_KEY_ENV} must be a different key from ${jwtVariable}`,
        );
      }
    }
    const current = parseMfaKey(raw, MFA_ENCRYPTION_KEY_ENV);
    currentKeyId = mfaKeyId(current);
    keys.set(currentKeyId, current);
  }

  const previous = (env[MFA_PREVIOUS_KEYS_ENV] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const value of previous) {
    const key = parseMfaKey(value, MFA_PREVIOUS_KEYS_ENV);
    const id = mfaKeyId(key);
    if (!keys.has(id)) keys.set(id, key);
  }
  if (!currentKeyId && keys.size > 0) {
    throw new InvalidMfaKeyConfigError(
      `${MFA_PREVIOUS_KEYS_ENV} requires ${MFA_ENCRYPTION_KEY_ENV}`,
    );
  }
  return { currentKeyId, keys };
}
