import { CHECKOUT_EXPIRES_MINUTES, readStripeSettings } from './stripe.config';

describe('readStripeSettings', () => {
  const complete = {
    STRIPE_SECRET_KEY: ' sk_test_123 ',
    STRIPE_WEBHOOK_SECRET: 'whsec_123',
    STRIPE_CHECKOUT_SUCCESS_URL: 'https://app.example/checkout/success',
    STRIPE_CHECKOUT_CANCEL_URL: 'musecue://checkout/cancel',
    STRIPE_PRO_PRODUCT_ID: 'prod_123',
    STRIPE_CHECKOUT_EXPIRES_MINUTES: '45',
  };

  it('reads and trims the configured values', () => {
    expect(readStripeSettings(complete)).toEqual({
      secretKey: 'sk_test_123',
      webhookSecret: 'whsec_123',
      successUrl: 'https://app.example/checkout/success',
      // Only absolute http(s) URLs are accepted as redirect targets.
      cancelUrl: null,
      productId: 'prod_123',
      checkoutExpiresMinutes: 45,
    });
  });

  it('treats missing or blank values as not configured', () => {
    expect(
      readStripeSettings({
        STRIPE_SECRET_KEY: '   ',
        STRIPE_WEBHOOK_SECRET: '',
      }),
    ).toEqual({
      secretKey: null,
      webhookSecret: null,
      successUrl: null,
      cancelUrl: null,
      productId: null,
      checkoutExpiresMinutes: CHECKOUT_EXPIRES_MINUTES.DEFAULT,
    });
  });

  it.each(['not a url', 'ftp://files.example/x', 'javascript:alert(1)'])(
    'rejects the redirect URL %p',
    (url) => {
      expect(
        readStripeSettings({ STRIPE_CHECKOUT_SUCCESS_URL: url }).successUrl,
      ).toBeNull();
    },
  );

  it.each([
    ['5', CHECKOUT_EXPIRES_MINUTES.MIN],
    ['30', CHECKOUT_EXPIRES_MINUTES.MIN],
    ['5000', CHECKOUT_EXPIRES_MINUTES.MAX],
    ['-10', CHECKOUT_EXPIRES_MINUTES.DEFAULT],
    ['12.5', CHECKOUT_EXPIRES_MINUTES.DEFAULT],
    ['soon', CHECKOUT_EXPIRES_MINUTES.DEFAULT],
  ])(
    'keeps the checkout expiry %p within Stripe limits (%p minutes)',
    (value, expected) => {
      expect(
        readStripeSettings({ STRIPE_CHECKOUT_EXPIRES_MINUTES: value })
          .checkoutExpiresMinutes,
      ).toBe(expected);
    },
  );
});
