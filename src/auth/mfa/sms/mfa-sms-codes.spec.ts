import { randomBytes } from 'node:crypto';
import { testCipher } from '../../../../test/support/mfa-test-keys';
import {
  MfaKeyUnavailableError,
  MfaSecretCipher,
  MfaSecretDecryptionError,
} from '../mfa-secret.cipher';
import {
  generateSmsCode,
  maskedPhone,
  normalizePhoneNumber,
  phoneHintOf,
  recentTimes,
  smsLimit,
  smsMessage,
  withUse,
} from './mfa-sms-codes';
import { MFA_SMS } from './mfa-sms.constants';

const T0 = new Date('2026-11-28T10:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe('MFA SMS codes and numbers', () => {
  describe('codes', () => {
    it('are six digits from the CSPRNG, with leading zeros', () => {
      const codes = Array.from({ length: 2000 }, generateSmsCode);
      for (const code of codes) expect(code).toMatch(/^\d{6}$/);
      // Uniform over a million values: 2000 draws are almost all distinct.
      expect(new Set(codes).size).toBeGreaterThan(1990);
      expect(codes.some((code) => code.startsWith('0'))).toBe(true);
    });

    it('the SMS text carries the code and its lifetime, nothing else', () => {
      const text = smsMessage('012345', 'sign_in');
      expect(text).toBe(
        'Your MuseCue sign-in code is 012345. It expires in 5 minutes. Never share it; MuseCue will never ask you for it.',
      );
      expect(smsMessage('012345', 'phone')).toMatch(
        /^Your MuseCue phone verification code is 012345\./,
      );
    });

    it('limits: 5 minutes, 3 deliveries and 5 attempts per 15 minutes', () => {
      expect(MFA_SMS).toMatchObject({
        CODE_TTL_MS: 5 * 60_000,
        MAX_DELIVERIES: 3,
        MAX_ATTEMPTS: 5,
        WINDOW_MS: 15 * 60_000,
      });
    });
  });

  describe('phone numbers', () => {
    it.each([
      ['+14155550123', '+14155550123'],
      ['+1 (415) 555-0123', '+14155550123'],
      ['+44 20 7946 0958', '+442079460958'],
      [' +49.30.1234567 ', '+49301234567'],
    ])('normalizes %p to %p (E.164)', (input, e164) => {
      expect(normalizePhoneNumber(input)).toBe(e164);
    });

    it.each([
      '4155550123',
      '+0123456789',
      '+1 415',
      '+1415555012345678',
      '+1-415-555-0123 ext. 7',
      'tel:+14155550123',
      '',
    ])('rejects %p', (input) => {
      expect(normalizePhoneNumber(input)).toBeNull();
    });

    it('shows only the last two digits', () => {
      expect(phoneHintOf('+14155550123')).toBe('23');
      expect(maskedPhone('23')).toBe('••••••••23');
    });
  });

  describe('sliding 15-minute limits', () => {
    it('count only the last 15 minutes', () => {
      expect(recentTimes([at(-16), at(-15), at(-14), at(0)], T0)).toEqual([
        at(-14),
        at(0),
      ]);
    });

    it('tell what is left and when the next use is allowed', () => {
      expect(smsLimit([], T0, 3)).toEqual({ remaining: 3, retryAt: null });
      expect(smsLimit([at(-10), at(-5)], T0, 3)).toEqual({
        remaining: 1,
        retryAt: null,
      });
      expect(smsLimit([at(-10), at(-5), at(-1)], T0, 3)).toEqual({
        remaining: 0,
        retryAt: at(5),
      });
      // Old uses no longer count.
      expect(smsLimit([at(-20), at(-5), at(-1)], T0, 3).remaining).toBe(1);
    });

    it('record a use, keeping only what counts', () => {
      expect(withUse([at(-20), at(-10)], T0, 3)).toEqual([at(-10), T0]);
      expect(withUse([at(-3), at(-2), at(-1)], T0, 3)).toEqual([
        at(-2),
        at(-1),
        T0,
      ]);
    });
  });

  describe('stored form (HMAC under the MFA key)', () => {
    const binding = 'alice\u0000phone-1\u0000code-1\u0000LOGIN';

    it('is an HMAC bound to the code record, never the code', () => {
      const cipher = testCipher();
      const stored = cipher.hashSmsCode(binding, '123456');

      expect(stored).toMatch(/^smsh1\.[0-9a-f]{16}\.[0-9a-f]{64}$/);
      expect(stored).not.toContain('123456');
      expect(cipher.verifySmsCode(stored, binding, '123456')).toBe(true);
      expect(cipher.verifySmsCode(stored, binding, '123457')).toBe(false);
      // Another user, number, record or purpose: no match.
      for (const other of [
        'bob\u0000phone-1\u0000code-1\u0000LOGIN',
        'alice\u0000phone-2\u0000code-1\u0000LOGIN',
        'alice\u0000phone-1\u0000code-2\u0000LOGIN',
        'alice\u0000phone-1\u0000code-1\u0000PHONE_VERIFICATION',
      ]) {
        expect(cipher.verifySmsCode(stored, other, '123456')).toBe(false);
      }
      // Equal codes of different records differ.
      expect(cipher.hashSmsCode(binding, '123456')).toBe(stored);
      expect(
        cipher.hashSmsCode(
          'alice\u0000phone-1\u0000code-2\u0000LOGIN',
          '123456',
        ),
      ).not.toBe(stored);
    });

    it('verifies under a previous key after rotation, not under an unknown one', () => {
      const oldKey = randomBytes(32);
      const stored = testCipher(oldKey).hashSmsCode(binding, '123456');

      expect(
        testCipher(randomBytes(32), oldKey).verifySmsCode(
          stored,
          binding,
          '123456',
        ),
      ).toBe(true);
      expect(
        testCipher(randomBytes(32)).verifySmsCode(stored, binding, '123456'),
      ).toBe(false);
      expect(
        testCipher(oldKey).verifySmsCode(
          stored.replace('smsh1', 'smsh2'),
          binding,
          '123456',
        ),
      ).toBe(false);
    });

    it('needs MFA_ENCRYPTION_KEY', () => {
      const cipher = new MfaSecretCipher({
        currentKeyId: null,
        keys: new Map(),
      });
      expect(() => cipher.hashSmsCode(binding, '123456')).toThrow(
        MfaKeyUnavailableError,
      );
    });

    it('phone numbers are encrypted for their user and role', () => {
      const cipher = testCipher();
      const stored = cipher.encrypt('sms-phone', 'alice', '+14155550123');

      expect(stored).not.toContain('4155550123');
      expect(cipher.decrypt('sms-phone', 'alice', stored)).toBe('+14155550123');
      expect(() => cipher.decrypt('sms-phone', 'bob', stored)).toThrow(
        MfaSecretDecryptionError,
      );
      expect(() => cipher.decrypt('confirmed', 'alice', stored)).toThrow(
        MfaSecretDecryptionError,
      );
    });
  });
});
