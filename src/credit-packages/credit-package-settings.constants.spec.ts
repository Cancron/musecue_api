import {
  CREDIT_PACKAGE_DEFAULTS,
  formatUsdCents,
  parseCreditPackageCode,
} from './credit-package-settings.constants';

describe('credit package constants', () => {
  it('defaults to 250 credits for $5, 500 for $10 and 1,000 for $20, all available', () => {
    expect(CREDIT_PACKAGE_DEFAULTS).toEqual([
      { code: 'SMALL', credits: 250, priceUsdCents: 500, available: true },
      { code: 'MEDIUM', credits: 500, priceUsdCents: 1000, available: true },
      { code: 'LARGE', credits: 1000, priceUsdCents: 2000, available: true },
    ]);
  });

  it.each([
    [500, '5.00'],
    [1000, '10.00'],
    [2000, '20.00'],
    [50, '0.50'],
    [999, '9.99'],
    [1205, '12.05'],
    [999_999, '9999.99'],
  ])('formats %i cents as "%s"', (cents, dollars) => {
    expect(formatUsdCents(cents)).toBe(dollars);
  });

  it.each([-1, 1.5, Number.NaN])('refuses to format %p cents', (cents) => {
    expect(() => formatUsdCents(cents)).toThrow(RangeError);
  });

  it.each(['SMALL', 'MEDIUM', 'LARGE'])('recognizes the code %s', (code) => {
    expect(parseCreditPackageCode(code)).toBe(code);
  });

  it.each(['small', 'HUGE', '', '1', 'constructor', '__proto__'])(
    'does not recognize %p',
    (code) => {
      expect(parseCreditPackageCode(code)).toBeNull();
    },
  );
});
