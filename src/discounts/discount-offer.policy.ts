import {
  BillingInterval,
  CreditPackageCode,
  DiscountAudience,
  DiscountCustomerEligibility,
  DiscountProduct,
} from '@prisma/client';

/**
 * Pure rules of discount offers (no database access), used by the admin,
 * checkout and redemption services under a lock of the offer row. The
 * database trigger on DiscountRedemption enforces the same rules.
 */

/**
 * Stripe's minimum USD charge: a discounted payment is either at least this
 * or nothing at all ($0).
 */
export const MIN_CHARGE_USD_CENTS = 50;

/** The fields of an offer that decide whether it can be redeemed. */
export interface RedeemableOffer {
  active: boolean;
  discountPercent: number;
  startsAt: Date;
  endsAt: Date;
  audience: DiscountAudience;
  customerEligibility: DiscountCustomerEligibility;
  /** Empty = every product. */
  eligibleProducts: DiscountProduct[];
  minSpendCents: number;
  maxRedemptionsPerUser: number;
  maxTotalRedemptions: number | null;
  /** RESERVED + REDEEMED redemptions. */
  redemptionCount: number;
  budgetCents: number | null;
  budgetSpentCents: number;
  budgetReservedCents: number;
}

/**
 * The offer's state at `now`, for administrators. INACTIVE covers both
 * `active: false` and a 0% discount; DEPLETED covers a reached redemption
 * limit and a fully used budget.
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
  if (isDepleted(offer) || remainingBudget(offer) === 0) return 'DEPLETED';
  if (now.getTime() < offer.startsAt.getTime()) return 'SCHEDULED';
  return 'ACTIVE';
}

/** Why a user cannot redeem the offer now, checked in this order. */
export type RedemptionRejection =
  | 'INACTIVE'
  | 'NOT_STARTED'
  | 'EXPIRED'
  | 'NOT_ELIGIBLE'
  | 'CUSTOMER_NOT_ELIGIBLE'
  | 'PRODUCT_NOT_ELIGIBLE'
  | 'MIN_SPEND_NOT_MET'
  | 'USER_LIMIT_REACHED'
  | 'DEPLETED'
  | 'BUDGET_EXHAUSTED';

export interface RedemptionContext {
  now: Date;
  /** For SELECTED_USERS offers: whether the user is one of the targets. */
  isTargeted: boolean;
  /** The user's RESERVED and REDEEMED redemptions of this offer. */
  userRedemptions: number;
  /** Whether the user ever made a successful paid purchase. */
  hasPaidPurchase: boolean;
  product: DiscountProduct;
  /** The product's list price (before any discount). */
  listPriceCents: number;
  /** The discount this redemption would grant, in cents. */
  discountCents: number;
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
  if (
    (offer.customerEligibility === DiscountCustomerEligibility.NEW_CUSTOMERS &&
      context.hasPaidPurchase) ||
    (offer.customerEligibility ===
      DiscountCustomerEligibility.RETURNING_CUSTOMERS &&
      !context.hasPaidPurchase)
  ) {
    return 'CUSTOMER_NOT_ELIGIBLE';
  }
  if (
    offer.eligibleProducts.length > 0 &&
    !offer.eligibleProducts.includes(context.product)
  ) {
    return 'PRODUCT_NOT_ELIGIBLE';
  }
  if (context.listPriceCents < offer.minSpendCents) return 'MIN_SPEND_NOT_MET';
  if (context.userRedemptions >= offer.maxRedemptionsPerUser) {
    return 'USER_LIMIT_REACHED';
  }
  if (isDepleted(offer)) return 'DEPLETED';
  const budget = remainingBudget(offer);
  if (budget !== null && context.discountCents > budget) {
    return 'BUDGET_EXHAUSTED';
  }
  return null;
}

/**
 * Whether a released reservation can be counted again for a late payment:
 * only the limits and the budget are checked (eligibility was decided when
 * it was reserved), so a late payment never overspends.
 */
export function lateRedemptionFits(
  offer: RedeemableOffer,
  userRedemptions: number,
  discountCents: number,
): boolean {
  if (userRedemptions >= offer.maxRedemptionsPerUser) return false;
  if (isDepleted(offer)) return false;
  const budget = remainingBudget(offer);
  return budget === null || discountCents <= budget;
}

/** Redemptions left for everyone (null = unlimited). */
export function remainingRedemptions(offer: RedeemableOffer): number | null {
  return offer.maxTotalRedemptions === null
    ? null
    : Math.max(0, offer.maxTotalRedemptions - offer.redemptionCount);
}

/** Budget left in cents: not spent and not reserved (null = unlimited). */
export function remainingBudget(offer: RedeemableOffer): number | null {
  return offer.budgetCents === null
    ? null
    : Math.max(
        0,
        offer.budgetCents - offer.budgetSpentCents - offer.budgetReservedCents,
      );
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

/**
 * A discount charged through Stripe: like applyDiscount, and a 100% discount
 * charges exactly $0. Stripe cannot charge less than its $0.50 minimum, so a
 * discounted payment that would fall between $0.01 and $0.49 is waived
 * entirely ($0) rather than rounded up: a customer never pays more than the
 * advertised discount.
 */
export function applyCheckoutDiscount(
  priceUsdCents: number,
  discountPercent: number,
): DiscountedPrice {
  const exact = applyDiscount(priceUsdCents, discountPercent);
  if (
    exact.discountUsdCents > 0 &&
    exact.finalPriceUsdCents < MIN_CHARGE_USD_CENTS
  ) {
    return {
      originalPriceUsdCents: priceUsdCents,
      discountUsdCents: priceUsdCents,
      finalPriceUsdCents: 0,
    };
  }
  return exact;
}

/** The product of a Pro billing option. */
export const proProduct = (interval: BillingInterval): DiscountProduct =>
  interval === BillingInterval.YEARLY
    ? DiscountProduct.PRO_YEARLY
    : DiscountProduct.PRO_MONTHLY;

/** The product of a credit package. */
export const packageProduct = (code: CreditPackageCode): DiscountProduct =>
  ({
    SMALL: DiscountProduct.CREDITS_SMALL,
    MEDIUM: DiscountProduct.CREDITS_MEDIUM,
    LARGE: DiscountProduct.CREDITS_LARGE,
  })[code];

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
