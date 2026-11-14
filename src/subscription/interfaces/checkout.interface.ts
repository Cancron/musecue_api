import type { BillingInterval } from '@prisma/client';

/** The caller-facing result of starting (or reusing) a Pro checkout. */
export interface CheckoutSessionView {
  billingInterval: BillingInterval;
  amountCents: number;
  currency: string;
  /** The Stripe-hosted checkout page to redirect the user to. */
  url: string;
  expiresAt: string;
  /**
   * True when an existing pending session for the same billing option was
   * returned instead of creating a new one.
   */
  reused: boolean;
}
