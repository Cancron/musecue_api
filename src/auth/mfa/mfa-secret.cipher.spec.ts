import { hkdfSync, randomBytes, createCipheriv } from 'node:crypto';
import { testCipher } from '../../../test/support/mfa-test-keys';
import config from '../../common/config/app.config';
import { mfaKeyId } from './mfa-keys';
import {
  decryptLegacyMfaSecret,
  isLegacyMfaSecret,
  LegacyMfaSecretError,
  MfaKeyUnavailableError,
  MfaSecretCipher,
  MfaSecretDecryptionError,
} from './mfa-secret.cipher';
import { generateTotpSecret } from './mfa-totp';

/** A secret as the first MFA build stored it (key from JWT_REFRESH_SECRET). */
function legacyCiphertext(root: string, authId: string, secret: string) {
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      root,
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

describe('MFA secret encryption (MFA_ENCRYPTION_KEY)', () => {
  const secret = generateTotpSecret();
  const originalRefresh = config.jwt_refresh_secret;
  afterEach(() => {
    config.jwt_refresh_secret = originalRefresh;
  });

  it('stores AES-256-GCM ciphertext naming its key, never the secret', () => {
    const key = randomBytes(32);
    const cipher = testCipher(key);
    const encrypted = cipher.encrypt('confirmed', 'user-1', secret);

    const parts = encrypted.split('.');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('mfa2');
    expect(parts[1]).toBe(mfaKeyId(key));
    expect(encrypted).not.toContain(secret);
    expect(cipher.decrypt('confirmed', 'user-1', encrypted)).toBe(secret);
  });

  it('does not depend on any JWT secret', () => {
    const cipher = testCipher();
    config.jwt_refresh_secret = 'refresh-secret-one-0123456789abcdef0123';
    const encrypted = cipher.encrypt('confirmed', 'user-1', secret);

    // Rotating (or removing) the JWT refresh secret changes nothing.
    config.jwt_refresh_secret = 'refresh-secret-two-0123456789abcdef0123';
    expect(cipher.decrypt('confirmed', 'user-1', encrypted)).toBe(secret);
    config.jwt_refresh_secret = '';
    expect(cipher.decrypt('confirmed', 'user-1', encrypted)).toBe(secret);
    expect(cipher.encrypt('confirmed', 'user-1', secret)).toMatch(/^mfa2\./);
  });

  it('uses a fresh IV every time', () => {
    const cipher = testCipher();
    expect(cipher.encrypt('confirmed', 'u', secret)).not.toBe(
      cipher.encrypt('confirmed', 'u', secret),
    );
  });

  it("cannot be moved to another user's account or role", () => {
    const cipher = testCipher();
    const confirmed = cipher.encrypt('confirmed', 'user-1', secret);
    expect(() => cipher.decrypt('confirmed', 'user-2', confirmed)).toThrow(
      MfaSecretDecryptionError,
    );
    expect(() => cipher.decrypt('enrollment', 'user-1', confirmed)).toThrow(
      MfaSecretDecryptionError,
    );
  });

  it('detects tampering and foreign keys', () => {
    const cipher = testCipher();
    const encrypted = cipher.encrypt('confirmed', 'user-1', secret);
    const parts = encrypted.split('.');
    const body = Buffer.from(parts[4], 'base64url');
    body[0] ^= 1;
    parts[4] = body.toString('base64url');
    expect(() =>
      cipher.decrypt('confirmed', 'user-1', parts.join('.')),
    ).toThrow(MfaSecretDecryptionError);
    // Encrypted under a key this application does not have.
    expect(() =>
      cipher.decrypt(
        'confirmed',
        'user-1',
        testCipher().encrypt('confirmed', 'user-1', secret),
      ),
    ).toThrow('no longer configured');
  });

  it('supports rotation: previous keys still decrypt, and are flagged', () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const before = testCipher(oldKey).encrypt('confirmed', 'user-1', secret);

    const rotated = testCipher(newKey, oldKey);
    expect(rotated.decrypt('confirmed', 'user-1', before)).toBe(secret);
    expect(rotated.needsReencryption(before)).toBe(true);
    const after = rotated.encrypt('confirmed', 'user-1', secret);
    expect(after.split('.')[1]).toBe(mfaKeyId(newKey));
    expect(rotated.needsReencryption(after)).toBe(false);
    // Once the old key is removed, old ciphertexts no longer open.
    expect(() =>
      testCipher(newKey).decrypt('confirmed', 'user-1', before),
    ).toThrow(MfaSecretDecryptionError);
  });

  it('refuses to work without MFA_ENCRYPTION_KEY', () => {
    const cipher = new MfaSecretCipher({ currentKeyId: null, keys: new Map() });
    expect(cipher.available).toBe(false);
    expect(() => cipher.encrypt('confirmed', 'user-1', secret)).toThrow(
      MfaKeyUnavailableError,
    );
    expect(() =>
      cipher.decrypt(
        'confirmed',
        'user-1',
        testCipher().encrypt('confirmed', 'user-1', secret),
      ),
    ).toThrow(MfaKeyUnavailableError);
  });

  describe('legacy secrets of the first MFA build', () => {
    const root = 'old-jwt-refresh-secret-0123456789abcdef0123';

    it('are recognized and refused at runtime (run mfa:rekey)', () => {
      const legacy = legacyCiphertext(root, 'user-1', secret);
      expect(isLegacyMfaSecret(legacy)).toBe(true);
      expect(() => testCipher().decrypt('confirmed', 'user-1', legacy)).toThrow(
        LegacyMfaSecretError,
      );
    });

    it('can be read once with the old JWT_REFRESH_SECRET for re-encryption', () => {
      const legacy = legacyCiphertext(root, 'user-1', secret);
      expect(decryptLegacyMfaSecret(root, 'confirmed', 'user-1', legacy)).toBe(
        secret,
      );
      expect(() =>
        decryptLegacyMfaSecret('wrong-secret', 'confirmed', 'user-1', legacy),
      ).toThrow(MfaSecretDecryptionError);
      expect(() =>
        decryptLegacyMfaSecret(root, 'confirmed', 'user-2', legacy),
      ).toThrow(MfaSecretDecryptionError);
    });
  });
});
