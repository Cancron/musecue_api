import type { PrismaClient } from '@prisma/client';
import {
  decryptLegacyMfaSecret,
  isLegacyMfaSecret,
  type MfaSecretCipher,
} from './mfa-secret.cipher';

export interface MfaRekeyReport {
  /** Secrets in the first build's format that were found. */
  legacySecrets: number;
  /** ...re-encrypted with MFA_ENCRYPTION_KEY. */
  reencrypted: number;
  /** Users whose legacy secret could not be read (wrong old secret). */
  failedUserIds: string[];
  /** Users with MFA enabled and no unused recovery code (should regenerate). */
  usersWithoutRecoveryCodes: number;
}

export class MfaRekeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MfaRekeyConfigError';
  }
}

type RekeyClient = Pick<PrismaClient, 'authSecurity' | 'mfaRecoveryCode'>;

/**
 * One-time move of authenticator secrets stored by the first MFA build
 * (`v1.`, key derived from JWT_REFRESH_SECRET) to the dedicated
 * MFA_ENCRYPTION_KEY. Idempotent and safe to run while the API serves
 * requests: each secret is replaced only if it is still the legacy value.
 * Needs the JWT_REFRESH_SECRET value those secrets were written with, only
 * while legacy secrets remain. Never prints a secret.
 */
export async function rekeyLegacyMfaSecrets(
  prisma: RekeyClient,
  cipher: MfaSecretCipher,
  legacyJwtRefreshSecret: string | undefined,
): Promise<MfaRekeyReport> {
  if (!cipher.available) {
    throw new MfaRekeyConfigError('MFA_ENCRYPTION_KEY must be set');
  }
  const legacy = await prisma.authSecurity.findMany({
    where: { mfaSecret: { startsWith: 'v1.' } },
    select: { authId: true, mfaSecret: true },
  });
  if (legacy.length > 0 && !legacyJwtRefreshSecret) {
    throw new MfaRekeyConfigError(
      'Legacy MFA secrets exist: set MFA_LEGACY_JWT_REFRESH_SECRET (or JWT_REFRESH_SECRET) to the value they were written with',
    );
  }

  let reencrypted = 0;
  const failedUserIds: string[] = [];
  for (const { authId, mfaSecret } of legacy) {
    if (!mfaSecret || !isLegacyMfaSecret(mfaSecret)) continue;
    let secret: string;
    try {
      secret = decryptLegacyMfaSecret(
        legacyJwtRefreshSecret as string,
        'confirmed',
        authId,
        mfaSecret,
      );
    } catch {
      failedUserIds.push(authId);
      continue;
    }
    const { count } = await prisma.authSecurity.updateMany({
      where: { authId, mfaSecret },
      data: { mfaSecret: cipher.encrypt('confirmed', authId, secret) },
    });
    reencrypted += count;
  }

  const enabled = await prisma.authSecurity.findMany({
    where: { mfaEnabled: true },
    select: { authId: true },
  });
  let usersWithoutRecoveryCodes = 0;
  for (const { authId } of enabled) {
    const unused = await prisma.mfaRecoveryCode.count({
      where: { authId, usedAt: null },
    });
    if (unused === 0) usersWithoutRecoveryCodes += 1;
  }

  return {
    legacySecrets: legacy.length,
    reencrypted,
    failedUserIds,
    usersWithoutRecoveryCodes,
  };
}
