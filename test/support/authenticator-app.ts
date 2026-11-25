import { createDecipheriv, createHmac, hkdfSync } from 'node:crypto';

/**
 * An independent stand-in for an authenticator app (RFC 6238, HMAC-SHA1,
 * 6 digits, 30-second steps) and for an auditor decrypting the stored secret.
 * Deliberately does not import the application's TOTP or cipher code, so the
 * e2e tests check the implementation against the standards, not itself.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToBytes(secret: string): Buffer {
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`Not base32: ${char}`);
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** The code an authenticator app shows at `atMs` for a base32 secret. */
export function authenticatorCode(secret: string, atMs: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / 30)));
  const mac = createHmac('sha1', base32ToBytes(secret))
    .update(counter)
    .digest();
  const offset = mac[19] & 0xf;
  const value = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, '0');
}

/** A 6-digit code guaranteed not to be the current one. */
export function wrongCode(secret: string, atMs: number): string {
  return authenticatorCode(secret, atMs) === '000000' ? '111111' : '000000';
}

/** Start of the 30-second TOTP step following `ms`. */
export function nextStepStart(ms: number): number {
  return (Math.floor(ms / 30_000) + 1) * 30_000;
}

/**
 * Decrypts a stored authenticator secret (`v1.<iv>.<tag>.<ciphertext>`,
 * AES-256-GCM) with the documented key derivation: HKDF-SHA-256 of the root
 * key (MFA_ENCRYPTION_KEY), salt `musecue-derived-secrets`, info
 * `musecue/mfa-totp-secret/v1`; associated data
 * `musecue:mfa-totp:<slot>:<user id>`. Throws when anything does not match.
 */
export function decryptStoredSecret(
  stored: string,
  rootKey: string,
  authId: string,
  slot: 'enrollment' | 'active',
): string {
  const [version, iv, tag, body] = stored.split('.');
  if (version !== 'v1') throw new Error('Unknown format');
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      rootKey,
      'musecue-derived-secrets',
      'musecue/mfa-totp-secret/v1',
      32,
    ),
  );
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(iv, 'base64url'),
    { authTagLength: 16 },
  );
  decipher.setAAD(Buffer.from(`musecue:mfa-totp:${slot}:${authId}`, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(body, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * The documented stored form of an MFA recovery code: HMAC-SHA-256 (hex)
 * under HKDF-SHA-256(root key, salt `musecue-derived-secrets`, info
 * `musecue/mfa-recovery-code/v1`) over `<user id>\0<code>`, where the code is
 * upper-case without hyphens or spaces.
 */
export function recoveryCodeHash(
  rootKey: string,
  authId: string,
  code: string,
): string {
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      rootKey,
      'musecue-derived-secrets',
      'musecue/mfa-recovery-code/v1',
      32,
    ),
  );
  const normalized = code.replace(/[\s-]/g, '').toUpperCase();
  return createHmac('sha256', key)
    .update(`${authId}\u0000${normalized}`, 'utf8')
    .digest('hex');
}
