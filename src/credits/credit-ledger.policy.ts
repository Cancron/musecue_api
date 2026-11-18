import { CreditSource, Prisma } from '@prisma/client';
import { ZERO_CREDITS } from './credit-amount';

/**
 * Pure rules of the credit ledger (no database access), used by
 * CreditWalletService inside its locked transactions.
 */

/** Sources whose credits must expire; the others never expire. */
export const EXPIRING_CREDIT_SOURCES: readonly CreditSource[] = [
  CreditSource.TRIAL,
  CreditSource.SUBSCRIPTION,
];

export const creditSourceExpires = (source: CreditSource): boolean =>
  EXPIRING_CREDIT_SOURCES.includes(source);

/** Maximum length of a caller-supplied source reference or idempotency key. */
export const CREDIT_REFERENCE_MAX_LENGTH = 200;

/**
 * Returns why a grant's expiry is invalid for its source, or null if valid.
 * TRIAL and SUBSCRIPTION credits must expire after `now`; PURCHASE and
 * REFERRAL credits must not expire.
 */
export function getGrantExpiryRejection(
  source: CreditSource,
  expiresAt: Date | null | undefined,
  now: Date,
): string | null {
  if (creditSourceExpires(source)) {
    if (!expiresAt) return `${source} credits require an expiration date`;
    if (Number.isNaN(expiresAt.getTime())) return 'Invalid expiration date';
    if (expiresAt.getTime() <= now.getTime()) {
      return 'The expiration date must be in the future';
    }
    return null;
  }
  if (expiresAt) return `${source} credits never expire`;
  return null;
}

/** Returns why a reference or key is invalid, or null if valid. */
export function getReferenceRejection(
  name: string,
  value: string,
): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return `${name} is required`;
  }
  if (value.length > CREDIT_REFERENCE_MAX_LENGTH) {
    return `${name} must be at most ${CREDIT_REFERENCE_MAX_LENGTH} characters`;
  }
  return null;
}

/** Whether an allocation counts towards the available balance at `now`. */
export function isAllocationAvailable(
  allocation: { remaining: Prisma.Decimal; expiresAt: Date | null },
  now: Date,
): boolean {
  return (
    allocation.remaining.gt(0) &&
    (allocation.expiresAt === null ||
      allocation.expiresAt.getTime() > now.getTime())
  );
}

/** Whether an allocation's unused credits have expired at `now`. */
export function isAllocationDueForExpiration(
  allocation: { remaining: Prisma.Decimal; expiresAt: Date | null },
  now: Date,
): boolean {
  return (
    allocation.remaining.gt(0) &&
    allocation.expiresAt !== null &&
    allocation.expiresAt.getTime() <= now.getTime()
  );
}

export interface SpendableAllocation {
  id: string;
  remaining: Prisma.Decimal;
  expiresAt: Date | null;
  grantedAt: Date;
}

/**
 * Order in which allocations are spent: credits that expire soonest first,
 * never-expiring credits last; ties by grant time, then ID (deterministic).
 */
export function compareSpendingOrder(
  a: SpendableAllocation,
  b: SpendableAllocation,
): number {
  const aExpiry = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bExpiry = b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (aExpiry !== bExpiry) return aExpiry < bExpiry ? -1 : 1;
  const granted = a.grantedAt.getTime() - b.grantedAt.getTime();
  if (granted !== 0) return granted;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface DebitPlan {
  /** Credits taken from each allocation, in spending order. */
  takes: { allocationId: string; amount: Prisma.Decimal }[];
  /** Total taken from the balance. */
  consumed: Prisma.Decimal;
  /** Part of the request the balance cannot cover. */
  shortfall: Prisma.Decimal;
}

/**
 * Splits a debit over the allocations available at `now` (see
 * compareSpendingOrder). Unavailable allocations are ignored.
 */
export function planDebit(
  allocations: SpendableAllocation[],
  requested: Prisma.Decimal,
  now: Date,
): DebitPlan {
  const takes: DebitPlan['takes'] = [];
  let outstanding = requested;
  const spendable = allocations
    .filter((allocation) => isAllocationAvailable(allocation, now))
    .sort(compareSpendingOrder);
  for (const allocation of spendable) {
    if (outstanding.lte(0)) break;
    const amount = Prisma.Decimal.min(allocation.remaining, outstanding);
    takes.push({ allocationId: allocation.id, amount });
    outstanding = outstanding.minus(amount);
  }
  return {
    takes,
    consumed: requested.minus(outstanding),
    shortfall: Prisma.Decimal.max(outstanding, ZERO_CREDITS),
  };
}

export interface OverageDecision {
  allowed: boolean;
  /** Overage the session could still use before this debit. */
  remainingBefore: Prisma.Decimal;
  /** The session's overage usage after this debit (if allowed). */
  usedAfter: Prisma.Decimal;
}

/** Whether a session may cover `shortfall` with its overage allowance. */
export function decideOverage(
  limit: Prisma.Decimal,
  used: Prisma.Decimal,
  shortfall: Prisma.Decimal,
): OverageDecision {
  const remainingBefore = Prisma.Decimal.max(limit.minus(used), ZERO_CREDITS);
  const usedAfter = used.plus(shortfall);
  return {
    allowed: usedAfter.lte(limit),
    remainingBefore,
    usedAfter,
  };
}
