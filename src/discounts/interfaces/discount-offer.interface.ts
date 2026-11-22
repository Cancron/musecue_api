import type {
  CreditPackageCode,
  DiscountAudience,
  DiscountCustomerEligibility,
  DiscountOfferKind,
  DiscountProduct,
} from '@prisma/client';
import type { ActivityLogMetadata } from '../../common/services/activity-log.service';
import type { DiscountOfferStatus } from '../discount-offer.policy';

/** The configurable fields of a discount code or campaign. */
export interface DiscountOfferInput {
  name?: string;
  discountPercent?: number;
  active?: boolean;
  /** ISO 8601 date or date-time with a time zone. */
  startsAt?: string;
  endsAt?: string;
  maxRedemptionsPerUser?: number;
  /** null = unlimited. */
  maxTotalRedemptions?: number | null;
  /** null = every user; a list = only these users. */
  targetUserIds?: string[] | null;
  customerEligibility?: DiscountCustomerEligibility;
  /** null = every product. */
  eligibleProducts?: DiscountProduct[] | null;
  minSpendCents?: number;
  /** null = unlimited. */
  budgetCents?: number | null;
}

export interface CreateDiscountOfferInput extends DiscountOfferInput {
  /** CODE only. */
  code?: string;
  discountPercent: number;
  startsAt: string;
  endsAt: string;
}

/** An offer as administrators see it. */
export interface DiscountOfferView {
  id: string;
  kind: DiscountOfferKind;
  /** CODE only (upper case). */
  code?: string;
  name: string;
  discountPercent: number;
  active: boolean;
  /** Derived at request time: ACTIVE, INACTIVE, SCHEDULED, EXPIRED, DEPLETED. */
  status: DiscountOfferStatus;
  startsAt: string;
  endsAt: string;
  audience: DiscountAudience;
  /** The targeted users (SELECTED_USERS), sorted; empty for ALL_USERS. */
  targetUserIds: string[];
  maxRedemptionsPerUser: number;
  /** null = unlimited. */
  maxTotalRedemptions: number | null;
  /** RESERVED (held by unpaid checkouts) + REDEEMED redemptions. */
  redemptionCount: number;
  reservedRedemptions: number;
  redeemedRedemptions: number;
  /** null = unlimited. */
  remainingRedemptions: number | null;
  customerEligibility: DiscountCustomerEligibility;
  /** Empty = every product. */
  eligibleProducts: DiscountProduct[];
  minSpendCents: number;
  /** Budget usage in cents; budgetCents and budgetRemainingCents null = unlimited. */
  budgetCents: number | null;
  budgetSpentCents: number;
  budgetReservedCents: number;
  budgetRemainingCents: number | null;
  createdAt: string;
  updatedAt: string;
}

/** A campaign the signed-in user can redeem now. */
export interface AvailableCampaignView {
  id: string;
  name: string;
  discountPercent: number;
  startsAt: string;
  endsAt: string;
  /** How many more times the user may redeem it. */
  remainingRedemptionsForYou: number;
  /** Products it applies to (empty = every product). */
  eligibleProducts: DiscountProduct[];
  /** Minimum list price of the purchase in cents. */
  minSpendCents: number;
}

/** One redemption, with the price terms fixed when it was made. */
export interface DiscountRedemptionView {
  id: string;
  offerId: string;
  kind: DiscountOfferKind;
  /** CODE only. */
  code?: string;
  name: string;
  packageCode: CreditPackageCode;
  credits: number;
  currency: 'USD';
  discountPercent: number;
  originalPriceUsdCents: number;
  discountUsdCents: number;
  finalPriceUsdCents: number;
  /** `finalPriceUsdCents` in dollars, e.g. "4.00". */
  finalPriceUsd: string;
  redeemedAt: string;
  /** True when this repeats an earlier request with the same Idempotency-Key. */
  replayed: boolean;
}

export interface DiscountOfferChangeActor extends ActivityLogMetadata {
  actionedBy: string;
}
