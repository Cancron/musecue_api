import { PrismaClient } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import request from 'supertest';
import { ActivityLogService } from '../src/common/services/activity-log.service';
import type { CustomLoggerService } from '../src/common/services/custom-logger.service';
import type { PrismaService } from '../src/common/services/prisma.service';
import { SubscriptionAccessService } from '../src/subscription/subscription-access.service';
import { SubscriptionPlanService } from '../src/subscription/subscription-plan.service';
import { FAKE_WEBHOOK_SECRET, FakeStripeApi } from './support/fake-stripe-api';
import { describeWithDatabase } from './support/migrated-schema';
import {
  createStripeTestApp,
  dataOf,
  type StripeTestApp,
} from './support/stripe-test-app';
import { createUser } from './support/subscription-fixtures';

jest.setTimeout(240_000);

const DAY = 24 * 60 * 60 * 1000;
/** Stripe timestamps have whole-second precision. */
const daysAgo = (days: number) =>
  new Date(Math.floor((Date.now() - days * DAY) / 1000) * 1000);

type Signed = { payload: string; signature: string };

/**
 * Webhook security and reliability against PostgreSQL: signatures, foreign
 * events, database failures after Stripe confirmed a payment (real
 * transaction rollback via injected triggers), concurrent and out-of-order
 * deliveries. Pro status is checked with SubscriptionAccessService.
 */
