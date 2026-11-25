import { ConfigService } from '@nestjs/config';
import config from '../../common/config/app.config';
import { MfaEncryptionUnavailableError } from './mfa-keys';
import { MfaRecoveryCodeHasher } from './mfa-recovery-code.hasher';

const KEY = 'mfa-recovery-hasher-spec-key-0123456789abcdef';
const hasherWith = (
  env: Record<string, string> = { MFA_ENCRYPTION_KEY: KEY },
) => new MfaRecoveryCodeHasher(new ConfigService(env));

describe('MfaRecoveryCodeHasher (mfa)', () => {
  const originalRefresh = config.jwt_refresh_secret;
  beforeEach(() => {
    config.jwt_refresh_secret = 'mfa-recovery-hasher-refresh-0123456789';
  });
  afterAll(() => {
    config.jwt_refresh_secret = originalRefresh;
  });

  it('issues 10 codes with their hashes (lowercase hex, no code inside)', () => {
    const { codes, hashes } = hasherWith().issue('user-1');
    expect(codes).toHaveLength(10);
    expect(hashes).toHaveLength(10);
    expect(new Set(hashes).size).toBe(10);
    codes.forEach((code, i) => {
      expect(hashes[i]).toMatch(/^[0-9a-f]{64}$/);
      expect(hashes[i]).toBe(hasherWith().hash('user-1', code));
      expect(hashes[i].toUpperCase()).not.toContain(code.replace(/-/g, ''));
    });
  });

  it('hashes every accepted way of typing a code identically', () => {
    const hasher = hasherWith();
    const expected = hasher.hash('user-1', 'ABCD-2345-WXYZ');
    for (const typed of [
      'abcd2345wxyz',
      'ABCD 2345 WXYZ',
      ' abcd-2345-WXYZ ',
    ]) {
      expect(hasher.hash('user-1', typed)).toBe(expected);
    }
  });

  it("binds the hash to the user: one account's code never matches another's", () => {
    const hasher = hasherWith();
    expect(hasher.hash('user-1', 'ABCD-2345-WXYZ')).not.toBe(
      hasher.hash('user-2', 'ABCD-2345-WXYZ'),
    );
  });

  it('is keyed: without the server key the hash cannot be recomputed', () => {
    expect(hasherWith().hash('user-1', 'ABCD-2345-WXYZ')).not.toBe(
      hasherWith({ MFA_ENCRYPTION_KEY: `${KEY}-other` }).hash(
        'user-1',
        'ABCD-2345-WXYZ',
      ),
    );
    // Separate from the secret-encryption key and the fallback root.
    expect(hasherWith().hash('user-1', 'ABCD-2345-WXYZ')).not.toBe(
      hasherWith({}).hash('user-1', 'ABCD-2345-WXYZ'),
    );
  });

  it('returns null for anything that cannot be a recovery code', () => {
    expect(hasherWith().hash('user-1', '123456')).toBeNull();
    expect(hasherWith().hash('user-1', 'ABCD-2345-WXYU')).toBeNull();
  });

  it('fails closed without a usable key', () => {
    expect(() =>
      hasherWith({ MFA_ENCRYPTION_KEY: 'short' }).hash('u', 'ABCD-2345-WXYZ'),
    ).toThrow(MfaEncryptionUnavailableError);
    config.jwt_refresh_secret = '';
    expect(() => hasherWith({}).hash('u', 'ABCD-2345-WXYZ')).toThrow(
      MfaEncryptionUnavailableError,
    );
  });
});
