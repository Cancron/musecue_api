import { PrismaClient } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import request from 'supertest';
import { ActivityLogService } from '../src/common/services/activity-log.service';
import type { CustomLoggerService } from '../src/common/services/custom-logger.service';
import type { PrismaService } from '../src/common/services/prisma.service';
import { SubscriptionAccessService } from '../src/subscription/subscription-access.service';
import { SubscriptionPlanService } from '../src/subscription/subscription-plan.service';
import { FakeStripeApi } from './support/fake-stripe-api';
import { describeWithDatabase } from './support/migrated-schema';
import {
  createStripeTestApp,
  dataOf,
  type StripeTestApp,
} from './support/stripe-test-app';
import { createUser } from './support/subscription-fixtures';

jest.setTimeout(120_000);

const DAY = 24 * 60 * 60 * 1000;
/** Stripe timestamps have whole-second precision. */
const daysAgo = (days: number) =>
  new Date(Math.floor((Date.now() - days * DAY) / 1000) * 1000);

/**
 * Cancellation at period end, end to end: the authenticated HTTP route,
 * Stripe webhooks, the real services and the migrated PostgreSQL schema.
 */
describeWithDatabase(
  'Stripe subscription cancellation (PostgreSQL, HTTP)',
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

    const send = (event: { payload: string; signature: string }) =>
      harness.sendWebhook(event.payload, event.signature).expect(200);

    /** A user who bought Pro `startedDaysAgo` days ago. */
    async function subscriber(
      startedDaysAgo = 10,
      interval: 'MONTHLY' | 'YEARLY' = 'MONTHLY',
    ) {
      const authId = await createUser(client);
      const view = dataOf(
        await harness.startCheckout(authId, interval).expect(201),
      );
      const checkout = await client.checkoutSession.findUniqueOrThrow({
        where: { id: view.checkoutSessionId },
      });
      const sessionId = checkout.providerSessionId as string;
      const session = api.completeSession(sessionId, {
        periodStart: daysAgo(startedDaysAgo),
      });
      await send(api.signedEvent('checkout.session.completed', sessionId));
      return { authId, subscriptionId: session.subscription as string };
    }

    const cancel = (userId: string) =>
      request(harness.app.getHttpServer())
        .post('/v1/subscription/cancel')
        .set('Authorization', harness.bearer(userId))
        .set('User-Agent', 'cancel-e2e');

    const recordOf = (authId: string) =>
      client.userSubscription.findUniqueOrThrow({
        where: { authId },
        include: { events: { orderBy: { createdAt: 'asc' } } },
      });
    const eventTypes = async (authId: string) =>
      (await recordOf(authId)).events.map((event) => event.type);
    const stripeCanceledAt = (subscriptionId: string) =>
      new Date(
        Number(api.subscriptions.get(subscriptionId)?.canceled_at) * 1000,
      );
    const subscriptionUpdated = (subscriptionId: string) =>
      api.signedSubscriptionEvent(
        'customer.subscription.updated',
        subscriptionId,
      );

    describe('cancelling at the end of the period', () => {
      it('turns renewal off, records the cancellation and keeps Pro until the period ends', async () => {
        const { authId, subscriptionId } = await subscriber(10);
        const before = await client.userSubscription.findUniqueOrThrow({
          where: { authId },
        });
        const endsAt = before.proExpiresAt as Date;

        const response = await cancel(authId).expect(200);

        const canceledAt = stripeCanceledAt(subscriptionId);
        expect(dataOf(response)).toEqual({
          status: 'PRO',
          hasProAccess: true,
          autoRenew: false,
          canceledAt: canceledAt.toISOString(),
          endsAt: endsAt.toISOString(),
          accessExpiresAt: endsAt.toISOString(),
          alreadyCanceled: false,
        });
        expect(api.subscriptions.get(subscriptionId)).toMatchObject({
          status: 'active',
          cancel_at_period_end: true,
        });
        const record = await recordOf(authId);
        expect(record).toMatchObject({
          status: before.status,
          proStartedAt: before.proStartedAt,
          proExpiresAt: endsAt,
          proCanceledAt: canceledAt,
          billingInterval: before.billingInterval,
          providerSubscriptionId: subscriptionId,
        });
        expect(
          record.events.map((event) => [event.type, event.paymentId]),
        ).toEqual([
          ['CREATED', expect.any(String)],
          ['CANCELED', null],
        ]);
        expect(record.events[1].occurredAt).toEqual(canceledAt);
        await expect(
          client.activityLogEvent.findMany({
            where: { tableName: 'UserSubscription', recordId: record.id },
            include: { details: true },
            orderBy: { createdAt: 'asc' },
          }),
        ).resolves.toEqual([
          expect.anything(),
          expect.objectContaining({
            actionedBy: authId,
            userAgent: 'cancel-e2e',
            details: [
              expect.objectContaining({
                fieldName: 'proCanceledAt',
                oldValue: null,
                newValue: canceledAt.toISOString(),
              }),
            ],
          }),
        ]);

        // Pro features remain until the paid period ends, then stop.
        await expect(harness.status(authId)).resolves.toMatchObject({
          status: 'PRO',
          hasProAccess: true,
          accessExpiresAt: endsAt.toISOString(),
          pro: {
            active: true,
            canceledAt: canceledAt.toISOString(),
            expiresAt: endsAt.toISOString(),
          },
        });
        await expect(
          access.hasProAccess(authId, new Date(endsAt.getTime() - 1)),
        ).resolves.toBe(true);
        await expect(access.hasProAccess(authId, endsAt)).resolves.toBe(false);
      });

      it('keeps the period and adds no event when Stripe ends the subscription at period end', async () => {
        const { authId, subscriptionId } = await subscriber(10, 'YEARLY');
        await cancel(authId).expect(200);
        const afterCancel = await client.userSubscription.findUniqueOrThrow({
          where: { authId },
        });

        api.cancelSubscription(subscriptionId);
        const deleted = api.signedSubscriptionEvent(
          'customer.subscription.deleted',
          subscriptionId,
        );
        await Promise.all([
          send(deleted),
          send(deleted),
          send(subscriptionUpdated(subscriptionId)),
        ]);

        await expect(
          client.userSubscription.findUniqueOrThrow({ where: { authId } }),
        ).resolves.toEqual(afterCancel);
        await expect(eventTypes(authId)).resolves.toEqual([
          'CREATED',
          'CANCELED',
        ]);
      });

      it('cannot cancel a term that has already ended', async () => {
        const { authId, subscriptionId } = await subscriber(45);

        await cancel(authId).expect(409);

        expect(
          api.subscriptions.get(subscriptionId)?.cancel_at_period_end,
        ).toBe(false);
        await expect(eventTypes(authId)).resolves.toEqual(['CREATED']);
      });

      it('still blocks a new checkout while the canceled term runs', async () => {
        const { authId } = await subscriber(10);
        await cancel(authId).expect(200);
        const response = await harness.startCheckout(authId, 'YEARLY');
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({
          message: 'You already have an active Pro subscription',
        });
      });
    });

    describe('authorization', () => {
      it('requires a valid access token', async () => {
        await request(harness.app.getHttpServer())
          .post('/v1/subscription/cancel')
          .expect(401);
      });

      it('never cancels another user’s subscription', async () => {
        const alice = await subscriber(10);
        const bob = await subscriber(10);
        const mallory = await createUser(client);

        // Mallory has no subscription; naming Alice's changes nothing.
        await cancel(mallory)
          .send({ userId: alice.authId, subscriptionId: alice.subscriptionId })
          .expect(409);
        // Bob cancels his own, even when naming Alice's.
        await cancel(bob.authId)
          .send({ userId: alice.authId, subscriptionId: alice.subscriptionId })
          .expect(200);

        await expect(recordOf(alice.authId)).resolves.toMatchObject({
          proCanceledAt: null,
        });
        await expect(eventTypes(alice.authId)).resolves.toEqual(['CREATED']);
        expect(
          api.subscriptions.get(alice.subscriptionId)?.cancel_at_period_end,
        ).toBe(false);
        expect(
          api.subscriptions.get(bob.subscriptionId)?.cancel_at_period_end,
        ).toBe(true);
        await expect(eventTypes(bob.authId)).resolves.toEqual([
          'CREATED',
          'CANCELED',
        ]);
      });
    });

    describe('duplicates', () => {
      it('records one cancellation for concurrent requests and webhooks', async () => {
        const { authId, subscriptionId } = await subscriber(10);

        const responses = await Promise.all(
          Array.from({ length: 6 }, () => cancel(authId)),
        );
        const updated = subscriptionUpdated(subscriptionId);
        await Promise.all([send(updated), send(updated), send(updated)]);
        const again = await cancel(authId).expect(200);

        expect(responses.map((response) => response.status)).toEqual(
          Array(6).fill(200),
        );
        const views = responses.map(dataOf);
        expect(views.filter((view) => !view.alreadyCanceled)).toHaveLength(1);
        expect(new Set(views.map((view) => view.canceledAt)).size).toBe(1);
        expect(dataOf(again)).toMatchObject({
          alreadyCanceled: true,
          canceledAt: views[0].canceledAt,
        });
        await expect(eventTypes(authId)).resolves.toEqual([
          'CREATED',
          'CANCELED',
        ]);
        const record = await recordOf(authId);
        await expect(
          client.activityLogEvent.count({
            where: { tableName: 'UserSubscription', recordId: record.id },
          }),
        ).resolves.toBe(2);
      });

      it('refuses a second CANCELED event for the same cancellation at the database', async () => {
        const { authId } = await subscriber(10);
        await cancel(authId).expect(200);
        const record = await recordOf(authId);

        await expect(
          client.subscriptionEvent.create({
            data: {
              subscriptionId: record.id,
              type: 'CANCELED',
              occurredAt: record.proCanceledAt as Date,
            },
          }),
        ).rejects.toMatchObject({ code: 'P2002' });
      });
    });

    describe('failures', () => {
      it.each(['connection', 'server', 'invalid'] as const)(
        'does not cancel when the Stripe request fails (%s), and a retry succeeds',
        async (failure) => {
          const { authId, subscriptionId } = await subscriber(10);
          const before = await client.userSubscription.findUniqueOrThrow({
            where: { authId },
          });
          api.failNext('POST /v1/subscriptions/:id', failure);

          // Without Stripe's positive response nothing is saved.
          const unconfirmed = await cancel(authId).expect(503);
          expect(unconfirmed.body).toMatchObject({
            message:
              'Cancellation could not be confirmed; please retry or check subscription status',
          });

          await expect(
            client.userSubscription.findUniqueOrThrow({ where: { authId } }),
          ).resolves.toEqual(before);
          await expect(eventTypes(authId)).resolves.toEqual(['CREATED']);
          await expect(harness.status(authId)).resolves.toMatchObject({
            pro: { canceledAt: null },
          });
          expect(
            api.subscriptions.get(subscriptionId)?.cancel_at_period_end,
          ).toBe(false);

          await cancel(authId).expect(200);
          await expect(eventTypes(authId)).resolves.toEqual([
            'CREATED',
            'CANCELED',
          ]);
        },
      );

      it('records a cancellation Stripe made despite a lost response exactly once', async () => {
        const { authId, subscriptionId } = await subscriber(10);
        api.failNext('POST /v1/subscriptions/:id', 'lost');

        // Without Stripe's positive response nothing is saved.
        const unconfirmed = await cancel(authId).expect(503);
        expect(unconfirmed.body).toMatchObject({
          message:
            'Cancellation could not be confirmed; please retry or check subscription status',
        });
        await expect(recordOf(authId)).resolves.toMatchObject({
          proCanceledAt: null,
        });

        await send(subscriptionUpdated(subscriptionId));
        const retried = await cancel(authId).expect(200);

        expect(dataOf(retried)).toMatchObject({
          alreadyCanceled: true,
          canceledAt: stripeCanceledAt(subscriptionId).toISOString(),
        });
        await expect(eventTypes(authId)).resolves.toEqual([
          'CREATED',
          'CANCELED',
        ]);
      });
    });
  },
);
