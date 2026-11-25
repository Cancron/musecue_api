import { CreditSource, Prisma } from '@prisma/client';

/**
 * Pure rules of the credit ledger: amount parsing, expiry rules, the order in
 * which credits are spent, session overage, and overage settlement. No I/O;
 * CreditWalletService applies the results inside a locked transaction.
 *
 * All arithmetic uses exact decimals (Prisma.Decimal), never JavaScript
 * floating-point numbers.
 */

export type CreditAmount = Prisma.Decimal;
export type CreditAmountInput = string | number | Prisma.Decimal;

/** Fractional digits stored (NUMERIC(20,6)). */
export const CREDIT_DECIMAL_PLACES = 6;
/** Largest single allocation or deduction, a guard against unit mistakes. */
export const CREDIT_AMOUNT_MAX = new Prisma.Decimal(1_000_000_000);

export const ZERO_CREDITS = new Prisma.Decimal(0);

/** Sources whose allocations must expire, and sources that never expire. */
export const EXPIRING_CREDIT_SOURCES: readonly CreditSource[] = [
  CreditSource.TRIAL,
  CreditSource.SUBSCRIPTION,
];
export const NON_EXPIRING_CREDIT_SOURCES: readonly CreditSource[] = [
  CreditSource.PURCHASE,
  CreditSource.REFERRAL,
];

export class CreditRuleViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreditRuleViolation';
  }
}

const DECIMAL_STRING = /^\d+(\.\d+)?$/;

/**
 * Parses a positive credit amount with at most 6 fractional digits. Amounts
 * that would need rounding are rejected rather than rounded, so a caller can
 * never lose or gain a fraction silently.
 */
export function parseCreditAmount(
  value: CreditAmountInput,
  field = 'credits',
): CreditAmount {
  let amount: Prisma.Decimal;
  if (value instanceof Prisma.Decimal) {
    amount = value;
  } else if (typeof value === 'string' && DECIMAL_STRING.test(value.trim())) {
    amount = new Prisma.Decimal(value.trim());
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    amount = new Prisma.Decimal(value);
  } else {
    throw new CreditRuleViolation(`${field} must be a decimal number`);
  }

  if (!amount.isFinite() || amount.lte(0)) {
    throw new CreditRuleViolation(`${field} must be greater than 0`);
  }
  if (amount.decimalPlaces() > CREDIT_DECIMAL_PLACES) {
    throw new CreditRuleViolation(
      `${field} must have at most ${CREDIT_DECIMAL_PLACES} decimal places`,
    );
  }
  if (amount.gt(CREDIT_AMOUNT_MAX)) {
    throw new CreditRuleViolation(
      `${field} must not exceed ${CREDIT_AMOUNT_MAX.toFixed()}`,
    );
  }
  return amount;
}

/** Renders an amount as a plain decimal string without exponent notation. */
export const formatCredits = (amount: Prisma.Decimal): string =>
  amount.toFixed();

export const minCredits = (a: CreditAmount, b: CreditAmount): CreditAmount =>
  a.lte(b) ? a : b;

/**
 * Trial and subscription credits must expire after `now`; purchased and
 * referral credits must not have an expiry.
 */
export function assertAllocationExpiry(
  source: CreditSource,
  expiresAt: Date | null | undefined,
  now: Date,
): void {
  if (EXPIRING_CREDIT_SOURCES.includes(source)) {
    if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
      throw new CreditRuleViolation(`${source} credits require an expiry date`);
    }
    if (expiresAt.getTime() <= now.getTime()) {
      throw new CreditRuleViolation(
        `${source} credits must expire in the future`,
      );
    }
  } else if (expiresAt !== null && expiresAt !== undefined) {
    throw new CreditRuleViolation(`${source} credits never expire`);
  }
}

/** The parts of an allocation the spending rules need. */
export interface SpendableAllocation {
  id: string;
  source: CreditSource;
  remainingCredits: CreditAmount;
  expiresAt: Date | null;
  grantedAt: Date;
}

/** Unused credits that can still be spent at `now`. */
export const isAvailable = (
  allocation: Pick<SpendableAllocation, 'remainingCredits' | 'expiresAt'>,
  now: Date,
): boolean =>
  allocation.remainingCredits.gt(0) &&
  (allocation.expiresAt === null ||
    allocation.expiresAt.getTime() > now.getTime());

/** Unused credits whose expiry has passed and that must be expired. */
export const isDueForExpiry = (
  allocation: Pick<SpendableAllocation, 'remainingCredits' | 'expiresAt'>,
  now: Date,
): boolean =>
  allocation.remainingCredits.gt(0) &&
  allocation.expiresAt !== null &&
  allocation.expiresAt.getTime() <= now.getTime();

/**
 * Spending order: credits that expire soonest first (so as few as possible
 * are lost to expiry), then non-expiring credits; ties by grant time and id.
 */
