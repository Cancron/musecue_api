import { BillingInterval } from '@prisma/client';
import Stripe from 'stripe';
import {
  FAKE_WEBHOOK_SECRET,
  FakeStripeApi,
} from '../../../test/support/fake-stripe-api';
import type { StripeSettings } from './stripe.config';
import { PRO_PRODUCT_NAME, StripeGateway } from './stripe.gateway';

describe('StripeGateway', () => {
  const settings: StripeSettings = {
    secretKey: 'sk_test_fake',
    webhookSecret: FAKE_WEBHOOK_SECRET,
    successUrl: 'https://app.example/checkout/success',
    cancelUrl: 'https://app.example/checkout/cancel',
    productId: null,
    checkoutExpiresMinutes: 60,
  };
  let api: FakeStripeApi;
  let gateway: StripeGateway;

  beforeEach(() => {
    api = new FakeStripeApi();
    gateway = new StripeGateway(settings, api.client());
  });

  const checkoutRequest = async (
    overrides: Partial<
      Parameters<StripeGateway['createCheckoutSession']>[0]
    > = {},
  ) => ({
    checkoutId: 'checkout-1',
    authId: 'user-1',
    customerId: await gateway.createCustomer('user-1', 'user@example.com'),
    billingInterval: BillingInterval.MONTHLY,
    amountCents: 1900,
    expiresAt: new Date(Date.now() + 60 * 60_000),
    ...overrides,
  });

  describe('configuration', () => {
    it('needs the API key and both redirect URLs for checkout', () => {
      expect(gateway.checkoutConfigured).toBe(true);
      expect(new StripeGateway(settings, null).checkoutConfigured).toBe(false);
      expect(
        new StripeGateway({ ...settings, successUrl: null }, api.client())
          .checkoutConfigured,
      ).toBe(false);
      expect(
        new StripeGateway({ ...settings, cancelUrl: null }, api.client())
          .checkoutConfigured,
      ).toBe(false);
    });

    it('rejects Stripe calls with 503 when no API key is configured', async () => {
      await expect(
        new StripeGateway(settings, null).createCustomer('user-1', 'a@b.c'),
      ).rejects.toMatchObject({ status: 503 });
      expect(api.requests).toHaveLength(0);
    });
  });

  describe('customers', () => {
    it('creates one customer per user through a per-user idempotency key', async () => {
      const first = await gateway.createCustomer('user-1', 'user@example.com');
      const retried = await gateway.createCustomer(
        'user-1',
        'user@example.com',
      );
      const other = await gateway.createCustomer('user-2', 'other@example.com');

      expect(retried).toBe(first);
      expect(other).not.toBe(first);
      expect(api.customers.size).toBe(2);
      expect(api.requests[0]).toMatchObject({
        method: 'POST',
        path: '/v1/customers',
        idempotencyKey: 'musecue-customer-user-1',
        params: { email: 'user@example.com', metadata: { authId: 'user-1' } },
      });
    });
  });

  describe('checkout sessions', () => {
    it('sends the backend price, interval, customer and checkout metadata', async () => {
      const request = await checkoutRequest();

      const session = await gateway.createCheckoutSession(request);

      expect(session).toEqual({
        id: expect.stringMatching(/^cs_test_/) as string,
        url: expect.stringContaining(session.id) as string,
        status: 'open',
        paymentStatus: 'unpaid',
      });
      const sent = api.requests.at(-1);
      expect(sent?.idempotencyKey).toBe('musecue-checkout-checkout-1');
      const metadata = {
        checkoutSessionId: 'checkout-1',
        authId: 'user-1',
        billingInterval: 'MONTHLY',
      };
      expect(sent?.params).toEqual({
        mode: 'subscription',
        customer: request.customerId,
        client_reference_id: 'user-1',
        line_items: [
          {
            quantity: '1',
            price_data: {
              currency: 'usd',
              unit_amount: '1900',
              recurring: { interval: 'month', interval_count: '1' },
              product_data: { name: PRO_PRODUCT_NAME },
            },
          },
        ],
        allow_promotion_codes: 'false',
        adaptive_pricing: { enabled: 'false' },
        success_url: settings.successUrl,
        cancel_url: settings.cancelUrl,
        expires_at: String(Math.floor(request.expiresAt.getTime() / 1000)),
        metadata,
        subscription_data: { metadata },
      });
    });

    it('bills the yearly option per year and uses a configured product', async () => {
      gateway = new StripeGateway(
        { ...settings, productId: 'prod_pro' },
        api.client(),
      );
      await gateway.createCheckoutSession(
        await checkoutRequest({
          billingInterval: BillingInterval.YEARLY,
          amountCents: 19000,
        }),
      );

      expect(api.requests.at(-1)?.params.line_items).toEqual([
        {
          quantity: '1',
          price_data: {
            currency: 'usd',
            unit_amount: '19000',
            recurring: { interval: 'year', interval_count: '1' },
            product: 'prod_pro',
          },
        },
      ]);
    });

    it('returns the same Stripe session when the same checkout is created again', async () => {
      const request = await checkoutRequest();
      const first = await gateway.createCheckoutSession(request);
      const again = await gateway.createCheckoutSession(request);

      expect(again.id).toBe(first.id);
      expect(api.sessions.size).toBe(1);
    });

    it('expires an open session and refuses to expire it twice', async () => {
      const session = await gateway.createCheckoutSession(
        await checkoutRequest(),
      );

      await expect(
        gateway.expireCheckoutSession(session.id),
      ).resolves.toMatchObject({ status: 'expired' });
      await expect(
        gateway.expireCheckoutSession(session.id),
      ).rejects.toBeInstanceOf(Stripe.errors.StripeInvalidRequestError);
    });

    it('retrieves the session with its invoice and subscription for verification', async () => {
      const session = await gateway.createCheckoutSession(
        await checkoutRequest(),
      );
      api.completeSession(session.id);

      const full = await gateway.retrieveCheckoutForVerification(session.id);

      expect(api.requests.at(-1)?.params.expand).toEqual([
        'invoice',
        'subscription',
        'subscription.latest_invoice',
      ]);
      expect(full.invoice).toMatchObject({ object: 'invoice' });
      expect(full.subscription).toMatchObject({
        object: 'subscription',
        latest_invoice: { object: 'invoice' },
      });
    });
  });

  describe('renewal lookups', () => {
    it('reads the invoice and the subscription from the Stripe API', async () => {
      const session = await gateway.createCheckoutSession(
        await checkoutRequest(),
      );
      const completed = api.completeSession(session.id);
      const renewal = api.renewSubscription(completed.subscription as string);

      const invoice = await gateway.retrieveInvoice(renewal.id as string);
      const subscription = await gateway.retrieveSubscription(
        completed.subscription as string,
      );

      expect(invoice).toMatchObject({
        id: renewal.id,
        billing_reason: 'subscription_cycle',
        status: 'paid',
      });
      expect(subscription).toMatchObject({
        id: completed.subscription,
        items: { data: [expect.objectContaining({ quantity: 1 })] },
      });
      expect(api.requests.slice(-2)).toEqual([
        expect.objectContaining({
          method: 'GET',
          path: `/v1/invoices/${renewal.id as string}`,
        }),
        expect.objectContaining({
          method: 'GET',
          path: `/v1/subscriptions/${completed.subscription as string}`,
        }),
      ]);
    });
  });

  describe('webhook signatures', () => {
    const signed = () => {
      const payload = JSON.stringify({
        id: 'evt_1',
        object: 'event',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_test_1', object: 'checkout.session' } },
      });
      const signature = api.client().webhooks.generateTestHeaderString({
        payload,
        secret: FAKE_WEBHOOK_SECRET,
      });
      return { payload, signature };
    };

    it('accepts a correctly signed payload', () => {
      const { payload, signature } = signed();
      expect(
        gateway.constructEvent(Buffer.from(payload), signature),
      ).toMatchObject({ id: 'evt_1', type: 'checkout.session.completed' });
    });

    it.each([
      [
        'a tampered body',
        (p: string, s: string) => [p.replace('cs_test_1', 'cs_test_2'), s],
      ],
      [
        'a signature from another secret',
        (p: string) => [
          p,
          api.client().webhooks.generateTestHeaderString({
            payload: p,
            secret: 'whsec_x',
          }),
        ],
      ],
      [
        'a replayed (stale) signature',
        (p: string) => [
          p,
          api.client().webhooks.generateTestHeaderString({
            payload: p,
            secret: FAKE_WEBHOOK_SECRET,
            timestamp: Math.floor(Date.now() / 1000) - 3600,
          }),
        ],
      ],
      ['a garbage header', (p: string) => [p, 't=1,v1=deadbeef']],
      ['a missing header', (p: string) => [p, undefined]],
      ['an empty body', (_p: string, s: string) => ['', s]],
    ])('rejects %s with 400', (_label, mutate) => {
      const { payload, signature } = signed();
      const [body, header] = mutate(payload, signature);
      expect(() =>
        gateway.constructEvent(Buffer.from(body ?? ''), header),
      ).toThrow(expect.objectContaining({ status: 400 }) as Error);
    });

    it('responds 503 while the webhook secret is not configured', () => {
      const { payload, signature } = signed();
      expect(() =>
        new StripeGateway(
          { ...settings, webhookSecret: null },
          api.client(),
        ).constructEvent(Buffer.from(payload), signature),
      ).toThrow(expect.objectContaining({ status: 503 }) as Error);
    });
  });

  describe('isDefinitiveRejection', () => {
    it.each([
      [
        'invalid request',
        new Stripe.errors.StripeInvalidRequestError({}),
        true,
      ],
      ['authentication', new Stripe.errors.StripeAuthenticationError({}), true],
      ['permission', new Stripe.errors.StripePermissionError({}), true],
      ['connection', new Stripe.errors.StripeConnectionError({}), false],
      ['API (5xx)', new Stripe.errors.StripeAPIError({}), false],
      ['rate limit', new Stripe.errors.StripeRateLimitError({}), false],
      ['idempotency', new Stripe.errors.StripeIdempotencyError({}), false],
      ['non-Stripe', new Error('boom'), false],
    ])('classifies a %s error as definitive=%p', (_label, error, expected) => {
      expect(StripeGateway.isDefinitiveRejection(error)).toBe(expected);
    });
  });
});
