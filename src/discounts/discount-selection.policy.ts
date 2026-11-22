import { DiscountSource } from '@prisma/client';

/** A discount available for one purchase. */
export interface DiscountCandidate {
  source: DiscountSource;
  percent: number;
  /** CODE and CAMPAIGN only. */
  offerId: string | null;
  code: string | null;
  name: string;
  /** CODE and CAMPAIGN only: when the offer ends. */
  endsAt: Date | null;
}

/**
 * Ties between equal percentages: the first-purchase and referral discounts
 * first (they are gone after the first purchase anyway, while a code or
 * campaign would use up one of its limited redemptions), then an entered
 * code, then campaigns.
 */
const SOURCE_PRIORITY: Record<DiscountSource, number> = {
  FIRST_PURCHASE: 0,
  REFERRAL: 1,
  CODE: 2,
  CAMPAIGN: 3,
};

/**
 * The discount applied when several are available: the highest percentage.
 * Ties are broken by source (above), then the offer ending soonest, then
 * the offer id, so the choice is deterministic. Null without candidates.
 */
export function selectBestDiscount(
  candidates: readonly DiscountCandidate[],
): DiscountCandidate | null {
  let best: DiscountCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.percent <= 0) continue;
    if (!best || compare(candidate, best) < 0) best = candidate;
  }
  return best;
}

function compare(a: DiscountCandidate, b: DiscountCandidate): number {
  if (a.percent !== b.percent) return b.percent - a.percent;
  if (a.source !== b.source) {
    return SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source];
  }
  const aEnd = a.endsAt?.getTime() ?? Infinity;
  const bEnd = b.endsAt?.getTime() ?? Infinity;
  if (aEnd !== bEnd) return aEnd - bEnd;
  return (a.offerId ?? '').localeCompare(b.offerId ?? '');
}
