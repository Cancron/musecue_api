import { CreditPackageCode } from '@prisma/client';

/** Packages are priced in US dollars (amounts in whole cents). */
export const CREDIT_PACKAGE_CURRENCY = 'USD';

export interface CreditPackageDefault {
  code: CreditPackageCode;
  credits: number;
  priceUsdCents: number;
  available: boolean;
}

/**
 * The packages as migration 20261130120000_add_promotion_settings seeds
 * them; startup restores a missing package with these values. In display
 * order (the order of CreditPackageCode).
 */
export const CREDIT_PACKAGE_DEFAULTS: readonly CreditPackageDefault[] = [
  {
    code: CreditPackageCode.SMALL,
    credits: 250,
    priceUsdCents: 500,
    available: true,
  },
  {
    code: CreditPackageCode.MEDIUM,
    credits: 500,
    priceUsdCents: 1000,
    available: true,
  },
  {
    code: CreditPackageCode.LARGE,
    credits: 1000,
    priceUsdCents: 2000,
    available: true,
  },
];

/** Request validation bounds. */
export const CREDIT_PACKAGE_LIMITS = {
  CREDITS_MIN: 1,
  CREDITS_MAX: 1_000_000,
  /** $0.50, the smallest amount Stripe can charge in USD. */
  PRICE_USD_CENTS_MIN: 50,
  /** $9,999.99, the same ceiling as the Pro plan prices. */
  PRICE_USD_CENTS_MAX: 999_999,
} as const;

/** The package code named by a route parameter, or null if there is none. */
export function parseCreditPackageCode(
  value: string,
): CreditPackageCode | null {
  return (Object.values(CreditPackageCode) as string[]).includes(value)
    ? (value as CreditPackageCode)
    : null;
}

/**
 * Formats whole US cents as a decimal string with two decimal places, e.g.
 * 500 -> "5.00". Integer arithmetic only.
 */
export function formatUsdCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError(`Invalid USD cents amount: ${cents}`);
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
