import config from '../config/app.config';
import {
  decryptSecret,
  deriveKey,
  encryptSecret,
  hexDigestsEqual,
  keyedHash,
  MissingRootSecretError,
  SECRET_PURPOSES,
  SecretDecryptionError,
} from './derived-secrets';

describe('Derived secrets', () => {
  const original = config.jwt_refresh_secret;
  beforeEach(() => {
    config.jwt_refresh_secret = 'derived-secrets-spec-root-secret';
  });
  afterAll(() => {
    config.jwt_refresh_secret = original;
  });

  it('derives a separate 32-byte key per purpose, never the root secret', () => {
    const keys = Object.values(SECRET_PURPOSES).map((purpose) =>
      deriveKey(purpose).toString('hex'),
    );
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key).toHaveLength(64);
      expect(key).not.toContain(
        Buffer.from(config.jwt_refresh_secret).toString('hex'),
      );
    }
  });

  it('changes every derived value when the root secret is rotated', () => {
    const before = keyedHash(SECRET_PURPOSES.AUTH_CHALLENGE, 'code');
    config.jwt_refresh_secret = 'rotated-root-secret';
    expect(keyedHash(SECRET_PURPOSES.AUTH_CHALLENGE, 'code')).not.toBe(before);
  });

  it('binds keyed hashes to their purpose', () => {
    expect(keyedHash(SECRET_PURPOSES.AUTH_CHALLENGE, 'x')).not.toBe(
      keyedHash(SECRET_PURPOSES.RATE_LIMIT_KEY, 'x'),
    );
    expect(keyedHash(SECRET_PURPOSES.AUTH_CHALLENGE, 'x')).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('refuses to derive anything without a root secret', () => {
    config.jwt_refresh_secret = '';
    expect(() => keyedHash(SECRET_PURPOSES.RATE_LIMIT_KEY, 'x')).toThrow(
      MissingRootSecretError,
    );
  });

  it('compares digests in constant time and rejects malformed input', () => {
    const digest = keyedHash(SECRET_PURPOSES.AUTH_CHALLENGE, 'a');
    expect(hexDigestsEqual(digest, digest)).toBe(true);
    expect(
      hexDigestsEqual(digest, keyedHash(SECRET_PURPOSES.AUTH_CHALLENGE, 'b')),
    ).toBe(false);
    expect(hexDigestsEqual(digest, digest.slice(0, 10))).toBe(false);
    expect(hexDigestsEqual('', '')).toBe(false);
  });

  describe('AES-256-GCM encryption', () => {
    const purpose = SECRET_PURPOSES.JOB_PAYLOAD;

    it('round-trips without exposing the plaintext, with a fresh IV each time', () => {
      const plaintext = JSON.stringify({ verificationCode: 'A1B2C3' });
      const first = encryptSecret(purpose, plaintext, 'email:job-1');
      const second = encryptSecret(purpose, plaintext, 'email:job-1');

      expect(first).toMatch(/^v1\./);
      expect(first).not.toContain('A1B2C3');
      expect(first).not.toBe(second);
      expect(decryptSecret(purpose, first, 'email:job-1')).toBe(plaintext);
    });

    it('rejects ciphertext moved to another record (associated data)', () => {
      const encrypted = encryptSecret(purpose, 'payload', 'email:job-1');
      expect(() => decryptSecret(purpose, encrypted, 'email:job-2')).toThrow(
        SecretDecryptionError,
      );
    });

    it('rejects ciphertext of another purpose or root secret', () => {
      const encrypted = encryptSecret(purpose, 'payload', 'aad');
      expect(() =>
        decryptSecret(SECRET_PURPOSES.OAUTH_STATE, encrypted, 'aad'),
      ).toThrow(SecretDecryptionError);
      config.jwt_refresh_secret = 'another-root-secret';
      expect(() => decryptSecret(purpose, encrypted, 'aad')).toThrow(
        SecretDecryptionError,
      );
    });

    it('detects tampering and malformed values', () => {
      const encrypted = encryptSecret(purpose, 'payload', 'aad');
      const parts = encrypted.split('.');
      const body = Buffer.from(parts[3], 'base64url');
      body[0] ^= 0xff;
      const tampered = [...parts.slice(0, 3), body.toString('base64url')].join(
        '.',
      );
      expect(() => decryptSecret(purpose, tampered, 'aad')).toThrow(
        SecretDecryptionError,
      );
      for (const malformed of ['', 'v1.a.b', 'v2.a.b.c', 'v1.!.!.!']) {
        expect(() => decryptSecret(purpose, malformed, 'aad')).toThrow(
          SecretDecryptionError,
        );
      }
    });
  });
});
