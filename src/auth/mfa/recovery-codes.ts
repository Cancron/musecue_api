import { randomBytes } from 'node:crypto';
import { MFA_RECOVERY_CODES } from './mfa.constants';

/**
 * MFA recovery codes: 12 characters of Crockford's base32 alphabet (no I, L,
 * O or U, so codes are easy to read and type), 60 random bits each, shown as
 * XXXX-XXXX-XXXX.
 */
export const RECOVERY_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A new set of distinct recovery codes, formatted for display. */
export function generateRecoveryCodes(
  count: number = MFA_RECOVERY_CODES.COUNT,
): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    // 32 divides 256, so `byte & 31` is uniform (no modulo bias).
    const bytes = randomBytes(MFA_RECOVERY_CODES.LENGTH);
    let raw = '';
    for (const byte of bytes) raw += RECOVERY_CODE_ALPHABET[byte & 31];
    codes.add(formatRecoveryCode(raw));
  }
  return [...codes];
}

/** XXXXXXXXXXXX -> XXXX-XXXX-XXXX. */
export function formatRecoveryCode(normalized: string): string {
  const groups: string[] = [];
  for (let i = 0; i < normalized.length; i += MFA_RECOVERY_CODES.GROUP_SIZE) {
    groups.push(normalized.slice(i, i + MFA_RECOVERY_CODES.GROUP_SIZE));
  }
  return groups.join('-');
}

/**
 * The canonical form of a typed recovery code, or null if it cannot be one:
 * hyphens and spaces are ignored, letters are case-insensitive, and the
 * look-alikes O, I and L are read as 0, 1 and 1 (Crockford decoding).
 */
export function normalizeRecoveryCode(input: string): string | null {
  const normalized = input
    .replace(/[\s-]+/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (normalized.length !== MFA_RECOVERY_CODES.LENGTH) return null;
  for (const char of normalized) {
    if (!RECOVERY_CODE_ALPHABET.includes(char)) return null;
  }
  return normalized;
}
