import { randomBytes } from 'node:crypto';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  InvalidTotpSecretError,
  otpauthUrl,
  totpCode,
  totpTimeStep,
  verifyTotp,
} from './totp';

// RFC 4226 / RFC 6238 reference secret (ASCII "12345678901234567890").
const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');
const RFC_SECRET = base32Encode(RFC_KEY);

/** Start of the 30-second step containing `ms`, plus `offsetMs`. */
const inStep = (step: number, offsetMs = 0) => step * 30_000 + offsetMs;

describe('TOTP (mfa)', () => {
  describe('base32 (RFC 4648)', () => {
    it.each([
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ])('encodes %j as %s (unpadded)', (plain, encoded) => {
      expect(base32Encode(Buffer.from(plain))).toBe(encoded);
      if (encoded) expect(base32Decode(encoded).toString()).toBe(plain);
    });

    it('tolerates lowercase, spaces and padding typed by a person', () => {
      expect(base32Decode('mzxw 6ytb oi======').toString()).toBe('foobar');
    });

    it.each(['', 'MZXW1', 'MZ0W', 'MZ8W', '====', 'ab-cd'])(
      'rejects %j',
      (input) => {
        expect(() => base32Decode(input)).toThrow(InvalidTotpSecretError);
      },
    );

    it('round-trips random secrets', () => {
      for (let i = 0; i < 50; i += 1) {
        const bytes = randomBytes(i + 1);
        expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
      }
    });
  });

  describe('secrets', () => {
    it('generates 160-bit base32 secrets, different every time', () => {
      const a = generateTotpSecret();
      const b = generateTotpSecret();
      expect(a).toMatch(/^[A-Z2-7]{32}$/);
      expect(base32Decode(a)).toHaveLength(20);
      expect(a).not.toBe(b);
    });
  });

  describe('HOTP (RFC 4226 appendix D)', () => {
    it.each([
      [0, '755224'],
      [1, '287082'],
      [2, '359152'],
      [3, '969429'],
      [4, '338314'],
      [5, '254676'],
      [6, '287922'],
      [7, '162583'],
      [8, '399871'],
      [9, '520489'],
    ])('counter %i -> %s', (counter, expected) => {
      expect(hotp(RFC_KEY, counter)).toBe(expected);
    });

    it('refuses negative or non-integer counters', () => {
      expect(() => hotp(RFC_KEY, -1)).toThrow(RangeError);
      expect(() => hotp(RFC_KEY, 1.5)).toThrow(RangeError);
    });
  });

  describe('TOTP (RFC 6238 appendix B, SHA1)', () => {
    it.each([
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ])('T=%i -> %s', (seconds, expected) => {
      const step = totpTimeStep(seconds * 1000);
      expect(hotp(RFC_KEY, step, 8)).toBe(expected);
      // The 6-digit code authenticator apps show is the low 6 digits.
      expect(totpCode(RFC_SECRET, step)).toBe(expected.slice(-6));
      expect(verifyTotp(RFC_SECRET, expected.slice(-6), seconds * 1000)).toBe(
        step,
      );
    });

    it('uses 30-second steps', () => {
      expect(totpTimeStep(0)).toBe(0);
      expect(totpTimeStep(29_999)).toBe(0);
      expect(totpTimeStep(30_000)).toBe(1);
      expect(totpTimeStep(new Date(60_000))).toBe(2);
    });
  });

  describe('verifyTotp', () => {
    const secret = generateTotpSecret();
    const step = 58_000_000;
    const code = totpCode(secret, step);

    it('accepts the current code for the whole of its 30-second step', () => {
      expect(verifyTotp(secret, code, inStep(step))).toBe(step);
      expect(verifyTotp(secret, code, inStep(step, 29_999))).toBe(step);
    });

    it('rejects the code once its 30 seconds are over (expired)', () => {
      expect(verifyTotp(secret, code, inStep(step + 1))).toBeNull();
      expect(verifyTotp(secret, code, inStep(step + 20))).toBeNull();
    });

    it('rejects a code of a future step', () => {
      expect(verifyTotp(secret, code, inStep(step - 1, 29_999))).toBeNull();
    });

    it('rejects a wrong code and a code of another secret', () => {
      const wrong = code === '000000' ? '000001' : '000000';
      expect(verifyTotp(secret, wrong, inStep(step))).toBeNull();
      expect(verifyTotp(generateTotpSecret(), code, inStep(step))).toBeNull();
    });

    it('rejects a code whose step was already used (replay)', () => {
      const now = inStep(step, 5_000);
      expect(verifyTotp(secret, code, now, { lastUsedStep: step })).toBeNull();
      expect(
        verifyTotp(secret, code, now, { lastUsedStep: step + 3 }),
      ).toBeNull();
      expect(verifyTotp(secret, code, now, { lastUsedStep: step - 1 })).toBe(
        step,
      );
      expect(verifyTotp(secret, code, now, { lastUsedStep: null })).toBe(step);
    });

    it('accepts neighbouring steps only when drift is explicitly allowed', () => {
      const later = inStep(step + 1, 1_000);
      expect(verifyTotp(secret, code, later)).toBeNull();
      expect(verifyTotp(secret, code, later, { driftSteps: 1 })).toBe(step);
    });

    it.each([
      '',
      '12345',
      '1234567',
      '12a456',
      ' 123456',
      '123456 ',
      '１２３４５６',
    ])('rejects the malformed code %j', (malformed) => {
      expect(verifyTotp(secret, malformed, inStep(step))).toBeNull();
    });
  });

  describe('otpauthUrl', () => {
    it('builds the key URI authenticator apps import', () => {
      const url = new URL(
        otpauthUrl({ secret: 'JBSWY3DPEHPK3PXP', accountName: 'a+b@x.io' }),
      );
      expect(url.protocol).toBe('otpauth:');
      expect(url.host).toBe('totp');
      expect(decodeURIComponent(url.pathname)).toBe('/MuseCue:a+b@x.io');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        secret: 'JBSWY3DPEHPK3PXP',
        issuer: 'MuseCue',
        algorithm: 'SHA1',
        digits: '6',
        period: '30',
      });
    });

    it('encodes the issuer and account name in the label', () => {
      const url = otpauthUrl({
        secret: 'JBSWY3DPEHPK3PXP',
        accountName: 'a:b c',
        issuer: 'Muse Cue',
      });
      expect(url.startsWith('otpauth://totp/Muse%20Cue:a%3Ab%20c?')).toBe(true);
    });
  });
});
