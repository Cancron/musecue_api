import { ConfigService } from '@nestjs/config';
import config from '../../common/config/app.config';
import { SecretDecryptionError } from '../../common/security/derived-secrets';
import {
  MfaEncryptionUnavailableError,
  MfaSecretCipher,
} from './mfa-secret.cipher';
import { generateTotpSecret } from './totp';

/** The format the database accepts (CHECK constraints of the migration). */
const STORED_FORMAT = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const KEY = 'mfa-unit-test-dedicated-key-0123456789abcdef';

const cipherWith = (
  env: Record<string, string | undefined> = { MFA_ENCRYPTION_KEY: KEY },
) => new MfaSecretCipher(new ConfigService(env));

describe('MfaSecretCipher (mfa)', () => {
  const original = {
    refresh: config.jwt_refresh_secret,
    access: config.jwt_access_secret,
  };
  const secret = generateTotpSecret();

  beforeEach(() => {
    config.jwt_refresh_secret = 'mfa-unit-test-refresh-secret-0123456789';
    config.jwt_access_secret = 'mfa-unit-test-access-secret-0123456789';
  });
  afterAll(() => {
    config.jwt_refresh_secret = original.refresh;
    config.jwt_access_secret = original.access;
  });

  it('encrypts and decrypts with MFA_ENCRYPTION_KEY', () => {
    const cipher = cipherWith();
    const encrypted = cipher.encrypt('user-1', 'active', secret);

    expect(encrypted).toMatch(STORED_FORMAT);
    expect(encrypted).not.toContain(secret);
    expect(encrypted.toLowerCase()).not.toContain(secret.toLowerCase());
    expect(cipher.decrypt('user-1', 'active', encrypted)).toBe(secret);
  });

  it('uses a fresh IV for every encryption', () => {
    const cipher = cipherWith();
    expect(cipher.encrypt('user-1', 'active', secret)).not.toBe(
      cipher.encrypt('user-1', 'active', secret),
    );
  });

  it('binds a ciphertext to its user: it cannot be moved to another account', () => {
    const cipher = cipherWith();
    const encrypted = cipher.encrypt('user-1', 'active', secret);
    expect(() => cipher.decrypt('user-2', 'active', encrypted)).toThrow(
      SecretDecryptionError,
    );
  });

  it('binds a ciphertext to its slot (pending enrollment vs confirmed)', () => {
    const cipher = cipherWith();
    const pending = cipher.encrypt('user-1', 'enrollment', secret);
    expect(() => cipher.decrypt('user-1', 'active', pending)).toThrow(
      SecretDecryptionError,
    );
  });

  it('detects tampering', () => {
    const cipher = cipherWith();
    const [version, iv, tag, body] = cipher
      .encrypt('user-1', 'active', secret)
      .split('.');
    const flipped = `${body[0] === 'A' ? 'B' : 'A'}${body.slice(1)}`;
    for (const tampered of [
      [version, iv, tag, flipped].join('.'),
      [version, iv, tag].join('.'),
      ['v2', iv, tag, body].join('.'),
      secret,
    ]) {
      expect(() => cipher.decrypt('user-1', 'active', tampered)).toThrow(
        SecretDecryptionError,
      );
    }
  });

  it('cannot decrypt under a different MFA_ENCRYPTION_KEY', () => {
    const encrypted = cipherWith().encrypt('user-1', 'active', secret);
    expect(() =>
      cipherWith({ MFA_ENCRYPTION_KEY: `${KEY}-other` }).decrypt(
        'user-1',
        'active',
        encrypted,
      ),
    ).toThrow(SecretDecryptionError);
  });

  it('is independent of the JWT secrets: rotating both keeps stored secrets readable', () => {
    const cipher = cipherWith();
    const encrypted = cipher.encrypt('user-1', 'active', secret);
    config.jwt_refresh_secret = 'rotated-refresh-secret-0123456789abcdef';
    config.jwt_access_secret = 'rotated-access-secret-0123456789abcdef';
    expect(cipher.decrypt('user-1', 'active', encrypted)).toBe(secret);
    config.jwt_refresh_secret = '';
    config.jwt_access_secret = '';
    expect(cipher.decrypt('user-1', 'active', encrypted)).toBe(secret);
  });

  it('never falls back to JWT_REFRESH_SECRET: without MFA_ENCRYPTION_KEY it fails closed', () => {
    // JWT_REFRESH_SECRET is set (beforeEach), and still nothing is encrypted.
    const cipher = cipherWith({});
    expect(() => cipher.encrypt('user-1', 'active', secret)).toThrow(
      MfaEncryptionUnavailableError,
    );
    const encrypted = cipherWith().encrypt('user-1', 'active', secret);
    expect(() => cipher.decrypt('user-1', 'active', encrypted)).toThrow(
      MfaEncryptionUnavailableError,
    );
    // Nor with the refresh secret passed as the key name's value elsewhere.
    expect(() =>
      cipherWith({ JWT_REFRESH_SECRET: config.jwt_refresh_secret }).encrypt(
        'user-1',
        'active',
        secret,
      ),
    ).toThrow(MfaEncryptionUnavailableError);
  });

  it('fails closed when the key is too short', () => {
    expect(() =>
      cipherWith({ MFA_ENCRYPTION_KEY: 'too-short' }).encrypt(
        'user-1',
        'active',
        secret,
      ),
    ).toThrow(MfaEncryptionUnavailableError);
  });
});
