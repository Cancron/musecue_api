import { Prisma } from '@prisma/client';
import {
  formatCredits,
  InvalidCreditAmountError,
  parseCreditAmount,
  sumCredits,
} from './credit-amount';

describe('credit amounts', () => {
  describe('parseCreditAmount', () => {
    it.each([
      ['1', '1'],
      ['0.5', '0.5'],
      ['0.000001', '0.000001'],
      ['12.345678', '12.345678'],
      ['1000000000', '1000000000'],
      [0.1, '0.1'],
      [2.75, '2.75'],
      [1e-6, '0.000001'],
    ])('accepts %p exactly as %s', (input, expected) => {
      expect(parseCreditAmount(input).toFixed()).toBe(expected);
    });

    it('accepts a Prisma.Decimal unchanged', () => {
      const value = new Prisma.Decimal('3.25');
      expect(parseCreditAmount(value).eq(value)).toBe(true);
    });

    it.each([
      ['zero', 0],
      ['a negative amount', -1],
      ['a negative string', '-0.5'],
      ['more than six decimal places', '0.0000001'],
      ['a float with more than six decimal places', 0.1234567],
      ['above the maximum', '1000000000.000001'],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['text', 'ten'],
      ['an empty string', ''],
      ['padded text', ' 5'],
    ])('rejects %s without rounding', (_case, input) => {
      expect(() => parseCreditAmount(input)).toThrow(InvalidCreditAmountError);
    });
  });

  describe('exact fractional arithmetic', () => {
    it('adds 0.1 and 0.2 to exactly 0.3 (unlike floating point)', () => {
      expect(0.1 + 0.2).not.toBe(0.3);
      expect(formatCredits(sumCredits(['0.1', '0.2']))).toBe('0.3');
    });

    it('keeps a million micro-credit debits exact', () => {
      const total = sumCredits(Array<string>(1_000).fill('0.000001')).times(
        1_000,
      );
      expect(formatCredits(total)).toBe('1');
    });

    it('sums mixed inputs', () => {
      expect(
        formatCredits(
          sumCredits([new Prisma.Decimal('49.999999'), '0.000001', 0.5]),
        ),
      ).toBe('50.5');
    });

    it('sums nothing to zero', () => {
      expect(formatCredits(sumCredits([]))).toBe('0');
    });
  });

  describe('formatCredits', () => {
    it.each([
      ['50.000000', '50'],
      ['0.000001', '0.000001'],
      ['1e-6', '0.000001'],
      ['-12.500000', '-12.5'],
    ])(
      'formats %s as %s (no exponent, no trailing zeros)',
      (input, expected) => {
        expect(formatCredits(input)).toBe(expected);
      },
    );
  });
});
