import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { MFA_TOTP } from './mfa.constants';

/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP): HMAC-SHA-1,
 * six digits, 30-second steps, the parameters every authenticator app
 * supports by default. Pure functions: the caller supplies the time.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding (the format authenticator apps expect). */
export function base32Encode(bytes: Buffer): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}

/** Decodes RFC 4648 base32 (case-insensitive, padding optional). */
export function base32Decode(encoded: string): Buffer {
  const clean = encoded.replace(/=+$/, '').toUpperCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) throw new Error('Invalid base32 character');
    buffer = ((buffer << 5) | value) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new random secret, base32-encoded (32 characters for 20 bytes). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(MFA_TOTP.SECRET_BYTES));
}

/** The time step `now` falls in (Unix seconds / 30, rounded down). */
export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / MFA_TOTP.PERIOD_SECONDS);
}

/** When the step containing `now` stops being valid. */
export function totpStepEndsAt(now: Date): Date {
  return new Date((totpStep(now) + 1) * MFA_TOTP.PERIOD_SECONDS * 1000);
}

/** The HOTP value of `step` for a base32 `secret`, zero-padded. */
export function totpCodeForStep(
  secret: string,
  step: number,
  digits: number = MFA_TOTP.DIGITS,
): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret))
    .update(counter)
    .digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/** The code an authenticator app shows at `now`. */
export function totpCode(secret: string, now: Date): string {
  return totpCodeForStep(secret, totpStep(now));
}

/**
 * - VALID: the code of the current step, not used before.
 * - INVALID: not the current step's code (wrong, malformed, or the code of an
 *   earlier or later step, i.e. expired or not yet valid).
 * - REUSED: the current step's code, but that step was already used.
 */
export type TotpCheck =
  | { result: 'VALID'; step: number }
  | { result: 'INVALID' }
  | { result: 'REUSED' };

/**
 * Checks `code` against the step containing `now` only: a code is accepted
 * within its own 30-second period and never afterwards. A step at or before
 * `lastUsedStep` is never accepted again (replay protection). The comparison
 * takes constant time.
 */
export function verifyTotp(
  secret: string,
  code: string,
  now: Date,
  lastUsedStep: number | null = null,
): TotpCheck {
  if (!/^\d+$/.test(code) || code.length !== MFA_TOTP.DIGITS) {
    return { result: 'INVALID' };
  }
  const step = totpStep(now);
  const expected = Buffer.from(totpCodeForStep(secret, step), 'utf8');
  const actual = Buffer.from(code, 'utf8');
  if (!timingSafeEqual(expected, actual)) return { result: 'INVALID' };
  if (lastUsedStep !== null && step <= lastUsedStep)
    return { result: 'REUSED' };
  return { result: 'VALID', step };
}

/**
 * The otpauth:// URI that authenticator apps import (usually as a QR code):
 * `otpauth://totp/<issuer>:<account>?secret=...&issuer=...`.
 */
export function buildOtpAuthUri(secret: string, accountName: string): string {
  const label = `${encodeURIComponent(MFA_TOTP.ISSUER)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret,
    issuer: MFA_TOTP.ISSUER,
    algorithm: MFA_TOTP.ALGORITHM,
    digits: String(MFA_TOTP.DIGITS),
    period: String(MFA_TOTP.PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
