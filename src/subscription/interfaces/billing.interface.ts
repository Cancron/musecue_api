import type {
  BillingInterval,
  PaymentStatus,
  RefundStatus,
  SubscriptionStatus,
} from '@prisma/client';

/**
 * The caller's paid subscription in billing terms:
 * - NONE: never had a paid term;
 * - ACTIVE: paid term running and not canceled;
 * - CANCELED: paid term running, canceled at period end (no renewal);
 * - PAST_DUE: a renewal payment failed and Stripe is still retrying it;
 * - ENDED: had a paid term that is over (expired, or revoked by a refund).
 */
export type SubscriptionState =
  | 'NONE'
  | 'ACTIVE'
  | 'CANCELED'
  | 'PAST_DUE'
  | 'ENDED';

export interface BillingPeriodView {
  start: string;
  end: string;
}

/** GET /v1/subscription/billing. */
export interface BillingInfoView {
  /** Same rule as GET /v1/subscription (evaluated at request time). */
  status: SubscriptionStatus;
  hasProAccess: boolean;
  accessExpiresAt: string | null;
  subscriptionState: SubscriptionState;
  /** The paid plan (also after it ended); null without any paid term. */
  plan: {
    code: 'PRO';
    billingInterval: BillingInterval;
    /** What this subscription is billed per interval (its purchase price). */
    priceCents: number | null;
    currency: string;
  } | null;
  /** The paid period running now; null without an active paid term. */
  currentPeriod: BillingPeriodView | null;
  /** Whether the subscription will be charged again at the period end. */
  autoRenew: boolean;
  /** When the next renewal is charged (end of the current period). */
  nextRenewalAt: string | null;
  /** When the subscription was canceled (renewal turned off). */
  canceledAt: string | null;
  /** When the renewal payment first failed while Stripe retries it. */
  pastDueSince: string | null;
}

/** `NEW_SUBSCRIPTION` is the first payment of a subscription. */
export type PaymentPurpose = 'NEW_SUBSCRIPTION' | 'RENEWAL';

/** One money movement of the caller: a payment attempt or a refund. */
export interface PaymentHistoryEntry {
  id: string;
  type: 'PAYMENT' | 'REFUND';
  /** For a refund: the purpose of the payment it refunds. */
  purpose: PaymentPurpose;
  status: PaymentStatus | RefundStatus;
  amountCents: number;
  currency: string;
  /** Paid, failed or refunded at. */
  date: string;
  billingInterval: BillingInterval;
  /** The billing period paid for (for a refund: of the refunded payment). */
  period: BillingPeriodView;
  /** Payments only: how much of it was refunded so far. */
  refundedAmountCents: number | null;
  /** Refunds only: the refunded payment (an entry of this history). */
  paymentId: string | null;
  /** Failed payments only: a non-sensitive reason code. */
  failureReason: string | null;
}

/** GET /v1/subscription/payments (same shape as PaginatedResponse). */
export interface PaymentHistoryView {
  items: PaymentHistoryEntry[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasPreviousPage: boolean;
    hasNextPage: boolean;
  };
}
