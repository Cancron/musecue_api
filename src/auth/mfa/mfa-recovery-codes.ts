import { randomInt } from 'node:crypto';
import {
  keyedHash,
  SECRET_PURPOSES,
} from '../../common/security/derived-secrets';
import { MFA_RECOVERY_CODES } from './mfa.constants';

/**
 * Single-use MFA recovery codes: `ABCDE-FGHJK`, 10 characters from a
 * 31-character alphabet without look-alikes (about 49.5 bits each).
 *
 * A code is stored only as an HMAC-SHA-256 under a server-side key derived
 * for this purpose (never as plaintext or an unkeyed hash), over the user ID
 * and the normalized code. Stolen hashes are therefore useless without the
 * server key, and a code issued to one user never matches for another. A
 * keyed hash (rather than bcrypt) fits here because the codes are random and
 * high-entropy, and it lets a code be found and consumed with one atomic,
 * indexed UPDATE, which is what makes concurrent use safe.
 */

/** Accepted input: the displayed form, optionally without the hyphen. */
export const RECOVERY_CODE_INPUT_PATTERN = /^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/;

function randomCode(): string {
  let raw = '';
  for (let i = 0; i < MFA_RECOVERY_CODES.LENGTH; i++) {
    raw +=
      MFA_RECOVERY_CODES.ALPHABET[
        randomInt(MFA_RECOVERY_CODES.ALPHABET.length)
      ];
  }
  return `${raw.slice(0, MFA_RECOVERY_CODES.GROUP_LENGTH)}-${raw.slice(MFA_RECOVERY_CODES.GROUP_LENGTH)}`;
}

/** A new set of distinct codes, in display form. */
export function generateRecoveryCodes(
  count: number = MFA_RECOVERY_CODES.COUNT,
): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(randomCode());
  return [...codes];
}

/**
 * The canonical form of user input (upper case, without the hyphen), or
 * null when it cannot be a recovery code.
 */
export function normalizeRecoveryCode(input: string): string | null {
  if (!RECOVERY_CODE_INPUT_PATTERN.test(input)) return null;
  return input.replace('-', '').toUpperCase();
}

/** The stored form of a code (64 hex characters), bound to its user. */
export function hashRecoveryCode(authId: string, code: string): string {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) throw new Error('Not a recovery code');
  return keyedHash(
    SECRET_PURPOSES.MFA_RECOVERY_CODE,
    `${authId}\u0000${normalized}`,
  );
}

/**
 * Issues a new set of codes inside the caller's transaction: every previous
 * code of the user is deleted and only the hashes of the new ones are
 * stored. Returns the codes in display form, to be shown once.
 */
export async function issueRecoveryCodes(
  uow: { replaceRecoveryCodes(codeHashes: string[]): Promise<void> },
  authId: string,
): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await uow.replaceRecoveryCodes(
    codes.map((code) => hashRecoveryCode(authId, code)),
  );
  return codes;
}
