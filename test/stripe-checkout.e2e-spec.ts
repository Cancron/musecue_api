import { INestApplication } from '@nestjs/common';
import {
  BillingInterval,
  Prisma,
  PrismaClient,
  userStatus,
} from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { addBillingInterval } from '../src/subscription/billing.validation';
import { FakeStripeApi } from './support/fake-stripe-api';
import { describeWithDatabase } from './support/migrated-schema';
import {
  createStripeTestApp,
  dataOf,
  type StripeTestApp,
} from './support/stripe-test-app';
import {
  createUser,
  givenPaidProHistory,
} from './support/subscription-fixtures';

jest.setTimeout(120_000);

/**
 * Stripe checkout end to end: the real Nest HTTP stack, services, Prisma and
 * migrated PostgreSQL schema (row locks, partial unique index, triggers),
 * with Stripe replaced by FakeStripeApi behind the real Stripe SDK.
 */
describeWithDatabase('Stripe checkout (PostgreSQL, HTTP)', () => {
  let harness: StripeTestApp;
  let client: PrismaClient;
  let app: INestApplication<App>;
  let api: FakeStripeApi;

  beforeAll(async () => {
    harness = await createStripeTestApp();
    client = harness.client;
    app = harness.app;
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(() => {
    api = new FakeStripeApi(5);
    harness.stripe.api = api;
  });

  const startCheckout = (userId: string, billingInterval: string) =>
    harness.startCheckout(userId, billingInterval);
  const status = (userId: string) => harness.status(userId);
  const sendWebhook = (type: string, sessionId: string) => {
    const { payload, signature } = api.signedEvent(type, sessionId);
    return harness.sendWebhook(payload, signature);
  };

  const checkoutsOf = async (userId: string) =>
    client.checkoutSession.findMany({
      where: { subscription: { authId: userId } },
      orderBy: { createdAt: 'asc' },
    });
  const providerSessionOf = async (checkoutSessionId: string) =>
    (
      await client.checkoutSession.findUniqueOrThrow({
        where: { id: checkoutSessionId },
      })
    ).providerSessionId as string;

  describe('purchase', () => {
    it('grants Pro only after the signed, verified webhook', async () => {
      const userId = await createUser(client);

      const started = await startCheckout(userId, 'MONTHLY').expect(201);
      const view = dataOf(started);
      expect(view).toMatchObject({
        provider: 'stripe',
        status: 'OPEN',
        billingInterval: 'MONTHLY',
        amountCents: 1900,
        currency: 'USD',
        reused: false,
      });
      const sessionId = await providerSessionOf(view.checkoutSessionId);

      // The user pays and the browser returns to the success URL.
      const periodStart = new Date();
      periodStart.setUTCMilliseconds(0);
      api.completeSession(sessionId, { periodStart });
      await expect(status(userId)).resolves.toMatchObject({
        status: 'FREE',
        hasProAccess: false,
      });

      // An unsigned "payment succeeded" call changes nothing.
      await request(app.getHttpServer())
        .post('/v1/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .send(api.signedEvent('checkout.session.completed', sessionId).payload)
        .expect(400);
      await expect(status(userId)).resolves.toMatchObject({
        hasProAccess: false,
      });

      await sendWebhook('checkout.session.completed', sessionId).expect(200);

      const periodEnd = addBillingInterval(
        periodStart,
        BillingInterval.MONTHLY,
      );
      await expect(status(userId)).resolves.toMatchObject({
        status: 'PRO',
        hasProAccess: true,
        accessSource: 'PRO',
        accessExpiresAt: periodEnd.toISOString(),
        pro: {
          active: true,
          billingInterval: 'MONTHLY',
          startedAt: periodStart.toISOString(),
          expiresAt: periodEnd.toISOString(),
        },
      });

      const record = await client.userSubscription.findUniqueOrThrow({
        where: { authId: userId },
        include: { payments: true, events: true, checkoutSessions: true },
      });
      const stripeSession = api.sessions.get(sessionId) as Record<
        string,
        string
      >;
      expect(record).toMatchObject({
        paymentProvider: 'stripe',
        providerSubscriptionId: stripeSession.subscription,
      });
      expect(record.payments).toEqual([
        expect.objectContaining({
          provider: 'stripe',
          providerPaymentId: stripeSession.invoice,
          status: 'SUCCEEDED',
          amountCents: 1900,
          currency: 'USD',
          periodStart,
          periodEnd,
        }),
      ]);
      expect(record.events).toEqual([
        expect.objectContaining({
          type: 'CREATED',
          paymentId: record.payments[0].id,
        }),
      ]);
      expect(record.checkoutSessions).toEqual([
        expect.objectContaining({
          status: 'COMPLETED',
          paymentId: record.payments[0].id,
        }),
      ]);
      await expect(
        client.paymentCustomer.findMany({ where: { authId: userId } }),
      ).resolves.toEqual([
        expect.objectContaining({
          provider: 'stripe',
          providerCustomerId: stripeSession.customer,
        }),
      ]);
      const audit = await client.activityLogEvent.findMany({
        where: { tableName: 'UserSubscription', recordId: record.id },
      });
      expect(audit).toEqual([
        expect.objectContaining({
          action: 'update',
          actionedBy: null,
          userAgent: expect.stringContaining('Stripe') as string,
        }),
      ]);

      // A paid subscriber cannot start another checkout.
      for (const interval of ['MONTHLY', 'YEARLY']) {
        await startCheckout(userId, interval).expect(409);
      }
    });

    it('activates a yearly purchase with a calendar period the database accepts', async () => {
      const userId = await createUser(client);
      const view = dataOf(await startCheckout(userId, 'YEARLY').expect(201));
      const sessionId = await providerSessionOf(view.checkoutSessionId);
      // A leap day start: Feb 29 + 1 year clamps to Feb 28.
      const periodStart = new Date('2024-02-29T08:15:00.000Z');
      api.completeSession(sessionId, { periodStart });

      await sendWebhook('checkout.session.completed', sessionId).expect(200);

      await expect(
        client.userSubscription.findUniqueOrThrow({
          where: { authId: userId },
        }),
      ).resolves.toMatchObject({
        billingInterval: 'YEARLY',
        proStartedAt: periodStart,
        proExpiresAt: new Date('2025-02-28T08:15:00.000Z'),
      });
    });

    it('lets a user with expired paid history buy again', async () => {
      const userId = await createUser(client);
      const now = new Date();
      await givenPaidProHistory(
        client,
        userId,
        {
          billingInterval: BillingInterval.MONTHLY,
          startedAt: new Date(now.getTime() - 90 * 86_400_000),
        },
        now,
      );
      const view = dataOf(await startCheckout(userId, 'MONTHLY').expect(201));
      const sessionId = await providerSessionOf(view.checkoutSessionId);
      api.completeSession(sessionId);

      await sendWebhook('checkout.session.completed', sessionId).expect(200);

      await expect(status(userId)).resolves.toMatchObject({ status: 'PRO' });
      await expect(
        client.subscriptionEvent.count({
          where: { subscription: { authId: userId }, type: 'CREATED' },
        }),
      ).resolves.toBe(2);
    });

    it('records one payment for duplicate concurrent webhook deliveries', async () => {
      const userId = await createUser(client);
      const view = dataOf(await startCheckout(userId, 'MONTHLY').expect(201));
      const sessionId = await providerSessionOf(view.checkoutSessionId);
      api.completeSession(sessionId);

      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          sendWebhook('checkout.session.completed', sessionId),
        ),
      );

      expect(responses.map((response) => response.status)).toEqual(
        Array(6).fill(200),
      );
      await expect(
        client.paymentTransaction.count({
          where: { subscription: { authId: userId } },
        }),
      ).resolves.toBe(1);
      await expect(
        client.subscriptionEvent.count({
          where: { subscription: { authId: userId } },
        }),
      ).resolves.toBe(1);
    });

    it('rejects inactive accounts before anything is created', async () => {
      const userId = await createUser(client, userStatus.ACTIVE, {
        verified: false,
      });
      await startCheckout(userId, 'MONTHLY').expect(403);
      expect(api.requests).toHaveLength(0);
      await expect(checkoutsOf(userId)).resolves.toHaveLength(0);
    });
  });

  describe('duplicate checkouts', () => {
    it('returns one checkout to concurrent requests for the same option', async () => {
      const userId = await createUser(client);

      const responses = await Promise.all(
        Array.from({ length: 8 }, () => startCheckout(userId, 'YEARLY')),
      );

      expect(responses.map((response) => response.status)).toEqual(
        Array(8).fill(201),
      );
      const ids = new Set(
        responses.map((response) => dataOf(response).checkoutSessionId),
      );
      expect(ids.size).toBe(1);
      await expect(checkoutsOf(userId)).resolves.toHaveLength(1);
      expect(api.sessions.size).toBe(1);
      expect(api.customers.size).toBe(1);
      await expect(
        client.paymentCustomer.count({ where: { authId: userId } }),
      ).resolves.toBe(1);
    });

    it('expires the previous session when the user switches option', async () => {
      const userId = await createUser(client);
      const monthly = dataOf(
        await startCheckout(userId, 'MONTHLY').expect(201),
      );
      const monthlySession = await providerSessionOf(monthly.checkoutSessionId);

      const yearly = dataOf(await startCheckout(userId, 'YEARLY').expect(201));

      expect(api.sessions.get(monthlySession)?.status).toBe('expired');
      expect(() => api.completeSession(monthlySession)).toThrow(/expired/);
      await expect(checkoutsOf(userId)).resolves.toEqual([
        expect.objectContaining({
          id: monthly.checkoutSessionId,
          status: 'EXPIRED',
          closedReason: 'REPLACED',
        }),
        expect.objectContaining({
          id: yearly.checkoutSessionId,
          status: 'OPEN',
          billingInterval: 'YEARLY',
          amountCents: 19000,
        }),
      ]);
    });

    it('never leaves two payable sessions under concurrent mixed requests', async () => {
      const userId = await createUser(client);
      const intervals = [
        'MONTHLY',
        'YEARLY',
        'YEARLY',
        'MONTHLY',
        'YEARLY',
        'MONTHLY',
      ];

      const responses = await Promise.all(
        intervals.map((interval) => startCheckout(userId, interval)),
      );

      for (const response of responses)
        expect([201, 409]).toContain(response.status);
      expect(responses.some((response) => response.status === 201)).toBe(true);
      expect(api.openSessions()).toHaveLength(1);
      const pending = (await checkoutsOf(userId)).filter((row) =>
        ['CREATING', 'OPEN', 'PROCESSING'].includes(row.status),
      );
      expect(pending).toHaveLength(1);
      expect(pending[0].providerSessionId).toBe(api.openSessions()[0].id);

      // Whatever the race, only the surviving session can be paid, once.
      api.completeSession(pending[0].providerSessionId as string);
      await sendWebhook(
        'checkout.session.completed',
        pending[0].providerSessionId as string,
      ).expect(200);
      await expect(status(userId)).resolves.toMatchObject({ status: 'PRO' });
      await expect(
        client.paymentTransaction.count({
          where: { subscription: { authId: userId } },
        }),
      ).resolves.toBe(1);
    });
  });

  describe('price changes and failed expirations', () => {
    afterEach(async () => {
      await client.subscriptionPlan.deleteMany();
    });

    const changePrices = (monthly: number, yearly: number) =>
      client.subscriptionPlan.upsert({
        where: { code: 'PRO' },
        create: {
          code: 'PRO',
          monthlyPriceUsdCents: monthly,
          yearlyPriceUsdCents: yearly,
        },
        update: { monthlyPriceUsdCents: monthly, yearlyPriceUsdCents: yearly },
      });

    it('reuses the open session at its old price and prices only new sessions at the new price', async () => {
      const userId = await createUser(client);
      const first = dataOf(await startCheckout(userId, 'MONTHLY').expect(201));
      await changePrices(2900, 29000);

      const again = dataOf(await startCheckout(userId, 'MONTHLY').expect(201));
      expect(again).toMatchObject({
        checkoutSessionId: first.checkoutSessionId,
        url: first.url,
        amountCents: 1900,
        reused: true,
      });

      const yearly = dataOf(await startCheckout(userId, 'YEARLY').expect(201));
      expect(yearly).toMatchObject({ amountCents: 29000, reused: false });
      const monthly = dataOf(
        await startCheckout(userId, 'MONTHLY').expect(201),
      );
      expect(monthly).toMatchObject({ amountCents: 2900, reused: false });

      await expect(checkoutsOf(userId)).resolves.toEqual([
        expect.objectContaining({ amountCents: 1900, status: 'EXPIRED' }),
        expect.objectContaining({ amountCents: 29000, status: 'EXPIRED' }),
        expect.objectContaining({ amountCents: 2900, status: 'OPEN' }),
      ]);
      expect(api.openSessions()).toEqual([
        expect.objectContaining({ amount_total: 2900 }),
      ]);
    });

    it.each(['connection', 'server', 'lost'] as const)(
      'creates no new session when expiring the old one fails (%s)',
      async (failure) => {
        const userId = await createUser(client);
        const monthly = dataOf(
          await startCheckout(userId, 'MONTHLY').expect(201),
        );
        api.failNext('POST /v1/checkout/sessions/:id/expire', failure);

        const response = await startCheckout(userId, 'YEARLY');

        expect([409, 503]).toContain(response.status);
        expect(api.count('POST', '/v1/checkout/sessions')).toBe(1);
        await expect(checkoutsOf(userId)).resolves.toEqual([
          expect.objectContaining({
            id: monthly.checkoutSessionId,
            status: 'OPEN',
          }),
        ]);
        expect(api.openSessions().length).toBeLessThanOrEqual(1);
      },
    );
  });

  describe('database rules', () => {
    async function subscriptionWithCheckout() {
      const authId = await createUser(client);
      const subscription = await client.userSubscription.create({
        data: { authId },
      });
      const checkout = await client.checkoutSession.create({
        data: {
          subscriptionId: subscription.id,
          provider: 'stripe',
          providerCustomerId: `cus_${authId}`,
          billingInterval: 'MONTHLY',
          amountCents: 1900,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      return { authId, subscription, checkout };
    }

    it('allows only one pending checkout per user', async () => {
      const { subscription, checkout } = await subscriptionWithCheckout();
      await expect(
        client.checkoutSession.create({
          data: {
            subscriptionId: subscription.id,
            provider: 'stripe',
            providerCustomerId: checkout.providerCustomerId,
            billingInterval: 'YEARLY',
            amountCents: 19000,
            expiresAt: checkout.expiresAt,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('allows a new pending checkout once the previous one is closed', async () => {
      const { subscription, checkout } = await subscriptionWithCheckout();
      await client.checkoutSession.update({
        where: { id: checkout.id },
        data: {
          status: 'EXPIRED',
          closedAt: new Date(),
          closedReason: 'REPLACED',
        },
      });
      await expect(
        client.checkoutSession.create({
          data: {
            subscriptionId: subscription.id,
            provider: 'stripe',
            providerCustomerId: checkout.providerCustomerId,
            billingInterval: 'YEARLY',
            amountCents: 19000,
            expiresAt: checkout.expiresAt,
          },
        }),
      ).resolves.toMatchObject({ status: 'CREATING' });
    });

    const IMMUTABLE =
      /price, interval, customer, expiry, provider session and payment cannot change/;
    it.each<[string, Prisma.CheckoutSessionUpdateInput, RegExp]>([
      [
        'an OPEN checkout without a hosted page URL',
        { status: 'OPEN', providerSessionId: 'cs_1' },
        /CheckoutSession_open_has_url/,
      ],
      [
        'an OPEN checkout without a provider session',
        { status: 'OPEN', url: 'https://x' },
        /CheckoutSession_provider_session_present/,
      ],
      [
        'COMPLETED without a payment',
        {
          status: 'COMPLETED',
          providerSessionId: 'cs_1',
          completedAt: new Date(),
        },
        /CheckoutSession_completed_has_payment/,
      ],
      [
        'EXPIRED without a close time',
        { status: 'EXPIRED' },
        /CheckoutSession_closed_at/,
      ],
      ['a change of price', { amountCents: 1 }, IMMUTABLE],
      ['a change of billing option', { billingInterval: 'YEARLY' }, IMMUTABLE],
      ['a change of customer', { providerCustomerId: 'cus_other' }, IMMUTABLE],
    ])('rejects %s', async (_label, data, reason) => {
      const { checkout } = await subscriptionWithCheckout();
      await expect(
        client.checkoutSession.update({ where: { id: checkout.id }, data }),
      ).rejects.toThrow(reason);
    });

    it('only moves forward and never reopens a closed checkout', async () => {
      const { checkout } = await subscriptionWithCheckout();
      await client.checkoutSession.update({
        where: { id: checkout.id },
        data: { status: 'OPEN', providerSessionId: 'cs_fwd', url: 'https://x' },
      });
      await client.checkoutSession.update({
        where: { id: checkout.id },
        data: { status: 'EXPIRED', closedAt: new Date() },
      });
      await expect(
        client.checkoutSession.update({
          where: { id: checkout.id },
          data: { status: 'OPEN', closedAt: null },
        }),
      ).rejects.toThrow(/cannot change from EXPIRED to OPEN/);
      await expect(
        client.checkoutSession.update({
          where: { id: checkout.id },
          data: { providerSessionId: 'cs_other' },
        }),
      ).rejects.toThrow();
    });

    it('can only be completed by a SUCCEEDED payment of the same subscription', async () => {
      const { subscription, checkout } = await subscriptionWithCheckout();
      const start = new Date('2026-03-01T00:00:00.000Z');
      const pendingPayment = await client.paymentTransaction.create({
        data: {
          subscriptionId: subscription.id,
          provider: 'stripe',
          providerPaymentId: `in_${checkout.id}`,
          amountCents: 1900,
          billingInterval: 'MONTHLY',
          periodStart: start,
          periodEnd: addBillingInterval(start, 'MONTHLY'),
        },
      });
      await expect(
        client.checkoutSession.update({
          where: { id: checkout.id },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            providerSessionId: 'cs_done',
            paymentId: pendingPayment.id,
          },
        }),
      ).rejects.toThrow(/SUCCEEDED payment of the same subscription/);
    });

    it('links every user to their own Stripe customer', async () => {
      const first = await createUser(client);
      const second = await createUser(client);
      await client.paymentCustomer.create({
        data: {
          authId: first,
          provider: 'stripe',
          providerCustomerId: 'cus_shared',
        },
      });
      await expect(
        client.paymentCustomer.create({
          data: {
            authId: first,
            provider: 'stripe',
            providerCustomerId: 'cus_second',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      await expect(
        client.paymentCustomer.create({
          data: {
            authId: second,
            provider: 'stripe',
            providerCustomerId: 'cus_shared',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });
});
