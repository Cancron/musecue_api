import { randomBytes } from 'node:crypto';
import { mfaKeyId, type MfaKeyring } from '../../src/auth/mfa/mfa-keys';
import { verifyRecoveryCode } from '../../src/auth/mfa/mfa-recovery-codes';
import { MfaSecretCipher } from '../../src/auth/mfa/mfa-secret.cipher';

/** A random MFA_ENCRYPTION_KEY value (base64), as an operator would set. */
export const newMfaKey = () => randomBytes(32).toString('base64');

/** A keyring of raw keys; the first is current, the rest are previous. */
export function testKeyring(...keys: Buffer[]): MfaKeyring {
  const map = new Map<string, Buffer>();
  for (const key of keys) map.set(mfaKeyId(key), key);
  return { currentKeyId: keys.length ? mfaKeyId(keys[0]) : null, keys: map };
}

/** A cipher with a fresh random key (or the given keys). */
export function testCipher(...keys: Buffer[]): MfaSecretCipher {
  return new MfaSecretCipher(
    testKeyring(...(keys.length ? keys : [randomBytes(32)])),
  );
}

/**
 * Whether the stored (salted) hashes are exactly the given codes of this
 * user: every code verifies against exactly one hash, and every hash
 * against exactly one code. scrypt is deliberately slow, so the common case
 * (hashes stored in the order of the codes) is checked first with one
 * verification per code; otherwise codes are matched greedily.
 */
export async function hashesMatchCodes(
  authId: string,
  codes: string[],
  hashes: string[],
): Promise<boolean> {
  if (codes.length !== hashes.length) return false;
  if (new Set(codes).size !== codes.length) return false;
  const inOrder = await Promise.all(
    codes.map((code, i) => verifyRecoveryCode(authId, code, hashes[i])),
  );
  if (inOrder.every(Boolean)) return true;

  const unmatched = [...hashes];
  for (const code of codes) {
    let found = -1;
    for (let j = 0; j < unmatched.length && found < 0; j++) {
      if (await verifyRecoveryCode(authId, code, unmatched[j])) found = j;
    }
    if (found < 0) return false;
    unmatched.splice(found, 1);
  }
  return unmatched.length === 0;
}
