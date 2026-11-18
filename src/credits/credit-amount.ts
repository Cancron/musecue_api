import { Prisma } from '@prisma/client';

/** A credit amount as accepted from callers; converted to Prisma.Decimal. */
export type CreditAmountInput = Prisma.Decimal | string | number;

/** Decimal places stored for credit amounts (NUMERIC(18, 6)). */
export const CREDIT_DECIMAL_PLACES = 6;

/** Largest single grant or debit; well below the NUMERIC(18, 6) range. */
export const CREDIT_AMOUNT_MAX = new Prisma.Decimal('1000000000');

export const ZERO_CREDITS = new Prisma.Decimal(0);

export class InvalidCreditAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCreditAmountError';
  }
}

/**
 * Parses a positive credit amount with at most six decimal places. Amounts
 * are never rounded: an amount that cannot be stored exactly is rejected.
 * Numbers are converted through their shortest decimal representation
 * (0.1 -> "0.1"), so no binary floating-point error is introduced.
 */
export function parseCreditAmount(value: CreditAmountInput): Prisma.Decimal {
  let amount: Prisma.Decimal;
  try {
    if (typeof value === 'string' && value.trim() !== value) {
      throw new InvalidCreditAmountError(
        'Credit amount must not contain spaces',
      );
    }
    amount = new Prisma.Decimal(value);
  } catch (error) {
    if (error instanceof InvalidCreditAmountError) throw error;
    throw new InvalidCreditAmountError(
      `Invalid credit amount: ${String(value)}`,
    );
  }
  if (!amount.isFinite()) {
    throw new InvalidCreditAmountError('Credit amount must be finite');
  }
  if (amount.lte(0)) {
    throw new InvalidCreditAmountError('Credit amount must be positive');
  }
  if (amount.decimalPlaces() > CREDIT_DECIMAL_PLACES) {
    throw new InvalidCreditAmountError(
      `Credit amount must have at most ${CREDIT_DECIMAL_PLACES} decimal places`,
    );
  }
  if (amount.gt(CREDIT_AMOUNT_MAX)) {
    throw new InvalidCreditAmountError(
      `Credit amount must not exceed ${CREDIT_AMOUNT_MAX.toFixed()}`,
    );
  }
  return amount;
}

/** Exact decimal string without exponent or trailing zeros, e.g. "12.5". */
export function formatCredits(value: Prisma.Decimal.Value): string {
  return new Prisma.Decimal(value).toFixed();
}

export function sumCredits(values: Prisma.Decimal.Value[]): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>(
    (total, value) => total.plus(value),
    ZERO_CREDITS,
  );
}
