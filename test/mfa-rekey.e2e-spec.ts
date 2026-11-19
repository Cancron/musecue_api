import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { rekeyLegacyMfaSecrets } from '../src/auth/mfa/mfa-rekey';
import { MfaSecretCipher } from '../src/auth/mfa/mfa-secret.cipher';
import { generateTotpSecret } from '../src/auth/mfa/mfa-totp';
import { testCipher } from './support/mfa-test-keys';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';

jest.setTimeout(60_000);

const OLD_JWT_REFRESH_SECRET = 'the-jwt-refresh-secret-of-the-first-build-01';

/** A secret exactly as the first MFA build stored it. */
function legacyCiphertext(authId: string, secret: string) {
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      OLD_JWT_REFRESH_SECRET,
      'musecue-derived-secrets',
      'musecue/mfa-totp-secret/v1',
      32,
    ),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`mfa-totp-secret\u0000confirmed\u0000${authId}`));
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join('.');
}

/**
 * `npm run mfa:rekey` on PostgreSQL: secrets written by the first MFA build
 * (key derived from JWT_REFRESH_SECRET) move to MFA_ENCRYPTION_KEY with the
 * same value, after which JWT_REFRESH_SECRET plays no part.
 */
describeWithDatabase('MFA rekey of legacy secrets (PostgreSQL)', () => {
  let schema: string;
  let client: PrismaClient;

  beforeAll(async () => {
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    client = new PrismaClient({
      adapter: new PrismaPg(
        {
          connectionString: TEST_DATABASE_URL as string,
          options: `-c search_path=${schema}`,
        },
        { schema },
      ),
    });
  });

  afterAll(async () => {
    await client?.$disconnect();
    if (schema) await dropSchema(schema);
  });

  async function legacyUser(secret: string) {
    const tag = randomBytes(5).toString('hex');
    const user = await client.authUser.create({
      data: {
        email: `${tag}@example.com`,
        username: `u_${tag}`,
        password: 'x',
        verified: true,
      },
    });
    await client.authSecurity.create({
      data: {
        authId: user.id,
        mfaEnabled: true,
        mfaMethod: 'totp',
        mfaSecret: legacyCiphertext(user.id, secret),
      },
    });
    return user.id;
  }

  it('re-encrypts every legacy secret with MFA_ENCRYPTION_KEY, preserving it', async () => {
    const secrets = [generateTotpSecret(), generateTotpSecret()];
    const ids = await Promise.all(secrets.map(legacyUser));
    const cipher = testCipher();

    // Without the old JWT secret nothing can be done (and nothing changes).
    await expect(
      rekeyLegacyMfaSecrets(client, cipher, undefined),
    ).rejects.toThrow('MFA_LEGACY_JWT_REFRESH_SECRET');
    // With a wrong one, every secret is reported and left untouched.
    const wrong = await rekeyLegacyMfaSecrets(client, cipher, 'wrong');
    expect(wrong).toMatchObject({ reencrypted: 0 });
    expect(wrong.failedUserIds.sort()).toEqual([...ids].sort());
    expect(
      await client.authSecurity.count({
        where: { mfaSecret: { startsWith: 'v1.' } },
      }),
    ).toBe(2);

    const report = await rekeyLegacyMfaSecrets(
      client,
      cipher,
      OLD_JWT_REFRESH_SECRET,
    );

    expect(report).toEqual({
      legacySecrets: 2,
      reencrypted: 2,
      failedUserIds: [],
      usersWithoutRecoveryCodes: 2,
    });
    for (const [i, authId] of ids.entries()) {
      const { mfaSecret } = await client.authSecurity.findUniqueOrThrow({
        where: { authId },
      });
      expect(mfaSecret).toMatch(/^mfa2\./);
      // The same secret: the user's authenticator app keeps working.
      expect(cipher.decrypt('confirmed', authId, mfaSecret!)).toBe(secrets[i]);
    }

    // Idempotent: nothing left, and no JWT secret needed any more.
    await expect(
      rekeyLegacyMfaSecrets(client, cipher, undefined),
    ).resolves.toMatchObject({ legacySecrets: 0, reencrypted: 0 });
  });

  it('refuses to run without MFA_ENCRYPTION_KEY', async () => {
    await expect(
      rekeyLegacyMfaSecrets(
        client,
        new MfaSecretCipher({ currentKeyId: null, keys: new Map() }),
        OLD_JWT_REFRESH_SECRET,
      ),
    ).rejects.toThrow('MFA_ENCRYPTION_KEY must be set');
  });
});