describeWithDatabase(
  'Stripe webhook security and reliability (PostgreSQL, HTTP)',
  () => {
    let harness: StripeTestApp;
    let client: PrismaClient;
    let api: FakeStripeApi;
    let access: SubscriptionAccessService;

    beforeAll(async () => {
      harness = await createStripeTestApp();
      client = harness.client;
      const prisma = client as unknown as PrismaService;
      access = new SubscriptionAccessService(
        prisma,
        new SubscriptionPlanService(
          prisma,
          new ActivityLogService(prisma, mock<CustomLoggerService>()),
        ),
      );
    });

    afterAll(async () => {
      await harness?.close();
    });

    beforeEach(() => {
      api = new FakeStripeApi(5);
      harness.stripe.api = api;
    });

    const send = (event: Signed) =>
      harness.sendWebhook(event.payload, event.signature);
    const sign = (payload: string, secret = FAKE_WEBHOOK_SECRET) =>
      api.client().webhooks.generateTestHeaderString({ payload, secret });
    const eventIdOf = (event: Signed) =>
      (JSON.parse(event.payload) as { id: string }).id;

    /** A checkout whose payment Stripe collected (event not delivered yet). */
    async function paidCheckout(periodStart: Date) {
      const authId = await createUser(client);
      const view = dataOf(
        await harness.startCheckout(authId, 'MONTHLY').expect(201),
      );
      const row = await client.checkoutSession.findUniqueOrThrow({
        where: { id: view.checkoutSessionId },
      });
      const sessionId = row.providerSessionId as string;
      const session = api.completeSession(sessionId, { periodStart });
      return {
        authId,
        checkoutId: row.id,
        sessionId,
        subscriptionId: session.subscription as string,
        invoiceId: session.invoice as string,
        completed: api.signedEvent('checkout.session.completed', sessionId),
      };
    }

    /** Every table a webhook could write, in a stable order. */
    async function databaseSnapshot() {
      const byId = { orderBy: { id: 'asc' as const } };
      return JSON.stringify([
        await client.userSubscription.findMany(byId),
        await client.paymentTransaction.findMany(byId),
        await client.paymentRefund.findMany(byId),
        await client.subscriptionEvent.findMany(byId),
        await client.checkoutSession.findMany(byId),
        await client.paymentCustomer.findMany(byId),
        await client.paymentWebhookEvent.findMany(byId),
        await client.activityLogEvent.count(),
      ]);
    }

    /** Makes the next statements of `operation` on `table` fail until removed. */
    async function injectFailure(
      table: string,
      operation: 'INSERT' | 'UPDATE',
    ) {
      await client.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION zz_inject_failure() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'injected failure on "${table}" row %', NEW."id"; END $$`,
      );
      await client.$executeRawUnsafe(
        `CREATE TRIGGER zz_inject_failure BEFORE ${operation} ON "${table}"
       FOR EACH ROW EXECUTE FUNCTION zz_inject_failure()`,
      );
      return async () => {
        await client.$executeRawUnsafe(
          `DROP TRIGGER zz_inject_failure ON "${table}"`,
        );
        await client.$executeRawUnsafe(`DROP FUNCTION zz_inject_failure()`);
      };
    }

    describe('signature verification', () => {
      it('rejects unsigned, forged and tampered events before any database access', async () => {
        const { authId, completed } = await paidCheckout(daysAgo(5));
        const before = await databaseSnapshot();
        const tampered = completed.payload.replace('"paid"', '"paid!"');
        const attempts: [string, string | undefined][] = [
          [completed.payload, undefined],
          [completed.payload, 't=1,v1=deadbeef'],
          [completed.payload, sign(completed.payload, 'whsec_someone_else')],
          [tampered, completed.signature],
          [
            completed.payload,
            api.client().webhooks.generateTestHeaderString({
              payload: completed.payload,
              secret: FAKE_WEBHOOK_SECRET,
              timestamp: Math.floor(Date.now() / 1000) - 3600,
            }),
          ],
        ];
        expect(tampered).not.toBe(completed.payload);

        for (const [payload, signature] of attempts) {
          const call = request(harness.app.getHttpServer())
            .post('/v1/webhooks/stripe')
            .set('Content-Type', 'application/json');
          if (signature) call.set('Stripe-Signature', signature);
          const response = await call.send(payload).expect(400);
          expect(response.body).toMatchObject({
            message: 'Invalid webhook signature',
          });
        }

        await expect(databaseSnapshot()).resolves.toBe(before);
        await expect(access.hasProAccess(authId)).resolves.toBe(false);
      });

      it('ignores connected-account and live-mode events without changes', async () => {
        const { authId, completed } = await paidCheckout(daysAgo(5));
        for (const extra of [{ account: 'acct_other' }, { livemode: true }]) {
          const payload = JSON.stringify({
            ...(JSON.parse(completed.payload) as object),
            ...extra,
          });
          await send({ payload, signature: sign(payload) }).expect(200);
        }
        await expect(access.hasProAccess(authId)).resolves.toBe(false);
        await expect(
          client.paymentTransaction.count({
            where: { subscription: { authId } },
          }),
        ).resolves.toBe(0);
      });
    });

    describe('Stripe confirmed the payment but the database update failed', () => {
      it('rolls back the activation completely and applies it once on redelivery', async () => {
        const { authId, checkoutId, completed } = await paidCheckout(
          daysAgo(5),
        );
        // The payment insert succeeds inside the transaction; granting the
        // term then fails, so the whole transaction must roll back.
        const restore = await injectFailure('UserSubscription', 'UPDATE');
        let failed: request.Response;
        try {
          failed = await send(completed).expect(500);
        } finally {
          await restore();
        }

        expect(failed.body).toMatchObject({
          statusCode: 500,
          message: 'Webhook processing failed',
        });
        expect(JSON.stringify(failed.body)).not.toMatch(
          /injected|UserSubscription|row /,
        );
        await expect(
          client.paymentTransaction.count({
            where: { subscription: { authId } },
          }),
        ).resolves.toBe(0);
        await expect(
          client.checkoutSession.findUniqueOrThrow({
            where: { id: checkoutId },
          }),
        ).resolves.toMatchObject({ status: 'OPEN' });
        await expect(access.hasProAccess(authId)).resolves.toBe(false);
        await expect(
          client.paymentWebhookEvent.findFirstOrThrow({
            where: { providerEventId: eventIdOf(completed) },
          }),
        ).resolves.toMatchObject({
          status: 'FAILED',
          attempts: 1,
          lastErrorCode: expect.any(String) as string,
          processedAt: null,
        });

        // Stripe redelivers (twice, concurrently).
        const retries = await Promise.all([send(completed), send(completed)]);
        expect(retries.map((response) => response.status)).toEqual([200, 200]);

        const record = await client.userSubscription.findUniqueOrThrow({
          where: { authId },
          include: { payments: true, events: true },
        });
        expect(record.payments).toHaveLength(1);
        expect(record.events.map((event) => event.type)).toEqual(['CREATED']);
        await expect(access.hasProAccess(authId)).resolves.toBe(true);
        await expect(
          client.paymentWebhookEvent.findFirstOrThrow({
            where: { providerEventId: eventIdOf(completed) },
          }),
        ).resolves.toMatchObject({
          status: 'PROCESSED',
          attempts: 3,
          lastErrorCode: null,
        });
      });

      it('keeps a renewal and a refund unapplied until they can be applied whole', async () => {
        const user = await paidCheckout(daysAgo(40));
        await send(user.completed).expect(200);
        const renewal = api.renewSubscription(user.subscriptionId).id as string;
        const renewalEvent = api.signedInvoiceEvent('invoice.paid', renewal);

        let restore = await injectFailure('SubscriptionEvent', 'INSERT');
        try {
          await send(renewalEvent).expect(500);
        } finally {
          await restore();
        }
        const afterFailedRenewal =
          await client.userSubscription.findUniqueOrThrow({
            where: { authId: user.authId },
            include: { payments: true },
          });
        expect(afterFailedRenewal.payments).toHaveLength(1);
        await expect(access.hasProAccess(user.authId)).resolves.toBe(false);

        await send(renewalEvent).expect(200);
        await expect(access.hasProAccess(user.authId)).resolves.toBe(true);

        // A refund of the renewal that fails half way records nothing.
        api.refundInvoice(renewal);
        const refundEvent = api.signedChargeEvent(
          'charge.refunded',
          api.chargeOf(renewal),
        );
        restore = await injectFailure('UserSubscription', 'UPDATE');
        try {
          await send(refundEvent).expect(500);
        } finally {
          await restore();
        }
        await expect(
          client.paymentRefund.count({
            where: { payment: { subscription: { authId: user.authId } } },
          }),
        ).resolves.toBe(0);
        await expect(access.hasProAccess(user.authId)).resolves.toBe(true);

        await send(refundEvent).expect(200);
        await send(refundEvent).expect(200);
        await expect(
          client.paymentRefund.count({
            where: { payment: { subscription: { authId: user.authId } } },
          }),
        ).resolves.toBe(1);
        await expect(access.hasProAccess(user.authId)).resolves.toBe(false);
      });
    });

    describe('duplicated, delayed and out-of-order events', () => {
      it('applies one event delivered many times at once exactly once', async () => {
        const user = await paidCheckout(daysAgo(40));
        await send(user.completed).expect(200);
        const renewal = api.renewSubscription(user.subscriptionId).id as string;
        const event = api.signedInvoiceEvent('invoice.paid', renewal);

        const responses = await Promise.all(
          Array.from({ length: 10 }, () => send(event)),
        );

        expect(responses.map((response) => response.status)).toEqual(
          Array(10).fill(200),
        );
        const record = await client.userSubscription.findUniqueOrThrow({
          where: { authId: user.authId },
          include: { payments: true, events: true },
        });
        expect(record.payments).toHaveLength(2);
        expect(record.events.filter((e) => e.type === 'RENEWED')).toHaveLength(
          1,
        );
        await expect(
          client.paymentWebhookEvent.findFirstOrThrow({
            where: { providerEventId: eventIdOf(event) },
          }),
        ).resolves.toMatchObject({ attempts: 10, status: 'PROCESSED' });
      });

      it('never gives access back when old events are replayed after a refund', async () => {
        const user = await paidCheckout(daysAgo(5));
        const history: Signed[] = [user.completed];
        await send(user.completed).expect(200);
        history.push(api.signedInvoiceEvent('invoice.paid', user.invoiceId));
        await send(history[1]).expect(200);
        api.refundInvoice(user.invoiceId);
        await send(
          api.signedChargeEvent(
            'charge.refunded',
            api.chargeOf(user.invoiceId),
          ),
        ).expect(200);
        await expect(access.hasProAccess(user.authId)).resolves.toBe(false);
        const settled = await databaseSnapshot();

        await Promise.all([...history, ...history].map((event) => send(event)));

        await expect(access.hasProAccess(user.authId)).resolves.toBe(false);
        const after = JSON.parse(await databaseSnapshot()) as unknown[];
        const expected = JSON.parse(settled) as unknown[];
        // Only the event log's delivery counters move.
        expect(after.slice(0, 6)).toEqual(expected.slice(0, 6));
        expect(after[7]).toEqual(expected[7]);
      });

      it('reaches the same state when a whole lifecycle arrives reversed, duplicated and concurrently', async () => {
        const periodStart = daysAgo(70);

        /** Runs the lifecycle in Stripe and returns its events in order. */
        async function lifecycle(deliverAsItHappens: boolean) {
          const user = await paidCheckout(periodStart);
          const events: Signed[] = [];
          const happen = async (event: Signed) => {
            events.push(event);
            if (deliverAsItHappens) await send(event).expect(200);
          };
          await happen(user.completed);
          const p1 = api.renewSubscription(user.subscriptionId).id as string;
          await happen(api.signedInvoiceEvent('invoice.paid', p1));
          const p2 = api.renewSubscription(user.subscriptionId, {
            paid: false,
          }).id as string;
          await happen(api.signedInvoiceEvent('invoice.payment_failed', p2));
          api.payInvoice(p2);
          await happen(api.signedInvoiceEvent('invoice.paid', p2));
          api.refundInvoice(user.invoiceId, { amount: 400 });
          await happen(
            api.signedChargeEvent(
              'charge.refunded',
              api.chargeOf(user.invoiceId),
            ),
          );
          await api.client().subscriptions.update(user.subscriptionId, {
            cancel_at_period_end: true,
          });
          await happen(
            api.signedSubscriptionEvent(
              'customer.subscription.updated',
              user.subscriptionId,
            ),
          );
          return { ...user, events };
        }

        /** Delivers like Stripe's retries: until every event is accepted. */
        async function deliverReversedWithRetries(events: Signed[]) {
          let pending = [...events].reverse();
          for (let round = 0; round < 5 && pending.length > 0; round++) {
            const responses = await Promise.all(
              [...pending, ...pending].map(async (event) => ({
                event,
                status: (await send(event)).status,
              })),
            );
            for (const { status } of responses)
              expect([200, 503]).toContain(status);
            const accepted = new Set(
              responses.filter((r) => r.status === 200).map((r) => r.event),
            );
            pending = pending.filter((event) => !accepted.has(event));
          }
          expect(pending).toEqual([]);
        }

        /** The state that must not depend on delivery order. */
        async function stateOf(authId: string) {
          const record = await client.userSubscription.findUniqueOrThrow({
            where: { authId },
            include: {
              payments: { include: { refunds: true } },
              events: true,
            },
          });
          const billing = dataOf(
            await request(harness.app.getHttpServer())
              .get('/v1/subscription/billing')
              .set('Authorization', harness.bearer(authId))
              .expect(200),
          ) as Record<string, unknown>;
          return {
            status: record.status,
            billingInterval: record.billingInterval,
            proExpiresAt: record.proExpiresAt?.toISOString(),
            canceled: record.proCanceledAt !== null,
            pastDueSince: record.pastDueSince,
            payments: record.payments
              .map((p) => [
                p.status,
                p.amountCents,
                p.periodStart.toISOString(),
                p.periodEnd.toISOString(),
                p.refundedAmountCents,
                p.refunds.map((r) => [r.status, r.amountCents]),
              ])
              .sort((a, b) =>
                JSON.stringify(a).localeCompare(JSON.stringify(b)),
              ),
            events: record.events.map((e) => e.type).sort(),
            hasProAccess: await access.hasProAccess(authId),
            billing: {
              subscriptionState: billing.subscriptionState,
              currentPeriod: billing.currentPeriod,
              autoRenew: billing.autoRenew,
              nextRenewalAt: billing.nextRenewalAt,
            },
          };
        }

        const inOrder = await lifecycle(true);
        const reversed = await lifecycle(false);
        await deliverReversedWithRetries(reversed.events);

        const expected = await stateOf(inOrder.authId);
        expect(expected).toMatchObject({
          status: 'PRO',
          canceled: true,
          pastDueSince: null,
          hasProAccess: true,
          events: [
            'CANCELED',
            'CREATED',
            'PAYMENT_FAILED',
            'PAYMENT_REFUNDED',
            'RENEWED',
            'RENEWED',
          ],
          billing: { subscriptionState: 'CANCELED', autoRenew: false },
        });
        await expect(stateOf(reversed.authId)).resolves.toEqual(expected);
      });
    });
  },
);
