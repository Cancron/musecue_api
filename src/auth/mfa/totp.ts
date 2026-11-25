import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { MFA_TOTP } from './mfa.constants';

/**
 * Time-based one-time passwords (RFC 6238) over HOTP (RFC 4226), with
 * HMAC-SHA1, 6 digits and 30-second steps: the parameters every common
 * authenticator app supports. Secrets are exchanged as unpadded RFC 4648
 * base32, as in `otpauth://` URIs.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export class InvalidTotpSecretError extends Error {
  constructor() {
    super('The authenticator secret is not valid base32');
    this.name = 'InvalidTotpSecretError';
  }
}

/** RFC 4648 base32 without padding. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/**
 * Decodes RFC 4648 base32. Case, spaces and trailing padding are tolerated
 * (as typed from an authenticator app); anything else is rejected.
 */
export function base32Decode(input: string): Buffer {
  const normalized = input.replace(/\s+/g, '').replace(/=+$/, '').toUpperCase();
  if (!normalized) throw new InvalidTotpSecretError();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new InvalidTotpSecretError();
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new random authenticator secret (base32). */
export function generateTotpSecret(
  byteLength: number = MFA_TOTP.SECRET_BYTES,
): string {
  return base32Encode(randomBytes(byteLength));
}

/** The TOTP time step (counter) of `now`. */
export function totpTimeStep(
  now: Date | number,
  periodSeconds: number = MFA_TOTP.PERIOD_SECONDS,
): number {
  const ms = typeof now === 'number' ? now : now.getTime();
  return Math.floor(ms / 1000 / periodSeconds);
}

/** The HOTP value of `counter` (RFC 4226 section 5.3). */
export function hotp(
  secret: Buffer,
  counter: number,
  digits: number = MFA_TOTP.DIGITS,
): string {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new RangeError('The HOTP counter must be a non-negative integer');
  }
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The TOTP code of a base32 secret for one time step. */
export function totpCode(secret: string, step: number): string {
  return hotp(base32Decode(secret), step);
}

export interface TotpCheckOptions {
  /** Neighbouring steps also accepted (default MFA_TOTP.ALLOWED_DRIFT_STEPS). */
  driftSteps?: number;
  /** Steps up to and including this one were already used: never accepted. */
  lastUsedStep?: number | null;
}

/**
 * Checks a code against the current time step (plus the allowed drift). A
 * code of an earlier step (expired), of an already used step, or that is not
 * exactly 6 digits is never accepted. Returns the matched step, or null.
 * Every candidate step is compared in constant time.
 */
export function verifyTotp(
  secret: string,
  code: string,
  now: Date | number,
  options: TotpCheckOptions = {},
): number | null {
  if (!new RegExp(`^\\d{${MFA_TOTP.DIGITS}}$`).test(code)) return null;
  const key = base32Decode(secret);
  const drift = Math.max(0, options.driftSteps ?? MFA_TOTP.ALLOWED_DRIFT_STEPS);
  const current = totpTimeStep(now);
  const submitted = Buffer.from(code, 'utf8');
  let matched: number | null = null;
  for (let step = current - drift; step <= current + drift; step += 1) {
    if (step < 0) continue;
    const expected = Buffer.from(hotp(key, step), 'utf8');
    const equal = timingSafeEqual(expected, submitted);
    const unused =
      options.lastUsedStep === undefined ||
      options.lastUsedStep === null ||
      step > options.lastUsedStep;
    if (equal && unused && matched === null) matched = step;
  }
  return matched;
}

/**
 * The `otpauth://` URI that authenticator apps import (usually as a QR
 * code). It contains the secret: return it only to the account owner and
 * never log it.
 */
export function otpauthUrl(params: {
  secret: string;
  accountName: string;
  issuer?: string;
}): string {
  const issuer = params.issuer ?? MFA_TOTP.ISSUER;
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(params.accountName)}`;
  const query = new URLSearchParams({
    secret: params.secret,
    issuer,
    algorithm: MFA_TOTP.ALGORITHM,
    digits: String(MFA_TOTP.DIGITS),
    period: String(MFA_TOTP.PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
