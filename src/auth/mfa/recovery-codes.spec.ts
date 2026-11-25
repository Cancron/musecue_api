import {
  formatRecoveryCode,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  RECOVERY_CODE_ALPHABET,
} from './recovery-codes';

describe('MFA recovery codes (mfa)', () => {
  it('generates 10 distinct codes formatted XXXX-XXXX-XXXX', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(
        /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
      );
    }
  });

  it('uses the unambiguous Crockford alphabet (no I, L, O or U)', () => {
    expect(RECOVERY_CODE_ALPHABET).toHaveLength(32);
    expect(RECOVERY_CODE_ALPHABET).not.toMatch(/[ILOU]/);
    const seen = new Set(generateRecoveryCodes(400).join('').replace(/-/g, ''));
    // 4800 random characters cover the whole alphabet and nothing else.
    expect([...seen].sort().join('')).toBe(RECOVERY_CODE_ALPHABET);
  });

  it('never repeats codes across sets', () => {
    const all = Array.from({ length: 50 }, () =>
      generateRecoveryCodes(),
    ).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it('formats and normalizes round trip', () => {
    expect(formatRecoveryCode('ABCD2345WXYZ')).toBe('ABCD-2345-WXYZ');
    for (const code of generateRecoveryCodes()) {
      expect(formatRecoveryCode(normalizeRecoveryCode(code)!)).toBe(code);
    }
  });

  it.each([
    ['ABCD-2345-WXYZ', 'ABCD2345WXYZ'],
    ['abcd-2345-wxyz', 'ABCD2345WXYZ'],
    ['ABCD 2345 WXYZ', 'ABCD2345WXYZ'],
    [' ABCD2345WXYZ ', 'ABCD2345WXYZ'],
    // Look-alikes typed from a printout read as digits.
    ['OBCD-I345-LXYZ', '0BCD1345' + '1XYZ'],
  ])('normalizes %j to %s', (input, expected) => {
    expect(normalizeRecoveryCode(input)).toBe(expected);
  });

  it.each([
    '',
    'ABCD-2345',
    'ABCD-2345-WXYZ-2',
    'ABCD-2345-WXYU', // U is not in the alphabet
    'ABCD-2345-WXY!',
    '123456',
  ])('rejects %j', (input) => {
    expect(normalizeRecoveryCode(input)).toBeNull();
  });
});
