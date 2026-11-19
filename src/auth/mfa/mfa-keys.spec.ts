import { randomBytes } from 'node:crypto';
import {
  InvalidMfaKeyConfigError,
  loadMfaKeyring,
  mfaKeyId,
  parseMfaKey,
} from './mfa-keys';

describe('MFA key configuration', () => {
  const key = randomBytes(32);

  it.each([
    ['hex', key.toString('hex')],
    ['base64', key.toString('base64')],
    ['base64url', key.toString('base64url')],
    ['base64 with spaces around', ` ${key.toString('base64')} `],
  ])('accepts a 32-byte key as %s', (_, raw) => {
    expect(parseMfaKey(raw, 'MFA_ENCRYPTION_KEY').equals(key)).toBe(true);
  });

  it.each([
    ['too short', randomBytes(16).toString('base64')],
    ['too long', randomBytes(48).toString('base64')],
    ['a passphrase', 'correct horse battery staple, but longer than 32'],
    ['all zeros', Buffer.alloc(32).toString('hex')],
    ['empty', ''],
  ])('rejects %s, naming the variable but never the value', (_, raw) => {
    let error: unknown;
    try {
      parseMfaKey(raw, 'MFA_ENCRYPTION_KEY');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InvalidMfaKeyConfigError);
    expect((error as Error).message).toContain('MFA_ENCRYPTION_KEY');
    if (raw) expect((error as Error).message).not.toContain(raw.trim());
  });

  it('loads the current and previous keys', () => {
    const previous = [randomBytes(32), randomBytes(32)];
    const ring = loadMfaKeyring({
      MFA_ENCRYPTION_KEY: key.toString('base64'),
      MFA_ENCRYPTION_PREVIOUS_KEYS: previous
        .map((k) => k.toString('hex'))
        .join(', '),
    });
    expect(ring.currentKeyId).toBe(mfaKeyId(key));
    expect([...ring.keys.keys()].sort()).toEqual(
      [key, ...previous].map(mfaKeyId).sort(),
    );
  });

  it('allows MFA to be unconfigured', () => {
    expect(loadMfaKeyring({})).toEqual({ currentKeyId: null, keys: new Map() });
  });

  it('refuses previous keys without a current key', () => {
    expect(() =>
      loadMfaKeyring({ MFA_ENCRYPTION_PREVIOUS_KEYS: key.toString('hex') }),
    ).toThrow('MFA_ENCRYPTION_PREVIOUS_KEYS requires MFA_ENCRYPTION_KEY');
  });

  it('refuses a key that reuses a JWT secret (it must be independent)', () => {
    const shared = key.toString('base64');
    for (const jwt of ['JWT_REFRESH_SECRET', 'JWT_ACCESS_SECRET']) {
      expect(() =>
        loadMfaKeyring({ MFA_ENCRYPTION_KEY: shared, [jwt]: shared }),
      ).toThrow(`MFA_ENCRYPTION_KEY must be a different key from ${jwt}`);
    }
  });

  it('gives different keys different IDs, and reveals nothing of the key', () => {
    const id = mfaKeyId(key);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(mfaKeyId(randomBytes(32))).not.toBe(id);
    expect(key.toString('hex')).not.toContain(id);
  });
});