export function compareSpendingOrder(
  a: SpendableAllocation,
  b: SpendableAllocation,
): number {
  if (a.expiresAt && b.expiresAt) {
    const diff = a.expiresAt.getTime() - b.expiresAt.getTime();
    if (diff !== 0) return diff;
  } else if (a.expiresAt) {
    return -1;
  } else if (b.expiresAt) {
    return 1;
  }
  const granted = a.grantedAt.getTime() - b.grantedAt.getTime();
  if (granted !== 0) return granted;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface DeductionPlan {
  /** Credits taken from each allocation, in spending order. */
  entries: { allocationId: string; credits: CreditAmount }[];
  /** Credits covered by the balance. */
  fromBalance: CreditAmount;
  /** Credits charged as session overage. */
  overage: CreditAmount;
}

export type DeductionOutcome =
  | ({ ok: true } & DeductionPlan)
  | {
      ok: false;
      available: CreditAmount;
      overageRoom: CreditAmount;
      shortfall: CreditAmount;
    };

/**
 * Plans a deduction: spends available credits in spending order and charges
 * any remainder as overage, up to `overageRoom`. A deduction that does not
 * fit is refused as a whole (nothing is spent).
 */
export function planDeduction(
  allocations: readonly SpendableAllocation[],
  requested: CreditAmount,
  overageRoom: CreditAmount,
  now: Date,
): DeductionOutcome {
  const spendable = allocations
    .filter((allocation) => isAvailable(allocation, now))
    .sort(compareSpendingOrder);
  const available = spendable.reduce(
    (sum, allocation) => sum.plus(allocation.remainingCredits),
    ZERO_CREDITS,
  );
  const fromBalance = minCredits(available, requested);
  const overage = requested.minus(fromBalance);
  const room = overageRoom.gt(0) ? overageRoom : ZERO_CREDITS;
  if (overage.gt(room)) {
    return {
      ok: false,
      available,
      overageRoom: room,
      shortfall: overage.minus(room),
    };
  }

  const entries: DeductionPlan['entries'] = [];
  let left = fromBalance;
  for (const allocation of spendable) {
    if (left.lte(0)) break;
    const take = minCredits(allocation.remainingCredits, left);
    entries.push({ allocationId: allocation.id, credits: take });
    left = left.minus(take);
  }
  return { ok: true, entries, fromBalance, overage };
}

/** Overage a session may still use: its limit minus what it already used. */
export function sessionOverageRoom(
  limit: CreditAmount,
  alreadyUsed: CreditAmount,
): CreditAmount {
  const room = limit.minus(alreadyUsed);
  return room.gt(0) ? room : ZERO_CREDITS;
}

export interface UnsettledOverage {
  id: string;
  unsettled: CreditAmount;
}

export interface SettlementPlan {
  /** Total overage repaid from the new allocation. */
  settled: CreditAmount;
  /** Repayment per session, oldest first. */
  bySession: { id: string; credits: CreditAmount }[];
}

/**
 * Plans repaying outstanding session overage from a new allocation: as much
 * as the allocation covers, oldest session first.
 */
export function planOverageSettlement(
  granted: CreditAmount,
  sessions: readonly UnsettledOverage[],
): SettlementPlan {
  const bySession: SettlementPlan['bySession'] = [];
  let left = granted;
  for (const session of sessions) {
    if (left.lte(0)) break;
    if (session.unsettled.lte(0)) continue;
    const repay = minCredits(session.unsettled, left);
    bySession.push({ id: session.id, credits: repay });
    left = left.minus(repay);
  }
  return { settled: granted.minus(left), bySession };
}

/** Fractional digits of stored USD costs (NUMERIC(24,12)). */
export const USD_COST_DECIMAL_PLACES = 12;

/**
 * Parses a provider-reported cost in US dollars (e.g. OpenRouter
 * `usage.cost`): a finite, non-negative number or decimal string, rounded
 * half up to 12 decimal places (as PostgreSQL stores NUMERIC(24,12)). Null
 * when the provider reported no usable cost.
 */
export function parseUsdCost(value: unknown): Prisma.Decimal | null {
  let cost: Prisma.Decimal;
  if (typeof value === 'number' && Number.isFinite(value)) {
    cost = new Prisma.Decimal(value);
  } else if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) {
    cost = new Prisma.Decimal(value.trim());
  } else {
    return null;
  }
  if (cost.isNegative()) return null;
  return cost.toDecimalPlaces(
    USD_COST_DECIMAL_PLACES,
    Prisma.Decimal.ROUND_HALF_UP,
  );
}

/**
 * Credits for a cost in US dollars at a conversion rate in micro-dollars per
 * credit (CreditSettings.openRouterUsdMicrosPerCredit; 5000 = $0.005 per
 * credit): round(costUsd * 1e6 / rate, 6), half up. The database checks the
 * same formula on every AI deduction. Example: $0.025 at 5000 = 5 credits.
 */
export function creditsForCost(
  costUsd: Prisma.Decimal,
  usdMicrosPerCredit: number,
): CreditAmount {
  if (!Number.isInteger(usdMicrosPerCredit) || usdMicrosPerCredit <= 0) {
    throw new CreditRuleViolation('The conversion rate must be positive');
  }
  return costUsd
    .times(1_000_000)
    .dividedBy(usdMicrosPerCredit)
    .toDecimalPlaces(CREDIT_DECIMAL_PLACES, Prisma.Decimal.ROUND_HALF_UP);
}
