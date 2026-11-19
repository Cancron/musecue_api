import { createHash } from 'node:crypto';
import config from '../../common/config/app.config';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  issueRecoveryCodes,
  normalizeRecoveryCode,
  RECOVERY_CODE_INPUT_PATTERN,
} from './mfa-recovery-codes';
import { MFA_RECOVERY_CODES } from './mfa.constants';

const DISPLAY_FORM =
  /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;

describe('MFA recovery codes', () => {
  const original = config.jwt_refresh_secret;
  beforeEach(() => {
    config.jwt_refresh_secret = 'mfa-recovery-unit-test-refresh-secret-01234';
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

  describe('hashing', () => {
    const code = 'ABCDE-FGHJK';

    it('stores 64 hex characters, not the code', () => {
      const hash = hashRecoveryCode('user-1', code);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is keyed: not a plain SHA-256 of the code', () => {
      const hash = hashRecoveryCode('user-1', code);
      for (const guess of [code, 'ABCDEFGHJK', `user-1\u0000ABCDEFGHJK`]) {
        expect(hash).not.toBe(createHash('sha256').update(guess).digest('hex'));
      }
      config.jwt_refresh_secret = 'another-refresh-secret-0123456789abcdefgh';
      expect(hashRecoveryCode('user-1', code)).not.toBe(hash);
    });

    it('matches however the user types the code', () => {
      const hash = hashRecoveryCode('user-1', code);
      expect(hashRecoveryCode('user-1', 'abcde-fghjk')).toBe(hash);
      expect(hashRecoveryCode('user-1', 'ABCDEFGHJK')).toBe(hash);
    });

    it("never matches another user's code", () => {
      expect(hashRecoveryCode('user-1', code)).not.toBe(
        hashRecoveryCode('user-2', code),
      );
    });

    it('refuses input that is not a code', () => {
      expect(() => hashRecoveryCode('user-1', 'nope')).toThrow(
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
    expect(stored).toEqual(codes.map((c) => hashRecoveryCode('user-1', c)));
    for (const hash of stored) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
