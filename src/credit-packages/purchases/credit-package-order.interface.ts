import type {
  CreditPackageCode,
  CreditPackageOrderKind,
  CreditPackageOrderStatus,
  DiscountSource,
} from '@prisma/client';

/** A credit package as users see it (available packages only). */
export interface PurchasableCreditPackageView {
  code: CreditPackageCode;
  credits: number;
  priceUsdCents: number;
  priceUsd: string;
  currency: 'USD';
}

/** One of the caller's credit package orders. */
export interface CreditPackageOrderView {
  id: string;
  /** SELF: credits for the payer; GIFT: the payment of a gift. */
  kind: CreditPackageOrderKind;
  giftId: string | null;
  status: CreditPackageOrderStatus;
  packageCode: CreditPackageCode;
  /** Locked when the order was created. */
  credits: number;
  listPriceUsdCents: number;
  discount: {
    source: DiscountSource;
    percent: number;
    amountOffCents: number;
    code: string | null;
  } | null;
  /** What is charged (list price less the discount). */
  amountDueUsdCents: number;
  amountDueUsd: string;
  currency: 'USD';
  /** The Stripe payment page, while the order is OPEN. */
  checkoutUrl: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  closedAt: string | null;
  closedReason: string | null;
  createdAt: string;
  /** A repeated request (same Idempotency-Key) returned this order. */
  replayed?: boolean;
}
