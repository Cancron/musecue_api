import config from '../../common/config/app.config';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  issueRecoveryCodes,
  normalizeRecoveryCode,
  RECOVERY_CODE_INPUT_PATTERN,
  verifyRecoveryCode,
} from './mfa-recovery-codes';
import { MFA_RECOVERY_CODES } from './mfa.constants';

// Recovery codes use salted scrypt (deliberately slow, ~50-80 ms each), so
// tests that issue and verify many codes need more than the 5 s default
// when run alongside other suites.
jest.setTimeout(30_000);

const DISPLAY_FORM =
  /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;

describe('MFA recovery codes', () => {
  const original = config.jwt_refresh_secret;
  afterEach(() => {
    config.jwt_refresh_secret = original;
  });
  afterAll(() => {
    config.jwt_refresh_secret = original;
  });

  describe('generation', () => {
    it('issues ten distinct codes like ABCDE-FGHJK without look-alikes', () => {
      const codes = generateRecoveryCodes();

      expect(codes).toHaveLength(MFA_RECOVERY_CODES.COUNT);
      expect(new Set(codes).size).toBe(10);
      for (const code of codes) expect(code).toMatch(DISPLAY_FORM);
      expect(codes.join('')).not.toMatch(/[01ILO]/);
    });

    it('is random: no repeats across many sets', () => {
      const all = Array.from({ length: 200 }, () =>
        generateRecoveryCodes(),
      ).flat();
      expect(new Set(all).size).toBe(all.length);
    });

    it('uses the whole alphabet (uniform choice)', () => {
      const seen = new Set(
        Array.from({ length: 100 }, () => generateRecoveryCodes())
          .flat()
          .join('')
          .replace(/-/g, ''),
      );
      expect(seen.size).toBe(MFA_RECOVERY_CODES.ALPHABET.length);
    });
  });

  describe('input', () => {
    it.each([
      ['ABCDE-FGHJK', 'ABCDEFGHJK'],
      ['abcde-fghjk', 'ABCDEFGHJK'],
      ['ABCDEFGHJK', 'ABCDEFGHJK'],
      ['aBcDe-FgHjK', 'ABCDEFGHJK'],
    ])('normalizes %j to %j', (input, normalized) => {
      expect(normalizeRecoveryCode(input)).toBe(normalized);
    });

    it.each([
      '',
      'ABCDE-FGHJ',
      'ABCDE-FGHJKL',
      'ABCDE--FGHJK',
      ' ABCDE-FGHJK',
      'ABCDE FGHJK',
      'ABC-DEFGHJK',
      'ABCDE-FGHJ!',
      'ÄBCDE-FGHJK',
    ])('rejects %j', (input) => {
      expect(normalizeRecoveryCode(input)).toBeNull();
      expect(RECOVERY_CODE_INPUT_PATTERN.test(input)).toBe(false);
    });
  });

  describe('hashing (salted scrypt, no key)', () => {
    const code = 'ABCDE-FGHJK';

    it('stores scrypt$<log2 N>$<r>$<p>$<salt>$<hash>, never the code', async () => {
      const hash = await hashRecoveryCode('user-1', code);
      expect(hash).toMatch(
        /^scrypt\$14\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/,
      );
      expect(hash).not.toContain('ABCDE');
      expect(hash).not.toContain('FGHJK');
    });

    it('is salted: the same code never gives the same hash', async () => {
      const a = await hashRecoveryCode('user-1', code);
      const b = await hashRecoveryCode('user-1', code);
      expect(a).not.toBe(b);
      await expect(verifyRecoveryCode('user-1', code, a)).resolves.toBe(true);
      await expect(verifyRecoveryCode('user-1', code, b)).resolves.toBe(true);
    });

    it('verifies however the user types the code', async () => {
      const hash = await hashRecoveryCode('user-1', code);
      for (const typed of ['abcde-fghjk', 'ABCDEFGHJK', 'aBcDeFgHjK']) {
        await expect(verifyRecoveryCode('user-1', typed, hash)).resolves.toBe(
          true,
        );
      }
    });

    it('declines a wrong code, and another user', async () => {
      const hash = await hashRecoveryCode('user-1', code);
      await expect(
        verifyRecoveryCode('user-1', 'ABCDE-FGHJM', hash),
      ).resolves.toBe(false);
      await expect(verifyRecoveryCode('user-2', code, hash)).resolves.toBe(
        false,
      );
      await expect(verifyRecoveryCode('user-1', 'nope', hash)).resolves.toBe(
        false,
      );
    });

    it('does not depend on any application secret', async () => {
      const hash = await hashRecoveryCode('user-1', code);
      config.jwt_refresh_secret = 'a-rotated-refresh-secret-0123456789abcd';
      await expect(verifyRecoveryCode('user-1', code, hash)).resolves.toBe(
        true,
      );
      config.jwt_refresh_secret = '';
      await expect(verifyRecoveryCode('user-1', code, hash)).resolves.toBe(
        true,
      );
    });

    it.each([
      ['a legacy HMAC hash', 'a'.repeat(64)],
      ['garbage', 'scrypt$x$y$z$a$b'],
      [
        'an absurd cost (guards the CPU)',
        'scrypt$30$8$1$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(43),
      ],
      ['a truncated hash', 'scrypt$14$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA'],
    ])('never matches %s', async (_, stored) => {
      await expect(verifyRecoveryCode('user-1', code, stored)).resolves.toBe(
        false,
      );
    });

    it('refuses input that is not a code', async () => {
      await expect(hashRecoveryCode('user-1', 'nope')).rejects.toThrow(
        'Not a recovery code',
      );
    });
  });

  it('issues a set: stores only the hashes and returns the codes once', async () => {
    const replaceRecoveryCodes = jest.fn<Promise<void>, [string[]]>(() =>
      Promise.resolve(),
    );

    const codes = await issueRecoveryCodes({ replaceRecoveryCodes }, 'user-1');

    expect(replaceRecoveryCodes).toHaveBeenCalledTimes(1);
    const stored = replaceRecoveryCodes.mock.calls[0][0];
    expect(stored).toHaveLength(10);
    for (const [i, hash] of stored.entries()) {
      expect(hash).toMatch(/^scrypt\$/);
      await expect(verifyRecoveryCode('user-1', codes[i], hash)).resolves.toBe(
        true,
      );
    }
  });
});
