import {
  base32Decode,
  base32Encode,
  buildOtpAuthUri,
  generateTotpSecret,
  totpCode,
  totpCodeForStep,
  totpStep,
  totpStepEndsAt,
  verifyTotp,
} from './mfa-totp';

/** RFC 6238 Appendix B: the SHA-1 seed "12345678901234567890". */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
const at = (unixSeconds: number) => new Date(unixSeconds * 1000);
/** The start of a 30-second step, well away from any special date. */
const STEP_START = at(1_800_000_000 - (1_800_000_000 % 30));

describe('MFA TOTP (RFC 6238)', () => {
  describe('base32 (RFC 4648)', () => {
    it.each([
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ])('encodes %j as %j without padding and decodes it back', (raw, b32) => {
      expect(base32Encode(Buffer.from(raw))).toBe(b32);
      expect(base32Decode(b32).toString()).toBe(raw);
    });

    it('decodes lowercase and padded input', () => {
      expect(base32Decode('mzxw6ytboi======').toString()).toBe('foobar');
    });

    it('rejects characters outside the alphabet', () => {
      expect(() => base32Decode('MZXW1')).toThrow('Invalid base32 character');
    });
  });

  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('matches the RFC 6238 test vector at T=%i', (seconds, expected) => {
    expect(totpCodeForStep(RFC_SECRET, totpStep(at(seconds)), 8)).toBe(
      expected,
    );
    // Six digits are the last six of the same value.
    expect(totpCode(RFC_SECRET, at(seconds))).toBe(expected.slice(-6));
  });

  it('generates random 160-bit base32 secrets', () => {
    const secrets = new Set(
      Array.from({ length: 50 }, () => generateTotpSecret()),
    );
    expect(secrets.size).toBe(50);
    for (const secret of secrets) {
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(base32Decode(secret)).toHaveLength(20);
    }
  });

  describe('time steps', () => {
    it('are 30 seconds long', () => {
      const step = totpStep(STEP_START);
      expect(totpStep(new Date(STEP_START.getTime() + 29_999))).toBe(step);
      expect(totpStep(new Date(STEP_START.getTime() + 30_000))).toBe(step + 1);
      expect(totpStep(new Date(STEP_START.getTime() - 1))).toBe(step - 1);
      expect(totpStepEndsAt(new Date(STEP_START.getTime() + 12_345))).toEqual(
        new Date(STEP_START.getTime() + 30_000),
      );
    });
  });

  describe('verifyTotp', () => {
    const secret = generateTotpSecret();
    const code = totpCode(secret, STEP_START);

    it('accepts the current code for the whole of its 30-second step', () => {
      const step = totpStep(STEP_START);
      expect(verifyTotp(secret, code, STEP_START)).toEqual({
        result: 'VALID',
        step,
      });
      expect(
        verifyTotp(secret, code, new Date(STEP_START.getTime() + 29_999)),
      ).toEqual({ result: 'VALID', step });
    });

    it('rejects the code once its 30 seconds are over (expired)', () => {
      expect(
        verifyTotp(secret, code, new Date(STEP_START.getTime() + 30_000)),
      ).toEqual({ result: 'INVALID' });
      expect(
        verifyTotp(secret, code, new Date(STEP_START.getTime() + 45_000)),
      ).toEqual({ result: 'INVALID' });
    });

    it('rejects a code before its step starts (no clock-drift window)', () => {
      const next = totpCode(secret, new Date(STEP_START.getTime() + 30_000));
      expect(verifyTotp(secret, next, STEP_START)).toEqual({
        result: 'INVALID',
      });
    });

    it('rejects a wrong code', () => {
      const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
      expect(verifyTotp(secret, wrong, STEP_START)).toEqual({
        result: 'INVALID',
      });
    });

    it('rejects the code of another secret', () => {
      const other = generateTotpSecret();
      const otherCode = totpCode(other, STEP_START);
      // Astronomically unlikely to collide; guard the assertion anyway.
      if (otherCode !== code) {
        expect(verifyTotp(secret, otherCode, STEP_START)).toEqual({
          result: 'INVALID',
        });
      }
    });

    it.each(['', '12345', '1234567', 'abcdef', '12 456', '١٢٣٤٥٦', '+12345'])(
      'rejects the malformed code %j',
      (malformed) => {
        expect(verifyTotp(secret, malformed, STEP_START)).toEqual({
          result: 'INVALID',
        });
      },
    );

    it('never accepts an already used step again (replay)', () => {
      const step = totpStep(STEP_START);
      expect(verifyTotp(secret, code, STEP_START, step)).toEqual({
        result: 'REUSED',
      });
      expect(verifyTotp(secret, code, STEP_START, step + 1)).toEqual({
        result: 'REUSED',
      });
      expect(verifyTotp(secret, code, STEP_START, step - 1)).toEqual({
        result: 'VALID',
        step,
      });
    });
  });

  it('builds the otpauth:// URI authenticator apps import', () => {
    const uri = new URL(buildOtpAuthUri(RFC_SECRET, 'ann+mfa@example.com'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe(
      '/MuseCue:ann+mfa@example.com',
    );
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: RFC_SECRET,
      issuer: 'MuseCue',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
  });
});
