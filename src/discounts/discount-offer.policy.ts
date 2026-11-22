import { DiscountAudience } from '@prisma/client';

/**
 * Pure rules of discount offers (no database access), used by the admin and
 * redemption services under a lock of the offer row.
 */

/** The fields of an offer that decide whether it can be redeemed. */
export interface RedeemableOffer {
  active: boolean;
  discountPercent: number;
  startsAt: Date;
  endsAt: Date;
  audience: DiscountAudience;
  maxRedemptionsPerUser: number;
  maxTotalRedemptions: number | null;
  redemptionCount: number;
}

/**
 * The offer's state at `now`, for administrators. INACTIVE covers both
 * `active: false` and a 0% discount.
 */
export type DiscountOfferStatus =
  | 'ACTIVE'
  | 'INACTIVE'
  | 'SCHEDULED'
  | 'EXPIRED'
  | 'DEPLETED';

export function discountOfferStatus(
  offer: RedeemableOffer,
  now: Date,
): DiscountOfferStatus {
  if (!isSwitchedOn(offer)) return 'INACTIVE';
  if (now.getTime() >= offer.endsAt.getTime()) return 'EXPIRED';
  if (isDepleted(offer)) return 'DEPLETED';
  if (now.getTime() < offer.startsAt.getTime()) return 'SCHEDULED';
  return 'ACTIVE';
}

/** Why a user cannot redeem the offer now, checked in this order. */
export type RedemptionRejection =
  | 'INACTIVE'
  | 'NOT_STARTED'
  | 'EXPIRED'
  | 'NOT_ELIGIBLE'
  | 'USER_LIMIT_REACHED'
  | 'DEPLETED';

export interface RedemptionContext {
  now: Date;
  /** For SELECTED_USERS offers: whether the user is one of the targets. */
  isTargeted: boolean;
  /** The user's earlier redemptions of this offer. */
  userRedemptions: number;
}

/** Returns why the offer cannot be redeemed, or null if it can. */
export function redemptionRejection(
  offer: RedeemableOffer,
  context: RedemptionContext,
): RedemptionRejection | null {
  if (!isSwitchedOn(offer)) return 'INACTIVE';
  if (context.now.getTime() < offer.startsAt.getTime()) return 'NOT_STARTED';
  if (context.now.getTime() >= offer.endsAt.getTime()) return 'EXPIRED';
  if (
    offer.audience === DiscountAudience.SELECTED_USERS &&
    !context.isTargeted
  ) {
    return 'NOT_ELIGIBLE';
  }
  if (context.userRedemptions >= offer.maxRedemptionsPerUser) {
    return 'USER_LIMIT_REACHED';
  }
  if (isDepleted(offer)) return 'DEPLETED';
  return null;
}

/** Redemptions left for everyone (null = unlimited). */
export function remainingRedemptions(offer: RedeemableOffer): number | null {
  return offer.maxTotalRedemptions === null
    ? null
    : Math.max(0, offer.maxTotalRedemptions - offer.redemptionCount);
}

export interface DiscountedPrice {
  originalPriceUsdCents: number;
  discountUsdCents: number;
  finalPriceUsdCents: number;
}

/**
 * Applies a whole-percent discount to a price in whole cents. The discount
 * is rounded down to a whole cent (the customer never pays less than the
 * exact discounted price). Integer arithmetic only.
 */
export function applyDiscount(
  priceUsdCents: number,
  discountPercent: number,
): DiscountedPrice {
  if (!Number.isSafeInteger(priceUsdCents) || priceUsdCents <= 0) {
    throw new RangeError(`Invalid price: ${priceUsdCents}`);
  }
  if (
    !Number.isInteger(discountPercent) ||
    discountPercent < 0 ||
    discountPercent > 100
  ) {
    throw new RangeError(`Invalid discount: ${discountPercent}`);
  }
  const discountUsdCents = Math.floor((priceUsdCents * discountPercent) / 100);
  return {
    originalPriceUsdCents: priceUsdCents,
    discountUsdCents,
    finalPriceUsdCents: priceUsdCents - discountUsdCents,
  };
}

/** Codes are case-insensitive: stored and compared in upper case. */
export function normalizeDiscountCode(code: string): string {
  return code.trim().toUpperCase();
}

/** A 0% discount switches the offer off, like `active: false`. */
function isSwitchedOn(offer: RedeemableOffer): boolean {
  return offer.active && offer.discountPercent > 0;
}

function isDepleted(offer: RedeemableOffer): boolean {
  return (
    offer.maxTotalRedemptions !== null &&
    offer.redemptionCount >= offer.maxTotalRedemptions
  );
}
