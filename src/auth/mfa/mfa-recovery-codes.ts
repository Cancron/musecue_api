import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { MFA_RECOVERY_CODES } from './mfa.constants';

/**
 * Single-use MFA recovery codes: `ABCDE-FGHJK`, 10 characters from a
 * 31-character alphabet without look-alikes (about 49.5 bits each).
 *
 * A code is stored only as a salted scrypt hash (a one-way, memory-hard
 * function; no key is involved, so rotating any application secret never
 * affects recovery codes): `scrypt$<log2 N>$<r>$<p>$<salt>$<hash>` over the
 * user ID and the normalized code. Each code has its own random salt, so
 * equal codes never produce equal hashes, and a hash only ever verifies for
 * the user it was issued to.
 */

/** scrypt cost: N = 2^14, r = 8, p = 1 (16 MiB, tens of milliseconds). */
export const RECOVERY_CODE_SCRYPT = {
  LOG2_N: 14,
  R: 8,
  P: 1,
  SALT_BYTES: 16,
  KEY_BYTES: 32,
} as const;

const HASH_PREFIX = 'scrypt';

function scryptAsync(
  password: string,
  salt: Buffer,
  params: { log2N: number; r: number; p: number },
): Promise<Buffer> {
  const N = 2 ** params.log2N;
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      RECOVERY_CODE_SCRYPT.KEY_BYTES,
      { N, r: params.r, p: params.p, maxmem: 256 * N * params.r * params.p },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

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

const hashInput = (authId: string, normalized: string) =>
  `musecue-mfa-recovery-code\u0000${authId}\u0000${normalized}`;

/** The stored form of a code: a salted scrypt hash, bound to its user. */
export async function hashRecoveryCode(
  authId: string,
  code: string,
): Promise<string> {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) throw new Error('Not a recovery code');
  const salt = randomBytes(RECOVERY_CODE_SCRYPT.SALT_BYTES);
  const hash = await scryptAsync(hashInput(authId, normalized), salt, {
    log2N: RECOVERY_CODE_SCRYPT.LOG2_N,
    r: RECOVERY_CODE_SCRYPT.R,
    p: RECOVERY_CODE_SCRYPT.P,
  });
  return [
    HASH_PREFIX,
    RECOVERY_CODE_SCRYPT.LOG2_N,
    RECOVERY_CODE_SCRYPT.R,
    RECOVERY_CODE_SCRYPT.P,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

/**
 * Whether `code` is the code behind `stored` for this user (constant-time
 * comparison). Anything that is not a well-formed hash never matches.
 */
export async function verifyRecoveryCode(
  authId: string,
  code: string,
  stored: string,
): Promise<boolean> {
  const normalized = normalizeRecoveryCode(code);
  const parts = stored.split('$');
  if (!normalized || parts.length !== 6 || parts[0] !== HASH_PREFIX) {
    return false;
  }
  const [log2N, r, p] = parts.slice(1, 4).map(Number);
  // Only the parameter range this application writes (guards the cost).
  if (
    !Number.isInteger(log2N) ||
    log2N < 10 ||
    log2N > 20 ||
    !Number.isInteger(r) ||
    r < 1 ||
    r > 32 ||
    !Number.isInteger(p) ||
    p < 1 ||
    p > 4
  ) {
    return false;
  }
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (expected.length !== RECOVERY_CODE_SCRYPT.KEY_BYTES || salt.length < 16) {
    return false;
  }
  const actual = await scryptAsync(hashInput(authId, normalized), salt, {
    log2N,
    r,
    p,
  });
  return timingSafeEqual(actual, expected);
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
  const hashes = await Promise.all(
    codes.map((code) => hashRecoveryCode(authId, code)),
  );
  await uow.replaceRecoveryCodes(hashes);
  return codes;
}
