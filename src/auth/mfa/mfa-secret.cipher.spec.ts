import config from '../../common/config/app.config';
import {
  MissingRootSecretError,
  SecretDecryptionError,
} from '../../common/security/derived-secrets';
import { generateTotpSecret } from './mfa-totp';
import { decryptMfaSecret, encryptMfaSecret } from './mfa-secret.cipher';

describe('MFA secret encryption', () => {
  const original = config.jwt_refresh_secret;
  const secret = generateTotpSecret();

  beforeEach(() => {
    config.jwt_refresh_secret =
      'mfa-cipher-unit-test-refresh-secret-0123456789';
  });
  afterAll(() => {
    config.jwt_refresh_secret = original;
  });

  it('stores AES-256-GCM ciphertext, never the secret', () => {
    const encrypted = encryptMfaSecret('confirmed', 'user-1', secret);

    expect(encrypted).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(encrypted).not.toContain(secret);
    expect(encrypted.toLowerCase()).not.toContain(secret.toLowerCase());
    expect(decryptMfaSecret('confirmed', 'user-1', encrypted)).toBe(secret);
  });

  it('uses a fresh IV every time', () => {
    expect(encryptMfaSecret('confirmed', 'user-1', secret)).not.toBe(
      encryptMfaSecret('confirmed', 'user-1', secret),
    );
  });

  it("cannot be moved to another user's account", () => {
    const encrypted = encryptMfaSecret('confirmed', 'user-1', secret);
    expect(() => decryptMfaSecret('confirmed', 'user-2', encrypted)).toThrow(
      SecretDecryptionError,
    );
  });

  it('binds pending and confirmed secrets to their role', () => {
    const pending = encryptMfaSecret('enrollment', 'user-1', secret);
    expect(() => decryptMfaSecret('confirmed', 'user-1', pending)).toThrow(
      SecretDecryptionError,
    );
    const confirmed = encryptMfaSecret('confirmed', 'user-1', secret);
    expect(() => decryptMfaSecret('enrollment', 'user-1', confirmed)).toThrow(
      SecretDecryptionError,
    );
  });

  it('detects tampering', () => {
    const [format, iv, tag, body] = encryptMfaSecret(
      'confirmed',
      'user-1',
      secret,
    ).split('.');
    const flipped = Buffer.from(body, 'base64url');
    flipped[0] ^= 1;
    expect(() =>
      decryptMfaSecret(
        'confirmed',
        'user-1',
        [format, iv, tag, flipped.toString('base64url')].join('.'),
      ),
    ).toThrow(SecretDecryptionError);
    expect(() => decryptMfaSecret('confirmed', 'user-1', secret)).toThrow(
      SecretDecryptionError,
    );
  });

  it('cannot be read after the root secret changes', () => {
    const encrypted = encryptMfaSecret('confirmed', 'user-1', secret);
    config.jwt_refresh_secret = 'a-different-refresh-secret-0123456789abcdef';
    expect(() => decryptMfaSecret('confirmed', 'user-1', encrypted)).toThrow(
      SecretDecryptionError,
    );
  });

  it('refuses to encrypt without a configured root secret', () => {
    config.jwt_refresh_secret = '';
    expect(() => encryptMfaSecret('confirmed', 'user-1', secret)).toThrow(
      MissingRootSecretError,
    );
  });
});
