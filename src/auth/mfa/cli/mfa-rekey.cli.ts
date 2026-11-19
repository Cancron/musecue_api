import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { loadMfaKeyring } from '../mfa-keys';
import { rekeyLegacyMfaSecrets } from '../mfa-rekey';
import { MfaSecretCipher } from '../mfa-secret.cipher';

/**
 * `npm run mfa:rekey` (after `npm run build`): re-encrypts authenticator
 * secrets written by the first MFA build with MFA_ENCRYPTION_KEY. Reads
 * DATABASE_URL, MFA_ENCRYPTION_KEY and the JWT refresh secret the old
 * secrets were written with (MFA_LEGACY_JWT_REFRESH_SECRET, falling back to
 * JWT_REFRESH_SECRET). Prints counts only.
 */
async function main(): Promise<number> {
  const cipher = new MfaSecretCipher(loadMfaKeyring(process.env));
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL as string,
    }),
  });
  try {
    const report = await rekeyLegacyMfaSecrets(
      prisma,
      cipher,
      process.env.MFA_LEGACY_JWT_REFRESH_SECRET ||
        process.env.JWT_REFRESH_SECRET,
    );
    console.log(
      `MFA rekey: ${report.reencrypted} of ${report.legacySecrets} legacy authenticator secret(s) re-encrypted with MFA_ENCRYPTION_KEY.`,
    );
    if (report.failedUserIds.length > 0) {
      console.error(
        `MFA rekey: ${report.failedUserIds.length} secret(s) could not be read with the given JWT refresh secret (user IDs: ${report.failedUserIds.join(', ')}).`,
      );
    }
    console.log(
      `MFA rekey: ${report.usersWithoutRecoveryCodes} user(s) with MFA enabled have no recovery codes and should create new ones (POST /auth/mfa/recovery-codes).`,
    );
    return report.failedUserIds.length > 0 ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(
      `MFA rekey failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  },
);
