import type { BillingInterval, DiscountSource } from '@prisma/client';

/** The discount applied to the first payment of a checkout. */
export interface CheckoutDiscountView {
  /** FIRST_PURCHASE, REFERRAL, CODE or CAMPAIGN: the best one available. */
  source: DiscountSource;
  percent: number;
  /** Cents off the first payment (the first charge is never below $0.50). */
  amountOffCents: number;
  /** CODE: the code entered. */
  code?: string;
  /** CODE and CAMPAIGN: the offer. */
  offerId?: string;
}

/** A payable hosted checkout returned to the authenticated user. */
export interface CheckoutSessionView {
  /** MuseCue checkout id (not the provider's session id). */
  checkoutSessionId: string;
  provider: 'stripe';
  status: 'OPEN';
  billingInterval: BillingInterval;
  /**
   * Price fixed from the backend plan configuration when created: the
   * subscription's price for every period (renewals are charged this).
   */
  amountCents: number;
  /** The discount off the first payment, or null. */
  discount: CheckoutDiscountView | null;
  /** The first charge: `amountCents` less the discount. */
  amountDueCents: number;
  currency: 'USD';
  /** Stripe-hosted payment page. Completing it does not grant access by itself. */
  url: string;
  expiresAt: string;
  /** True when an existing pending checkout for the same option was returned. */
  reused: boolean;
}
