/**
 * Stripe configuration. Credentials are read lazily (at first use, not at
 * module load) so the app can start without Stripe configured until a
 * checkout or webhook request actually needs it — the same pattern as
 * `getGoogleOAuthCredentials`.
 */

/** The provider name stored on subscription, payment and checkout records. */
export const STRIPE_PROVIDER = 'stripe';

export const STRIPE_CHECKOUT_CONFIG = {
  /**
   * Where Stripe sends the browser after checkout. These pages are purely
   * informational: Pro access is granted only by the webhook, never by a
   * browser redirect or a client-reported session id, so the API never reads
   * `{CHECKOUT_SESSION_ID}` from the returning request.
   */
  SUCCESS_URL:
    process.env.STRIPE_CHECKOUT_SUCCESS_URL ||
    'https://app.musecue.com/billing/success',
  CANCEL_URL:
    process.env.STRIPE_CHECKOUT_CANCEL_URL ||
    'https://app.musecue.com/billing/cancel',
} as const;

export interface StripeCredentials {
  secretKey: string;
  webhookSecret: string;
}

/**
 * Reads and validates the Stripe credentials from the environment.
 * @throws Error if STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET is missing.
 */
export function getStripeCredentials(): StripeCredentials {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secretKey || !webhookSecret) {
    throw new Error(
      'Stripe is not configured. Please set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET environment variables.',
    );
  }

  return { secretKey, webhookSecret };
}
