import { BillingInterval } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import type Stripe from 'stripe';
import {
  FAKE_WEBHOOK_SECRET,
  FakeStripeApi,
} from '../../../test/support/fake-stripe-api';
import {
  createInMemoryBillingPrisma,
  type InMemoryBillingPrisma,
} from '../../../test/support/in-memory-billing-prisma';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import type { PrismaService } from '../../common/services/prisma.service';
import type { SubscriptionPlanView } from '../interfaces/subscription-plan.interface';
import { SubscriptionPlanService } from '../subscription-plan.service';
import { StripeCheckoutService } from './stripe-checkout.service';
import type { StripeSettings } from './stripe.config';
import { StripeGateway } from './stripe.gateway';

const { MONTHLY, YEARLY } = BillingInterval;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe('StripeCheckoutService', () => {
  const settings: StripeSettings = {
    secretKey: 'sk_test_fake',
    webhookSecret: FAKE_WEBHOOK_SECRET,
    successUrl: 'https://app.example/checkout/success',
    cancelUrl: 'https://app.example/checkout/cancel',
    productId: null,
    checkoutExpiresMinutes: 60,
  };
  const plans = mock<SubscriptionPlanService>();
  const logger = mock<CustomLoggerService>();
  let api: FakeStripeApi;
  let db: InMemoryBillingPrisma;
  let gateway: StripeGateway;
  let service: StripeCheckoutService;

  const plan = (
    overrides: Partial<SubscriptionPlanView> = {},
  ): SubscriptionPlanView => ({
    code: 'PRO',
    currency: 'USD',
    planEnabled: true,
    monthlyPriceUsdCents: 1900,
    yearlyPriceUsdCents: 19000,
    trialEnabled: true,
    trialDays: 7,
    updatedAt: null,
    ...overrides,
  });

  const build = (
    client: Stripe | null = api.client(),
    config: StripeSettings = settings,
  ) => {
    gateway = new StripeGateway(config, client);
    service = new StripeCheckoutService(
      db as unknown as PrismaService,
      plans,
      gateway,
      logger,
    );
  };

  const createUser = async (overrides: Record<string, unknown> = {}) => {
    const user = await db.authUser.create({ data: { ...overrides } });
    return user.id as string;
  };

  /** A user whose record already holds a paid term. */
  const givenPaidTerm = async (
    authId: string,
    startedAt: Date,
    expiresAt: Date,
    canceledAt: Date | null = null,
  ) =>
    db.userSubscription.create({
      data: {
        authId,
        status: 'PRO',
        billingInterval: MONTHLY,
        proStartedAt: startedAt,
        proExpiresAt: expiresAt,
        proCanceledAt: canceledAt,
      },
    });

  const checkouts = () => db.checkoutSession.rows;
  const pending = () =>
    checkouts().filter((row) =>
      ['CREATING', 'OPEN', 'PROCESSING'].includes(row.status as string),
    );
  const sessionCreates = () => api.count('POST', '/v1/checkout/sessions');
  const rowOf = (checkoutSessionId: string) =>
    checkouts().find((row) => row.id === checkoutSessionId);

  /** Nothing in the checkout flow may grant Pro or record a payment. */
  const expectNoAccessGranted = () => {
    expect(db.paymentTransaction.rows).toHaveLength(0);
    expect(db.subscriptionEvent.rows).toHaveLength(0);
    for (const record of db.userSubscription.rows) {
      if (record.status !== 'PRO') expect(record.proStartedAt).toBeNull();
    }
  };

  beforeEach(() => {
    jest.resetAllMocks();
    plans.getProPlan.mockResolvedValue(plan());
    api = new FakeStripeApi();
    db = createInMemoryBillingPrisma();
    build();
  });

  describe('a new checkout', () => {
    it('uses the backend monthly price and returns the hosted payment page', async () => {
      const userId = await createUser();
      const now = new Date();

      const view = await service.createCheckout(userId, MONTHLY, now);

      expect(view).toEqual({
        checkoutSessionId: expect.any(String) as string,
        provider: 'stripe',
        status: 'OPEN',
        billingInterval: 'MONTHLY',
        amountCents: 1900,
        currency: 'USD',
        url: expect.stringMatching(
          /^https:\/\/checkout\.stripe\.com\//,
        ) as string,
        expiresAt: new Date(now.getTime() + 60 * MINUTE).toISOString(),
        reused: false,
      });
      const [sent] = api.requests.filter(
        (request) => request.path === '/v1/checkout/sessions',
      );
      expect(sent.idempotencyKey).toBe(
        `musecue-checkout-${view.checkoutSessionId}`,
      );
      expect(sent.params).toMatchObject({
        client_reference_id: userId,
        metadata: { checkoutSessionId: view.checkoutSessionId, authId: userId },
        line_items: [
          {
            price_data: {
              unit_amount: '1900',
              currency: 'usd',
              recurring: { interval: 'month' },
            },
          },
        ],
      });
      expect(rowOf(view.checkoutSessionId)).toMatchObject({
        status: 'OPEN',
        provider: 'stripe',
        providerSessionId: api.openSessions()[0].id,
        billingInterval: 'MONTHLY',
        amountCents: 1900,
        currency: 'USD',
        url: view.url,
      });
      expectNoAccessGranted();
    });

    it('uses the yearly price for the yearly option', async () => {
      const userId = await createUser();
      const view = await service.createCheckout(userId, YEARLY);
      expect(view).toMatchObject({
        billingInterval: 'YEARLY',
        amountCents: 19000,
      });
      expect(api.openSessions()[0]).toMatchObject({ amount_total: 19000 });
    });

    it('follows prices changed by an administrator', async () => {
      plans.getProPlan.mockResolvedValue(
        plan({ monthlyPriceUsdCents: 2500, yearlyPriceUsdCents: 24000 }),
      );
      const userId = await createUser();
      await expect(
        service.createCheckout(userId, MONTHLY),
      ).resolves.toMatchObject({ amountCents: 2500 });
    });

    it('reads the plan inside the claiming transaction', async () => {
      const userId = await createUser();
      await service.createCheckout(userId, MONTHLY);
      // Once before touching Stripe, once under the row lock.
      expect(plans.getProPlan.mock.calls).toHaveLength(2);
    });
  });

  describe('Stripe customers', () => {
    it('creates one customer per user and reuses it for later checkouts', async () => {
      const userId = await createUser({ email: 'buyer@example.com' });

      await service.createCheckout(userId, MONTHLY);
      await service.createCheckout(userId, YEARLY);

      expect(api.count('POST', '/v1/customers')).toBe(1);
      expect(db.paymentCustomer.rows).toEqual([
        expect.objectContaining({
          authId: userId,
          provider: 'stripe',
          providerCustomerId: [...api.customers.keys()][0],
        }),
      ]);
      expect([...api.customers.values()][0]).toMatchObject({
        email: 'buyer@example.com',
        metadata: { authId: userId },
      });
      expect(
        new Set(checkouts().map((row) => row.providerCustomerId)).size,
      ).toBe(1);
    });

    it('gives every user their own customer', async () => {
      const first = await createUser();
      const second = await createUser();

      await service.createCheckout(first, MONTHLY);
      await service.createCheckout(second, MONTHLY);

      const customers = db.paymentCustomer.rows.map(
        (row) => row.providerCustomerId,
      );
      expect(new Set(customers).size).toBe(2);
      expect(
        api
          .openSessions()
          .map((session) => session.customer)
          .sort(),
      ).toEqual([...customers].sort());
    });

    it('never links a Stripe customer that already belongs to another user', async () => {
      const owner = await createUser();
      const userId = await createUser();
      jest
        .spyOn(gateway, 'createCustomer')
        .mockResolvedValue('cus_owned_by_someone_else');
      await db.paymentCustomer.create({
        data: {
          authId: owner,
          provider: 'stripe',
          providerCustomerId: 'cus_owned_by_someone_else',
        },
      });

      await expect(
        service.createCheckout(userId, MONTHLY),
      ).rejects.toMatchObject({ status: 500 });
      expect(
        db.paymentCustomer.rows.filter((row) => row.authId === userId),
      ).toHaveLength(0);
      expect(checkouts()).toHaveLength(0);
    });

    it('creates a single customer for concurrent first checkouts', async () => {
      const userId = await createUser();
      await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          service.createCheckout(userId, MONTHLY),
        ),
      );
      expect(api.customers.size).toBe(1);
      expect(db.paymentCustomer.rows).toHaveLength(1);
    });
  });

  describe('who can start a checkout', () => {
    it('responds 503 and calls nothing while Stripe is not configured', async () => {
      build(null);
      const userId = await createUser();
      await expect(
        service.createCheckout(userId, MONTHLY),
      ).rejects.toMatchObject({
        status: 503,
      });
      build(api.client(), { ...settings, successUrl: null });
      await expect(
        service.createCheckout(userId, MONTHLY),
      ).rejects.toMatchObject({
        status: 503,
      });
      expect(api.requests).toHaveLength(0);
      expect(checkouts()).toHaveLength(0);
    });

    it('rejects an unknown user with 401', async () => {
      await expect(
        service.createCheckout('missing-user', MONTHLY),
      ).rejects.toMatchObject({ status: 401 });
    });

    it.each([
      ['suspended', { status: 'SUSPENDED' }],
      ['inactive', { status: 'INACTIVE' }],
      ['unverified', { verified: false }],
      ['soft-deleted', { deletedAt: new Date() }],
    ])(
      'rejects a %s account with 403 before contacting Stripe',
      async (_l, account) => {
        const userId = await createUser(account);
        await expect(
          service.createCheckout(userId, MONTHLY),
        ).rejects.toMatchObject({
          status: 403,
          message: 'Only active accounts can purchase Pro',
        });
        expect(api.requests).toHaveLength(0);
      },
    );

    it('rejects checkout with 403 while the plan is disabled', async () => {
      plans.getProPlan.mockResolvedValue(plan({ planEnabled: false }));
      const userId = await createUser();
      await expect(
        service.createCheckout(userId, YEARLY),
      ).rejects.toMatchObject({
        status: 403,
        message: 'The Pro plan is not currently available',
      });
      expect(api.requests).toHaveLength(0);
    });

    it.each([
      ['an active paid term', null],
      ['a canceled term that is still running', new Date()],
    ])('rejects a user with %s (409)', async (_label, canceledAt) => {
      const userId = await createUser();
      const now = new Date();
      await givenPaidTerm(
        userId,
        new Date(now.getTime() - DAY),
        new Date(now.getTime() + 20 * DAY),
        canceledAt,
      );

      for (const interval of [MONTHLY, YEARLY]) {
        await expect(
          service.createCheckout(userId, interval, now),
        ).rejects.toMatchObject({
          status: 409,
          message: 'You already have an active Pro subscription',
        });
      }
      expect(api.requests).toHaveLength(0);
      expect(checkouts()).toHaveLength(0);
    });

    it('refuses a user whose failed renewal Stripe is still retrying (409)', async () => {
      const userId = await createUser();
      const now = new Date();
      await db.userSubscription.create({
        data: {
          authId: userId,
          status: 'EXPIRED',
          billingInterval: MONTHLY,
          proStartedAt: new Date(now.getTime() - 40 * DAY),
          proExpiresAt: new Date(now.getTime() - 10 * DAY),
          paymentProvider: 'stripe',
          providerSubscriptionId: 'sub_past_due',
          pastDueSince: new Date(now.getTime() - 10 * DAY),
        },
      });

      for (const interval of [MONTHLY, YEARLY]) {
        await expect(
          service.createCheckout(userId, interval, now),
        ).rejects.toMatchObject({
          status: 409,
          message: expect.stringContaining('could charge you twice') as string,
        });
      }
      expect(api.requests).toHaveLength(0);
      expect(checkouts()).toHaveLength(0);
    });

    it('lets a user whose paid term expired buy again', async () => {
      const userId = await createUser();
      const now = new Date();
      await givenPaidTerm(
        userId,
        new Date(now.getTime() - 40 * DAY),
        new Date(now.getTime() - 9 * DAY),
      );
      await expect(
        service.createCheckout(userId, MONTHLY, now),
      ).resolves.toMatchObject({ status: 'OPEN' });
    });

    it('lets a user on the free trial buy Pro', async () => {
      const userId = await createUser();
      const now = new Date();
      await db.userSubscription.create({
        data: {
          authId: userId,
          status: 'TRIAL',
          trialUsed: true,
          trialStartedAt: new Date(now.getTime() - DAY),
          trialExpiresAt: new Date(now.getTime() + 6 * DAY),
        },
      });
      await expect(
        service.createCheckout(userId, YEARLY, now),
      ).resolves.toMatchObject({ status: 'OPEN' });
    });
  });

  describe('duplicate checkouts', () => {
    it('reuses the pending checkout for the same billing option', async () => {
      const userId = await createUser();
      const first = await service.createCheckout(userId, MONTHLY);

      const again = await service.createCheckout(userId, MONTHLY);

      expect(again).toEqual({ ...first, reused: true });
      expect(sessionCreates()).toBe(1);
      // Reuse is confirmed with Stripe, not assumed from the database.
      expect(api.count('GET', /^\/v1\/checkout\/sessions\/cs_/)).toBe(1);
      expect(checkouts()).toHaveLength(1);
    });

    it('returns one checkout to concurrent requests for the same option', async () => {
      const userId = await createUser();

      const views = await Promise.all(
        Array.from({ length: 6 }, () =>
          service.createCheckout(userId, MONTHLY),
        ),
      );

      expect(new Set(views.map((view) => view.checkoutSessionId)).size).toBe(1);
      expect(new Set(views.map((view) => view.url)).size).toBe(1);
      expect(api.sessions.size).toBe(1);
      expect(checkouts()).toHaveLength(1);
    });

    it('expires the previous Stripe session when the user picks the other option', async () => {
      const userId = await createUser();
      const monthly = await service.createCheckout(userId, MONTHLY);
      const monthlySessionId = rowOf(monthly.checkoutSessionId)
        ?.providerSessionId as string;

      const yearly = await service.createCheckout(userId, YEARLY);

      expect(yearly).toMatchObject({
        billingInterval: 'YEARLY',
        amountCents: 19000,
        reused: false,
      });
      expect(yearly.checkoutSessionId).not.toBe(monthly.checkoutSessionId);
      expect(api.sessions.get(monthlySessionId)?.status).toBe('expired');
      expect(
        api.count('POST', `/v1/checkout/sessions/${monthlySessionId}/expire`),
      ).toBe(1);
      expect(rowOf(monthly.checkoutSessionId)).toMatchObject({
        status: 'EXPIRED',
        closedReason: 'REPLACED',
        closedAt: expect.any(Date) as Date,
      });
      expect(api.openSessions()).toHaveLength(1);
      expect(pending()).toEqual([
        expect.objectContaining({
          id: yearly.checkoutSessionId,
          status: 'OPEN',
        }),
      ]);
    });

    it('keeps a single payable session when the user keeps switching', async () => {
      const userId = await createUser();
      for (const interval of [MONTHLY, YEARLY, MONTHLY, MONTHLY, YEARLY]) {
        await service.createCheckout(userId, interval);
      }
      expect(api.openSessions()).toHaveLength(1);
      expect(api.openSessions()[0]).toMatchObject({ amount_total: 19000 });
      expect(pending()).toHaveLength(1);
      expect(sessionCreates()).toBe(4);
    });

    it('always leaves exactly one payable session under concurrent mixed requests', async () => {
      api = new FakeStripeApi(5);
      build();
      const userId = await createUser();

      for (let round = 0; round < 4; round++) {
        const intervals = Array.from({ length: 12 }, () =>
          Math.random() < 0.5 ? MONTHLY : YEARLY,
        );
        const results = await Promise.allSettled(
          intervals.map((interval) => service.createCheckout(userId, interval)),
        );

        // Never two payable sessions, and never none: whoever closes a
        // checkout creates its replacement in the same transaction.
        expect(api.openSessions()).toHaveLength(1);
        expect(pending()).toHaveLength(1);
        expect(pending()[0]).toMatchObject({
          status: 'OPEN',
          providerSessionId: api.openSessions()[0].id,
        });
        for (const result of results) {
          if (result.status === 'rejected') {
            expect(result.reason).toMatchObject({ status: 409 });
          }
        }
        expect(results.some((result) => result.status === 'fulfilled')).toBe(
          true,
        );
      }
    });

    it('reuses the open checkout at its original price after an admin price change', async () => {
      const userId = await createUser();
      const old = await service.createCheckout(userId, MONTHLY);
      plans.getProPlan.mockResolvedValue(plan({ monthlyPriceUsdCents: 2900 }));

      const again = await service.createCheckout(userId, MONTHLY);

      expect(again).toEqual({ ...old, reused: true });
      expect(again.amountCents).toBe(1900);
      expect(sessionCreates()).toBe(1);
      expect(api.openSessions()).toEqual([
        expect.objectContaining({ amount_total: 1900 }),
      ]);
    });

    it('uses a changed price only for checkouts created afterwards', async () => {
      const userId = await createUser();
      await service.createCheckout(userId, MONTHLY);
      plans.getProPlan.mockResolvedValue(
        plan({ monthlyPriceUsdCents: 2900, yearlyPriceUsdCents: 29000 }),
      );

      const yearly = await service.createCheckout(userId, YEARLY);
      const monthly = await service.createCheckout(userId, MONTHLY);

      expect(yearly).toMatchObject({ amountCents: 29000, reused: false });
      expect(monthly).toMatchObject({ amountCents: 2900, reused: false });
      expect(
        checkouts().map((row) => [row.billingInterval, row.amountCents]),
      ).toEqual([
        ['MONTHLY', 1900],
        ['YEARLY', 29000],
        ['MONTHLY', 2900],
      ]);
      expect(api.openSessions()).toEqual([
        expect.objectContaining({ amount_total: 2900 }),
      ]);
    });

    it('reuses a valid checkout however little time it has left', async () => {
      const userId = await createUser();
      const old = await service.createCheckout(userId, MONTHLY, new Date());
      const oneMinuteLeft = new Date(
        new Date(old.expiresAt).getTime() - MINUTE,
      );

      const again = await service.createCheckout(
        userId,
        MONTHLY,
        oneMinuteLeft,
      );

      expect(again).toEqual({ ...old, reused: true });
      expect(sessionCreates()).toBe(1);
    });

    it('starts a new checkout after Stripe expired the previous one', async () => {
      const userId = await createUser();
      const old = await service.createCheckout(userId, MONTHLY);
      api.expireByTime(
        rowOf(old.checkoutSessionId)?.providerSessionId as string,
      );

      const current = await service.createCheckout(userId, MONTHLY);

      expect(current.checkoutSessionId).not.toBe(old.checkoutSessionId);
      expect(rowOf(old.checkoutSessionId)).toMatchObject({
        status: 'EXPIRED',
        closedReason: 'PROVIDER_EXPIRED',
      });
    });
  });

  describe('a checkout the user already paid', () => {
    it('blocks a new checkout until the webhook confirms the payment, without granting access', async () => {
      const userId = await createUser();
      const view = await service.createCheckout(userId, MONTHLY);
      const sessionId = rowOf(view.checkoutSessionId)
        ?.providerSessionId as string;
      // Paid on the hosted page and redirected back; no webhook yet.
      api.completeSession(sessionId);

      for (const interval of [MONTHLY, YEARLY]) {
        await expect(
          service.createCheckout(userId, interval),
        ).rejects.toMatchObject({
          status: 409,
          message: 'Your previous checkout payment is still being processed',
        });
      }
      expect(rowOf(view.checkoutSessionId)?.status).toBe('PROCESSING');
      expect(sessionCreates()).toBe(1);
      expect(api.count('POST', /\/expire$/)).toBe(0);
      expectNoAccessGranted();
    });

    it('does not expire a session the user paid between the status check and the switch', async () => {
      const userId = await createUser();
      const view = await service.createCheckout(userId, MONTHLY);
      const sessionId = rowOf(view.checkoutSessionId)
        ?.providerSessionId as string;
      const stripe = api.client();
      jest
        .spyOn(gateway, 'expireCheckoutSession')
        .mockImplementationOnce(async (id: string) => {
          api.completeSession(id); // the payment lands first
          const session = await stripe.checkout.sessions.expire(id);
          return {
            id: session.id,
            url: session.url,
            status: session.status,
            paymentStatus: session.payment_status,
          };
        });

      await expect(
        service.createCheckout(userId, YEARLY),
      ).rejects.toMatchObject({
        status: 409,
        message: 'Your previous checkout payment is still being processed',
      });
      expect(api.sessions.get(sessionId)?.status).toBe('complete');
      expect(rowOf(view.checkoutSessionId)?.status).toBe('PROCESSING');
      expect(sessionCreates()).toBe(1);
    });
  });

  describe('switching option when the old session cannot be expired', () => {
    /** A user with an open monthly checkout who now asks for yearly. */
    async function openMonthly() {
      const userId = await createUser();
      const monthly = await service.createCheckout(userId, MONTHLY);
      const sessionId = rowOf(monthly.checkoutSessionId)
        ?.providerSessionId as string;
      return { userId, monthly, sessionId };
    }

    /** Nothing new exists and the old checkout is still the pending one. */
    const expectOldCheckoutKept = (checkoutSessionId: string) => {
      expect(sessionCreates()).toBe(1);
      expect(checkouts()).toHaveLength(1);
      expect(pending()).toEqual([
        expect.objectContaining({ id: checkoutSessionId, status: 'OPEN' }),
      ]);
      expect(api.openSessions().length).toBeLessThanOrEqual(1);
    };

    it.each([
      ['Stripe is unreachable', 'connection'],
      ['Stripe fails with a server error', 'server'],
      ['Stripe rejects the request', 'invalid'],
    ] as const)(
      'keeps the old checkout and creates nothing when %s',
      async (_label, failure) => {
        const { userId, monthly, sessionId } = await openMonthly();
        api.failNext('POST /v1/checkout/sessions/:id/expire', failure);

        await expect(
          service.createCheckout(userId, YEARLY),
        ).rejects.toMatchObject({
          status: 503,
          message:
            'The previous checkout could not be closed; please try again shortly',
        });

        expectOldCheckoutKept(monthly.checkoutSessionId);
        expect(api.sessions.get(sessionId)?.status).toBe('open');
      },
    );

    it('creates nothing when Stripe can be reached for neither expiry nor status', async () => {
      const { userId, monthly } = await openMonthly();
      api.failNext('POST /v1/checkout/sessions/:id/expire', 'connection');
      api.failNext('GET /v1/checkout/sessions/:id', 'connection');

      await expect(
        service.createCheckout(userId, YEARLY),
      ).rejects.toMatchObject({ status: 503 });
      expectOldCheckoutKept(monthly.checkoutSessionId);
    });

    it('does not treat an unconfirmed expiration as successful', async () => {
      const { userId, monthly } = await openMonthly();
      jest.spyOn(gateway, 'expireCheckoutSession').mockResolvedValueOnce({
        id: 'cs_test_x',
        url: null,
        status: 'open',
        paymentStatus: 'unpaid',
      });

      await expect(
        service.createCheckout(userId, YEARLY),
      ).rejects.toMatchObject({ status: 503 });
      expectOldCheckoutKept(monthly.checkoutSessionId);
    });

    it('creates nothing in the request whose expiration response was lost, and replaces it on retry', async () => {
      const { userId, monthly, sessionId } = await openMonthly();
      // Stripe expires the session but the response never arrives.
      api.failNext('POST /v1/checkout/sessions/:id/expire', 'lost');

      await expect(
        service.createCheckout(userId, YEARLY),
      ).rejects.toMatchObject({ status: 409 });
      expect(sessionCreates()).toBe(1);
      expect(rowOf(monthly.checkoutSessionId)?.status).toBe('OPEN');
      expect(api.sessions.get(sessionId)?.status).toBe('expired');

      // A later request reads the expiry from Stripe and only then replaces it.
      const yearly = await service.createCheckout(userId, YEARLY);

      expect(yearly).toMatchObject({
        billingInterval: 'YEARLY',
        reused: false,
      });
      expect(rowOf(monthly.checkoutSessionId)).toMatchObject({
        status: 'EXPIRED',
        closedReason: 'PROVIDER_EXPIRED',
      });
      expect(api.openSessions()).toHaveLength(1);
      expect(pending()).toHaveLength(1);
    });

    it('never lets the user pay twice when expiration fails and they retry', async () => {
      const { userId, sessionId } = await openMonthly();
      api.failNext('POST /v1/checkout/sessions/:id/expire', 'connection');
      await expect(service.createCheckout(userId, YEARLY)).rejects.toThrow();

      // The user pays the old session that could not be closed.
      api.completeSession(sessionId);

      await expect(
        service.createCheckout(userId, YEARLY),
      ).rejects.toMatchObject({
        status: 409,
        message: 'Your previous checkout payment is still being processed',
      });
      expect(sessionCreates()).toBe(1);
      expect(api.openSessions()).toHaveLength(0);
    });
  });

  describe('Stripe failures', () => {
    it('keeps the checkout when the response is lost and recovers the same session', async () => {
      const userId = await createUser();
      api.failNext('POST /v1/checkout/sessions', 'lost');

      await expect(
        service.createCheckout(userId, MONTHLY),
      ).rejects.toMatchObject({
        status: 503,
      });
      expect(checkouts()).toEqual([
        expect.objectContaining({ status: 'CREATING' }),
      ]);
      expect(api.sessions.size).toBe(1); // Stripe did create it

      const view = await service.createCheckout(userId, MONTHLY);

      expect(view.reused).toBe(true);
      expect(api.sessions.size).toBe(1);
      expect(rowOf(view.checkoutSessionId)?.providerSessionId).toBe(
        [...api.sessions.keys()][0],
      );
    });

    it('recovers from a request that never reached Stripe', async () => {
      const userId = await createUser();
      api.failNext('POST /v1/checkout/sessions', 'connection');
      await expect(
        service.createCheckout(userId, YEARLY),
      ).rejects.toMatchObject({
        status: 503,
      });

      await expect(
        service.createCheckout(userId, YEARLY),
      ).resolves.toMatchObject({
        status: 'OPEN',
      });
      expect(api.sessions.size).toBe(1);
      expect(checkouts()).toHaveLength(1);
    });

    it('closes a checkout Stripe definitively rejected and allows a new one', async () => {
      const userId = await createUser();
      api.failNext('POST /v1/checkout/sessions', 'invalid');

      await expect(
        service.createCheckout(userId, MONTHLY),
      ).rejects.toMatchObject({
        status: 503,
        message: 'The payment provider is temporarily unavailable',
      });
      expect(checkouts()).toEqual([
        expect.objectContaining({
          status: 'FAILED',
          closedReason: 'PROVIDER_REJECTED',
        }),
      ]);

      await expect(
        service.createCheckout(userId, MONTHLY),
      ).resolves.toMatchObject({
        status: 'OPEN',
      });
      expect(logger.logWithMetadata.mock.calls).toContainEqual([
        'warn',
        'Stripe request failed',
        expect.objectContaining({
          operation: 'checkout.sessions.create',
          errorType: 'StripeInvalidRequestError',
          rawType: 'invalid_request_error',
          statusCode: 400,
        }),
      ]);
    });

    it('closes an unopened checkout once its expiry has passed', async () => {
      const userId = await createUser();
      const start = new Date();
      api.failNext('POST /v1/checkout/sessions', 'connection');
      await expect(
        service.createCheckout(userId, MONTHLY, start),
      ).rejects.toThrow();
      const stale = checkouts()[0];

      const later = new Date(start.getTime() + 61 * MINUTE);
      const view = await service.createCheckout(userId, MONTHLY, later);

      expect(rowOf(stale.id as string)).toMatchObject({
        status: 'EXPIRED',
        closedReason: 'NEVER_OPENED',
      });
      expect(view.checkoutSessionId).not.toBe(stale.id);
    });

    it('returns 503 when the customer cannot be created and creates no checkout', async () => {
      const userId = await createUser();
      api.failNext('POST /v1/customers', 'server');
      await expect(
        service.createCheckout(userId, MONTHLY),
      ).rejects.toMatchObject({
        status: 503,
      });
      expect(db.paymentCustomer.rows).toHaveLength(0);
      expect(checkouts()).toHaveLength(0);
    });

    it('returns 503 when Stripe cannot confirm a pending session is still open', async () => {
      const userId = await createUser();
      await service.createCheckout(userId, MONTHLY);
      api.failNext('GET /v1/checkout/sessions/:id', 'server');

      await expect(
        service.createCheckout(userId, MONTHLY),
      ).rejects.toMatchObject({
        status: 503,
      });
      expect(pending()).toHaveLength(1);
    });

    it('never logs the Stripe error message, which may contain personal data', async () => {
      const userId = await createUser();
      api.failNext('POST /v1/checkout/sessions', 'invalid');
      await expect(service.createCheckout(userId, MONTHLY)).rejects.toThrow();
      const logged = JSON.stringify(logger.logWithMetadata.mock.calls);
      expect(logged).not.toContain('Invalid request');
    });
  });
});
