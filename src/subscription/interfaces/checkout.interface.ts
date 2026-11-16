import type { BillingInterval } from '@prisma/client';

/** A payable hosted checkout returned to the authenticated user. */
export interface CheckoutSessionView {
  /** MuseCue checkout id (not the provider's session id). */
  checkoutSessionId: string;
  provider: 'stripe';
  status: 'OPEN';
  billingInterval: BillingInterval;
  /** Price fixed from the backend plan configuration when created. */
  amountCents: number;
  currency: 'USD';
  /** Stripe-hosted payment page. Completing it does not grant access by itself. */
  url: string;
  expiresAt: string;
  /** True when an existing pending checkout for the same option was returned. */
  reused: boolean;
}
