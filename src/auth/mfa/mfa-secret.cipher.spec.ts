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

const DEDICATED_KEY = 'mfa-unit-test-dedicated-key-0123456789abcdef';

const cipherWith = (env: Record<string, string | undefined>) =>
  new MfaSecretCipher(new ConfigService(env));

describe('MfaSecretCipher (mfa)', () => {
  const originalRefreshSecret = config.jwt_refresh_secret;
  const secret = generateTotpSecret();

  beforeEach(() => {
    config.jwt_refresh_secret = 'mfa-unit-test-refresh-secret-0123456789';
  });
  afterAll(() => {
    config.jwt_refresh_secret = originalRefreshSecret;
  });

  it.each([
    ['a dedicated MFA_ENCRYPTION_KEY', { MFA_ENCRYPTION_KEY: DEDICATED_KEY }],
    ['the JWT_REFRESH_SECRET fallback', {}],
  ])('encrypts and decrypts with %s', (_name, env) => {
    const cipher = cipherWith(env);
    const encrypted = cipher.encrypt('user-1', 'active', secret);

    expect(encrypted).toMatch(STORED_FORMAT);
    expect(encrypted).not.toContain(secret);
    expect(encrypted.toLowerCase()).not.toContain(secret.toLowerCase());
    expect(cipher.decrypt('user-1', 'active', encrypted)).toBe(secret);
  });

  it('uses a fresh IV for every encryption', () => {
    const cipher = cipherWith({});
    const a = cipher.encrypt('user-1', 'active', secret);
    const b = cipher.encrypt('user-1', 'active', secret);
    expect(a).not.toBe(b);
  });

  it('binds a ciphertext to its user: it cannot be moved to another account', () => {
    const cipher = cipherWith({});
    const encrypted = cipher.encrypt('user-1', 'active', secret);
    expect(() => cipher.decrypt('user-2', 'active', encrypted)).toThrow(
      SecretDecryptionError,
    );
  });

  it('binds a ciphertext to its slot (pending enrollment vs confirmed)', () => {
    const cipher = cipherWith({});
    const pending = cipher.encrypt('user-1', 'enrollment', secret);
    expect(() => cipher.decrypt('user-1', 'active', pending)).toThrow(
      SecretDecryptionError,
    );
  });

  it('detects tampering', () => {
    const cipher = cipherWith({});
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

  it('keeps the dedicated key and the fallback key apart', () => {
    const dedicated = cipherWith({ MFA_ENCRYPTION_KEY: DEDICATED_KEY });
    const fallback = cipherWith({});
    const encrypted = dedicated.encrypt('user-1', 'active', secret);
    expect(() => fallback.decrypt('user-1', 'active', encrypted)).toThrow(
      SecretDecryptionError,
    );
  });

  it('derives an MFA-specific key: rotating JWT_REFRESH_SECRET makes fallback-encrypted secrets unreadable', () => {
    const cipher = cipherWith({});
    const encrypted = cipher.encrypt('user-1', 'active', secret);
    config.jwt_refresh_secret = 'another-refresh-secret-0123456789abcdef';
    expect(() => cipher.decrypt('user-1', 'active', encrypted)).toThrow(
      SecretDecryptionError,
    );
  });

  it('is unaffected by JWT_REFRESH_SECRET when the dedicated key is set', () => {
    const cipher = cipherWith({ MFA_ENCRYPTION_KEY: DEDICATED_KEY });
    const encrypted = cipher.encrypt('user-1', 'active', secret);
    config.jwt_refresh_secret = 'another-refresh-secret-0123456789abcdef';
    expect(cipher.decrypt('user-1', 'active', encrypted)).toBe(secret);
  });

  it('fails closed when the dedicated key is too short', () => {
    const cipher = cipherWith({ MFA_ENCRYPTION_KEY: 'too-short' });
    expect(() => cipher.encrypt('user-1', 'active', secret)).toThrow(
      MfaEncryptionUnavailableError,
    );
  });

  it('fails closed when no key is configured at all', () => {
    config.jwt_refresh_secret = '';
    const cipher = cipherWith({});
    expect(() => cipher.encrypt('user-1', 'active', secret)).toThrow(
      MfaEncryptionUnavailableError,
    );
  });
});
