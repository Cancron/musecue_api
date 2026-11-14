/**
 * Stripe settings read from the environment. Missing settings do not stop the
 * API from starting (development and test environments have no Stripe
 * account); checkout and the webhook respond with 503 until configured.
 */
export interface StripeSettings {
  /** Server-side secret key (`sk_...` or restricted `rk_...`). */
  secretKey: string | null;
  /** Signing secret of the webhook endpoint (`whsec_...`). */
  webhookSecret: string | null;
  /** Where Stripe sends the browser after payment. Never activates access. */
  successUrl: string | null;
  /** Where Stripe sends the browser when the user leaves checkout. */
  cancelUrl: string | null;
  /** Optional existing Stripe product for the Pro plan (`prod_...`). */
  productId: string | null;
  /** How long a hosted checkout stays payable. */
  checkoutExpiresMinutes: number;
}

/** Stripe accepts 30 minutes to 24 hours; one minute of margin for clock skew. */
export const CHECKOUT_EXPIRES_MINUTES = {
  MIN: 31,
  MAX: 24 * 60,
  DEFAULT: 60,
} as const;

export const STRIPE_SETTINGS = Symbol('STRIPE_SETTINGS');

const text = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/** An absolute http(s) URL, or null when missing or malformed. */
const redirectUrl = (value: string | undefined): string | null => {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? candidate
      : null;
  } catch {
    return null;
  }
};

const expiresMinutes = (value: string | undefined): number => {
  const candidate = text(value);
  if (!candidate || !/^\d+$/.test(candidate)) {
    return CHECKOUT_EXPIRES_MINUTES.DEFAULT;
  }
  const minutes = Number(candidate);
  return Math.min(
    CHECKOUT_EXPIRES_MINUTES.MAX,
    Math.max(CHECKOUT_EXPIRES_MINUTES.MIN, minutes),
  );
};

export function readStripeSettings(env: NodeJS.ProcessEnv): StripeSettings {
  return {
    secretKey: text(env.STRIPE_SECRET_KEY),
    webhookSecret: text(env.STRIPE_WEBHOOK_SECRET),
    successUrl: redirectUrl(env.STRIPE_CHECKOUT_SUCCESS_URL),
    cancelUrl: redirectUrl(env.STRIPE_CHECKOUT_CANCEL_URL),
    productId: text(env.STRIPE_PRO_PRODUCT_ID),
    checkoutExpiresMinutes: expiresMinutes(env.STRIPE_CHECKOUT_EXPIRES_MINUTES),
  };
}
