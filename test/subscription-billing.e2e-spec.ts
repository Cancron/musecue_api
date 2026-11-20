import request from 'supertest';
import { FakeStripeApi } from './support/fake-stripe-api';
import { describeWithDatabase } from './support/migrated-schema';
import {
  createStripeTestApp,
  dataOf,
  type StripeTestApp,
} from './support/stripe-test-app';
import { createUser } from './support/subscription-fixtures';

jest.setTimeout(180_000);

const DAY = 24 * 60 * 60 * 1000;
/** Stripe timestamps have whole-second precision. */
const daysAgo = (days: number) =>
  new Date(Math.floor((Date.now() - days * DAY) / 1000) * 1000);
/** Provider identifiers, credentials and raw failure messages. */
const SENSITIVE =
  /\b(cus|sub|in|ch|re|pi|evt|cs|sk|rk|pk|whsec|price|prod|pm)_|Your card/;

type Json = Record<string, unknown>;

/**
 * Billing information and payment history over HTTP, read back from the
 * migrated PostgreSQL schema after real checkout, renewal, failure,
 * cancellation and refund webhooks.
 */
describeWithDatabase(
  'Billing information and payment history (PostgreSQL, HTTP)',
  () => {
    let harness: StripeTestApp;
    let api: FakeStripeApi;

    beforeAll(async () => {
      harness = await createStripeTestApp();
    });

    afterAll(async () => {
      await harness?.close();
    });

    beforeEach(() => {
      api = new FakeStripeApi(5);
      harness.stripe.api = api;
    });

    const send = (event: { payload: string; signature: string }) =>
      harness.sendWebhook(event.payload, event.signature).expect(200);
    const get = (path: string, userId: string | null) => {
      const call = request(harness.app.getHttpServer()).get(path);
      if (userId) call.set('Authorization', harness.bearer(userId));
      return call;
    };
    const billingOf = async (userId: string) =>
      dataOf(await get('/v1/subscription/billing', userId).expect(200)) as Json;
    const historyOf = async (userId: string, query = '?limit=100') =>
      dataOf(
        await get(`/v1/subscription/payments${query}`, userId).expect(200),
      ) as unknown as { items: Json[]; meta: Json };

    /** A user whose first payment (starting `startedDaysAgo` days ago) is recorded. */
    async function subscriber(
      startedDaysAgo = 10,
      interval: 'MONTHLY' | 'YEARLY' = 'MONTHLY',
    ) {
      const authId = await createUser(harness.client);
      const view = dataOf(
        await harness.startCheckout(authId, interval).expect(201),
      );
      const checkout = await harness.client.checkoutSession.findUniqueOrThrow({
        where: { id: view.checkoutSessionId },
      });
      const sessionId = checkout.providerSessionId as string;
      const session = api.completeSession(sessionId, {
        periodStart: daysAgo(startedDaysAgo),
      });
      await send(api.signedEvent('checkout.session.completed', sessionId));
      return {
        authId,
        subscriptionId: session.subscription as string,
        invoiceId: session.invoice as string,
      };
    }
    const storedOf = (authId: string) =>
      harness.client.userSubscription.findUniqueOrThrow({
        where: { authId },
        include: { payments: { include: { refunds: true } } },
      });

    describe('billing information', () => {
      it('matches the stored subscription of an active monthly subscriber', async () => {
        const { authId } = await subscriber(10);
        const stored = await storedOf(authId);
        const payment = stored.payments[0];

        await expect(billingOf(authId)).resolves.toEqual({
          status: 'PRO',
          hasProAccess: true,
          accessExpiresAt: stored.proExpiresAt?.toISOString(),
          subscriptionState: 'ACTIVE',
          plan: {
            code: 'PRO',
            billingInterval: 'MONTHLY',
            priceCents: payment.amountCents,
            currency: 'USD',
          },
          currentPeriod: {
            start: payment.periodStart.toISOString(),
            end: payment.periodEnd.toISOString(),
          },
          autoRenew: true,
          nextRenewalAt: stored.proExpiresAt?.toISOString(),
          canceledAt: null,
          pastDueSince: null,
        });
      });

      it('shows a cancellation at period end', async () => {
        const { authId } = await subscriber(10, 'YEARLY');
        const canceled = dataOf(
          await request(harness.app.getHttpServer())
            .post('/v1/subscription/cancel')
            .set(await harness.stepUp(authId, 'SUBSCRIPTION_CANCEL'))
            .expect(200),
        );
        const stored = await storedOf(authId);

        await expect(billingOf(authId)).resolves.toMatchObject({
          status: 'PRO',
          hasProAccess: true,
          subscriptionState: 'CANCELED',
          plan: { billingInterval: 'YEARLY', priceCents: 19000 },
          autoRenew: false,
          nextRenewalAt: null,
          canceledAt: stored.proCanceledAt?.toISOString(),
          accessExpiresAt: canceled.endsAt,
        });
        expect(canceled.canceledAt).toBe(stored.proCanceledAt?.toISOString());
      });

      it('shows a refunded subscription as ended at once', async () => {
        const { authId, invoiceId } = await subscriber(10);
        api.refundInvoice(invoiceId);
        await send(
          api.signedChargeEvent('charge.refunded', api.chargeOf(invoiceId)),
        );

        await expect(billingOf(authId)).resolves.toMatchObject({
          status: 'EXPIRED',
          hasProAccess: false,
          subscriptionState: 'ENDED',
          currentPeriod: null,
          nextRenewalAt: null,
        });
      });

      it('shows a failed renewal as past due', async () => {
        const { authId, subscriptionId } = await subscriber(45);
        const invoice = api.renewSubscription(subscriptionId, { paid: false });
        await send(
          api.signedInvoiceEvent(
            'invoice.payment_failed',
            invoice.id as string,
          ),
        );
        const stored = await storedOf(authId);

        await expect(billingOf(authId)).resolves.toMatchObject({
          subscriptionState: 'PAST_DUE',
          status: 'EXPIRED',
          pastDueSince: stored.pastDueSince?.toISOString(),
          autoRenew: false,
        });
      });

      it('describes a user without a subscription', async () => {
        const authId = await createUser(harness.client);
        await expect(billingOf(authId)).resolves.toMatchObject({
          status: 'FREE',
          subscriptionState: 'NONE',
          plan: null,
        });
        await expect(historyOf(authId)).resolves.toMatchObject({
          items: [],
          meta: { total: 0 },
        });
      });
    });

    describe('payment history', () => {
      it('lists payments, failed attempts, renewals and refunds exactly as stored', async () => {
        const { authId, subscriptionId, invoiceId } = await subscriber(45);
        const failedInvoice = api.renewSubscription(subscriptionId, {
          paid: false,
        }).id as string;
        await send(
          api.signedInvoiceEvent('invoice.payment_failed', failedInvoice),
        );
        api.payInvoice(failedInvoice);
        await send(api.signedInvoiceEvent('invoice.paid', failedInvoice));
        api.refundInvoice(invoiceId, { amount: 700, reason: 'duplicate' });
        await send(
          api.signedChargeEvent('charge.refunded', api.chargeOf(invoiceId)),
        );

        const { items, meta } = await historyOf(authId);
        const stored = await storedOf(authId);
        const refunds = stored.payments.flatMap((payment) => payment.refunds);

        expect(meta).toMatchObject({
          total: stored.payments.length + refunds.length,
        });
        expect(items).toHaveLength(4);
        for (const payment of stored.payments) {
          expect(items).toContainEqual(
            expect.objectContaining({
              id: payment.id,
              type: 'PAYMENT',
              status: payment.status,
              amountCents: payment.amountCents,
              currency: payment.currency,
              date: (payment.paidAt ?? payment.failedAt)?.toISOString(),
              refundedAmountCents: payment.refundedAmountCents,
              period: {
                start: payment.periodStart.toISOString(),
                end: payment.periodEnd.toISOString(),
              },
            }),
          );
        }
        expect(items).toContainEqual(
          expect.objectContaining({
            id: refunds[0].id,
            type: 'REFUND',
            status: 'SUCCEEDED',
            amountCents: 700,
            currency: 'USD',
            date: refunds[0].providerCreatedAt.toISOString(),
            paymentId: refunds[0].paymentId,
          }),
        );
        expect(
          items.map((entry) => [entry.type, entry.purpose, entry.status]),
        ).toEqual(
          expect.arrayContaining([
            ['PAYMENT', 'NEW_SUBSCRIPTION', 'PARTIALLY_REFUNDED'],
            ['PAYMENT', 'RENEWAL', 'FAILED'],
            ['PAYMENT', 'RENEWAL', 'SUCCEEDED'],
            ['REFUND', 'NEW_SUBSCRIPTION', 'SUCCEEDED'],
          ]),
        );
        expect(
          items.find((entry) => entry.status === 'FAILED')?.failureReason,
        ).toBe('insufficient_funds');
        const dates = items.map((entry) => entry.date as string);
        expect([...dates].sort().reverse()).toEqual(dates);
      });

      it('pages the history', async () => {
        const { authId, subscriptionId } = await subscriber(100);
        for (let i = 0; i < 2; i++) {
          const renewal = api.renewSubscription(subscriptionId).id as string;
          await send(api.signedInvoiceEvent('invoice.paid', renewal));
        }
        const all = (await historyOf(authId)).items;
        const first = await historyOf(authId, '?page=1&limit=2');
        const second = await historyOf(authId, '?page=2&limit=2');

        expect([...first.items, ...second.items]).toEqual(all);
        expect(first.meta).toEqual({
          page: 1,
          limit: 2,
          total: 3,
          totalPages: 2,
          hasPreviousPage: false,
          hasNextPage: true,
        });
      });
    });

    describe('authorization', () => {
      it('denies unauthenticated and forged requests', async () => {
        for (const path of [
          '/v1/subscription/billing',
          '/v1/subscription/payments',
        ]) {
          await get(path, null).expect(401);
          await request(harness.app.getHttpServer())
            .get(path)
            .set('Authorization', 'Bearer not-a-token')
            .expect(401);
        }
      });

      it('never shows one user the payments of another', async () => {
        const alice = await subscriber(10);
        api.refundInvoice(alice.invoiceId, { amount: 100 });
        await send(
          api.signedChargeEvent(
            'charge.refunded',
            api.chargeOf(alice.invoiceId),
          ),
        );
        const bob = await subscriber(10, 'YEARLY');
        const aliceIds = new Set(
          (await historyOf(alice.authId)).items.map((entry) => entry.id),
        );

        const bobHistory = await historyOf(bob.authId);
        expect(bobHistory.items).toHaveLength(1);
        expect(
          bobHistory.items.some((entry) => aliceIds.has(entry.id as string)),
        ).toBe(false);
        await expect(billingOf(bob.authId)).resolves.toMatchObject({
          plan: { billingInterval: 'YEARLY' },
        });
        // Naming Alice is rejected, not honoured.
        await get(
          `/v1/subscription/payments?userId=${alice.authId}`,
          bob.authId,
        ).expect(400);
        const viaBody = await get('/v1/subscription/billing', bob.authId)
          .send({ userId: alice.authId })
          .expect(200);
        expect(dataOf(viaBody)).toMatchObject({
          plan: { billingInterval: 'YEARLY' },
        });
      });

      it('exposes no provider identifiers, credentials or failure messages', async () => {
        const { authId, subscriptionId, invoiceId } = await subscriber(45);
        const invoice = api.renewSubscription(subscriptionId, { paid: false });
        await send(
          api.signedInvoiceEvent(
            'invoice.payment_failed',
            invoice.id as string,
          ),
        );
        api.refundInvoice(invoiceId, { amount: 100 });
        await send(
          api.signedChargeEvent('charge.refunded', api.chargeOf(invoiceId)),
        );

        const responses = await Promise.all([
          get('/v1/subscription/billing', authId).expect(200),
          get('/v1/subscription/payments', authId).expect(200),
        ]);
        for (const response of responses) {
          expect(JSON.stringify(response.body)).not.toMatch(SENSITIVE);
        }
      });
    });

    describe('after an application restart', () => {
      it('returns exactly the same billing information and history, without asking Stripe', async () => {
        const active = await subscriber(10);
        const renewed = await subscriber(40);
        const renewal = api.renewSubscription(renewed.subscriptionId)
          .id as string;
        await send(api.signedInvoiceEvent('invoice.paid', renewal));
        const canceled = await subscriber(10, 'YEARLY');
        await request(harness.app.getHttpServer())
          .post('/v1/subscription/cancel')
          .set(await harness.stepUp(canceled.authId, 'SUBSCRIPTION_CANCEL'))
          .expect(200);
        const refunded = await subscriber(10);
        api.refundInvoice(refunded.invoiceId, { amount: 900 });
        await send(
          api.signedChargeEvent(
            'charge.refunded',
            api.chargeOf(refunded.invoiceId),
          ),
        );
        const pastDue = await subscriber(45);
        const failed = api.renewSubscription(pastDue.subscriptionId, {
          paid: false,
        });
        await send(
          api.signedInvoiceEvent('invoice.payment_failed', failed.id as string),
        );
        const users = [active, renewed, canceled, refunded, pastDue].map(
          (user) => user.authId,
        );
        const snapshot = async () =>
          Promise.all(
            users.map(async (authId) => ({
              billing: await billingOf(authId),
              history: await historyOf(authId),
              firstPage: await historyOf(authId, '?page=1&limit=1'),
            })),
          );

        const before = await snapshot();
        // A new app with new database connections and an empty Stripe fake:
        // reads must come from PostgreSQL only.
        await harness.restart();
        api = new FakeStripeApi();
        harness.stripe.api = api;
        const after = await snapshot();

        expect(after).toEqual(before);
        expect(api.requests).toHaveLength(0);
        expect(before.map((user) => user.billing.subscriptionState)).toEqual([
          'ACTIVE',
          'ACTIVE',
          'CANCELED',
          'ENDED',
          'PAST_DUE',
        ]);
      });
    });
  },
);
