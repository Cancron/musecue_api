import { CreditSource, Prisma } from '@prisma/client';
import { formatCredits, sumCredits, ZERO_CREDITS } from '../credit-amount';
import {
  creditSourceExpires,
  hasAllocationStarted,
} from '../credit-ledger.policy';
import type {
  CreditAccountAllocationView,
  CreditAllocationState,
  CreditSourceBalanceView,
} from './credit-account.interface';

/** What the ledger recorded for one allocation. */
export interface AllocationMovements {
  /** Credits spent (positive). */
  used: Prisma.Decimal;
  /** Credits removed by EXPIRATION transactions (positive). */
  expired: Prisma.Decimal;
  /** When the (last) expiration took effect. */
  expiredAt: Date | null;
}

export interface AllocationRecord {
  id: string;
  source: CreditSource;
  amount: Prisma.Decimal;
  remaining: Prisma.Decimal;
  grantedAt: Date;
  periodStart: Date | null;
  expiresAt: Date | null;
}

export interface AllocationSummary {
  id: string;
  source: CreditSource;
  state: CreditAllocationState;
  granted: Prisma.Decimal;
  available: Prisma.Decimal;
  upcoming: Prisma.Decimal;
  used: Prisma.Decimal;
  expired: Prisma.Decimal;
  grantedAt: Date;
  periodStart: Date | null;
  expiresAt: Date | null;
  expiredAt: Date | null;
}

/**
 * Where an allocation's credits are at `now`: available, upcoming (month
 * not started), used or expired, adding up to what was granted. Credits
 * past their expiry count as expired even before the expiration was
 * recorded, so expired credits never count towards the balance. Pure.
 */
export function summarizeAllocation(
  allocation: AllocationRecord,
  movements: AllocationMovements | undefined,
  now: Date,
): AllocationSummary {
  const used = movements?.used ?? ZERO_CREDITS;
  let expired = movements?.expired ?? ZERO_CREDITS;
  let expiredAt = movements?.expiredAt ?? null;
  let available = ZERO_CREDITS;
  let upcoming = ZERO_CREDITS;
  if (allocation.remaining.gt(0)) {
    const pastExpiry =
      allocation.expiresAt !== null &&
      allocation.expiresAt.getTime() <= now.getTime();
    if (pastExpiry) {
      expired = expired.plus(allocation.remaining);
      expiredAt = expiredAt ?? allocation.expiresAt;
    } else if (!hasAllocationStarted(allocation, now)) {
      upcoming = allocation.remaining;
    } else {
      available = allocation.remaining;
    }
  }
  const state: CreditAllocationState = available.gt(0)
    ? 'AVAILABLE'
    : upcoming.gt(0)
      ? 'UPCOMING'
      : expired.gt(0)
        ? 'EXPIRED'
        : 'USED_UP';
  return {
    id: allocation.id,
    source: allocation.source,
    state,
    granted: allocation.amount,
    available,
    upcoming,
    used,
    expired,
    grantedAt: allocation.grantedAt,
    periodStart: allocation.periodStart,
    expiresAt: allocation.expiresAt,
    expiredAt,
  };
}

export function toAllocationView(
  summary: AllocationSummary,
): CreditAccountAllocationView {
  return {
    id: summary.id,
    source: summary.source,
    state: summary.state,
    granted: formatCredits(summary.granted),
    available: formatCredits(summary.available),
    upcoming: formatCredits(summary.upcoming),
    used: formatCredits(summary.used),
    expired: formatCredits(summary.expired),
    grantedAt: summary.grantedAt.toISOString(),
    periodStart: summary.periodStart?.toISOString() ?? null,
    expiresAt: summary.expiresAt?.toISOString() ?? null,
    expiredAt: summary.expiredAt?.toISOString() ?? null,
  };
}

/** The credits of one source, from its allocations' summaries. Pure. */
export function summarizeSource(
  source: CreditSource,
  summaries: AllocationSummary[],
  usableNow: boolean,
): CreditSourceBalanceView {
  const own = summaries.filter((summary) => summary.source === source);
  const total = (pick: (summary: AllocationSummary) => Prisma.Decimal) =>
    formatCredits(sumCredits(own.map(pick)));
  const nextExpiry = own
    .filter(
      (summary) =>
        summary.expiresAt !== null &&
        summary.available.plus(summary.upcoming).gt(0),
    )
    .map((summary) => summary.expiresAt as Date)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  return {
    source,
    granted: total((summary) => summary.granted),
    available: total((summary) => summary.available),
    upcoming: total((summary) => summary.upcoming),
    used: total((summary) => summary.used),
    expired: total((summary) => summary.expired),
    expires: creditSourceExpires(source),
    usableNow,
    nextExpiresAt: nextExpiry?.toISOString() ?? null,
  };
}
