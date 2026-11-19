import {
  decryptSecret,
  encryptSecret,
  SECRET_PURPOSES,
} from '../../common/security/derived-secrets';

/**
 * Encryption of TOTP secrets at rest (AES-256-GCM under a key derived for
 * MFA only). The associated data binds a ciphertext to its user and to its
 * role, so a stored secret cannot be copied to another account, and a
 * pending enrollment secret cannot be passed off as a confirmed one (or the
 * reverse).
 */
export type MfaSecretRole = 'enrollment' | 'confirmed';

const associatedData = (role: MfaSecretRole, authId: string) =>
  `mfa-totp-secret\u0000${role}\u0000${authId}`;

export function encryptMfaSecret(
  role: MfaSecretRole,
  authId: string,
  secret: string,
): string {
  return encryptSecret(
    SECRET_PURPOSES.MFA_TOTP_SECRET,
    secret,
    associatedData(role, authId),
  );
}

/** Throws SecretDecryptionError when the value or its binding is wrong. */
export function decryptMfaSecret(
  role: MfaSecretRole,
  authId: string,
  encrypted: string,
): string {
  return decryptSecret(
    SECRET_PURPOSES.MFA_TOTP_SECRET,
    encrypted,
    associatedData(role, authId),
  );
}
