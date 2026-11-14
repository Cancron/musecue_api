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
import { ActivityLogService } from '../../common/services/activity-log.service';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import type { PrismaService } from '../../common/services/prisma.service';
import { resolveSubscriptionAccess } from '../subscription-access.policy';
import { SubscriptionPlanService } from '../subscription-plan.service';
import { StripeCancellationService } from './stripe-cancellation.service';
import { StripeCheckoutService } from './stripe-checkout.service';
import { StripeRefundService } from './stripe-refund.service';
import { StripeWebhookService } from './stripe-webhook.service';
import type { StripeSettings } from './stripe.config';
import { StripeGateway } from './stripe.gateway';

const { MONTHLY, YEARLY } = BillingInterval;
const DAY = 24 * 60 * 60 * 1000;
/** Stripe timestamps have whole-second precision. */
const daysAgo = (days: number) =>
  new Date(Math.floor((Date.now() - days * DAY) / 1000) * 1000);

describe('StripeCancellationService', () => {
  const settings: StripeSettings = {
    secretKey: 'sk_test_fake',
    webhookSecret: FAKE_WEBHOOK_SECRET,
    successUrl: 'https://app.example/ok',
    cancelUrl: 'https://app.example/cancel',
    productId: null,
    checkoutExpiresMinutes: 60,
  };
  const plans = mock<SubscriptionPlanService>();
  const activityLog = mock<ActivityLogService>();
  const logger = mock<CustomLoggerService>();
  const meta = { ip: '198.51.100.7', userAgent: 'cancel-spec' };
  let api: FakeStripeApi;
  let db: InMemoryBillingPrisma;
  let gateway: StripeGateway;
  let checkout: StripeCheckoutService;
  let webhooks: StripeWebhookService;
  let service: StripeCancellationService;

  const build = (client: Stripe | null = api.client()) => {
    const prisma = db as unknown as PrismaService;
    gateway = new StripeGateway(settings, client);
    service = new StripeCancellationService(
      prisma,
      gateway,
      activityLog,
      logger,
    );
    checkout = new StripeCheckoutService(prisma, plans, gateway, logger);
    webhooks = new StripeWebhookService(
      prisma,
      gateway,
      activityLog,
      logger,
      service,
      new StripeRefundService(prisma, gateway, activityLog, logger),
    );
  };

  beforeEach(() => {
    jest.resetAllMocks();
    plans.getProPlan.mockResolvedValue({
      code: 'PRO',
      currency: 'USD',
      planEnabled: true,
      monthlyPriceUsdCents: 1900,
      yearlyPriceUsdCents: 19000,
      trialEnabled: true,
      trialDays: 7,
      updatedAt: null,
    });
    api = new FakeStripeApi();
    db = createInMemoryBillingPrisma();
    build();
  });

  /** A user who bought Pro; the paid period started `startedDaysAgo` days ago. */
  async function subscriber(
    startedDaysAgo = 10,
    interval: BillingInterval = MONTHLY,
  ) {
    const user = await db.authUser.create({ data: {} });
    const authId = user.id as string;
    const view = await checkout.createCheckout(authId, interval);
    const row = db.checkoutSession.rows.find(
      (candidate) => candidate.id === view.checkoutSessionId,
    );
    const sessionId = row?.providerSessionId as string;
    const session = api.completeSession(sessionId, {
      periodStart: daysAgo(startedDaysAgo),
    });
    const event = api.signedEvent('checkout.session.completed', sessionId);
    await webhooks.handleEvent(
      webhooks.verifyEvent(Buffer.from(event.payload), event.signature),
      meta,
    );
    return { authId, subscriptionId: session.subscription as string };
  }

  const recordOf = (authId: string) =>
    db.userSubscription.rows.find((row) => row.authId === authId);
  const eventsOf = (authId: string) =>
    db.subscriptionEvent.rows
      .filter((row) => row.subscriptionId === recordOf(authId)?.id)
      .map((row) => row.type);
  const stripeSubscription = (subscriptionId: string) =>
    api.subscriptions.get(subscriptionId) as Record<string, unknown>;
  const hasAccess = (authId: string, at: Date) =>
    resolveSubscriptionAccess(
      recordOf(authId) as unknown as Parameters<
        typeof resolveSubscriptionAccess
      >[0],
      at,
    ).hasProAccess;
  const cancelRequests = () => api.count('POST', /^\/v1\/subscriptions\//);

  /** Delivers `customer.subscription.updated` carrying the subscription now. */
  const subscriptionUpdated = (
    subscriptionId: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const { payload, signature } = api.signedSubscriptionEvent(
      'customer.subscription.updated',
      subscriptionId,
      overrides,
    );
    return () =>
      webhooks.handleEvent(
        webhooks.verifyEvent(Buffer.from(payload), signature),
        meta,
      );
  };

  describe('cancelling at the end of the period', () => {
    it('turns auto-renewal off at Stripe and records the cancellation', async () => {
      const { authId, subscriptionId } = await subscriber();
      const before = { ...recordOf(authId) };

      const view = await service.cancelAtPeriodEnd(authId, meta);

      const stripeState = stripeSubscription(subscriptionId);
      const canceledAt = new Date(Number(stripeState.canceled_at) * 1000);
      const endsAt = before.proExpiresAt as Date;
      expect(view).toEqual({
        status: 'PRO',
        hasProAccess: true,
        autoRenew: false,
        canceledAt: canceledAt.toISOString(),
        endsAt: endsAt.toISOString(),
        accessExpiresAt: endsAt.toISOString(),
        alreadyCanceled: false,
      });
      // Stripe: still active, ends at the current period end.
      expect(stripeState).toMatchObject({
        status: 'active',
        cancel_at_period_end: true,
      });
      expect(api.requests.at(-1)).toMatchObject({
        method: 'POST',
        path: `/v1/subscriptions/${subscriptionId}`,
        params: { cancel_at_period_end: 'true' },
        idempotencyKey: `musecue-cancel-${subscriptionId}-${endsAt.getTime()}`,
      });
      // Only proCanceledAt changes: the paid term and its expiry do not.
      expect(recordOf(authId)).toEqual({
        ...before,
        proCanceledAt: canceledAt,
        updatedAt: expect.any(Date) as Date,
      });
      expect(eventsOf(authId)).toEqual(['CREATED', 'CANCELED']);
      const event = db.subscriptionEvent.rows.at(-1);
      expect(event).toMatchObject({ type: 'CANCELED', occurredAt: canceledAt });
      // A cancellation is not a payment.
      expect(event?.paymentId ?? null).toBeNull();
      expect(activityLog.logActivity.mock.calls.at(-1)?.[0]).toEqual({
        tableName: 'UserSubscription',
        recordId: recordOf(authId)?.id,
        action: 'update',
        changes: [
          {
            fieldName: 'proCanceledAt',
            oldValue: null,
            newValue: canceledAt.toISOString(),
          },
        ],
        metadata: { ...meta, actionedBy: authId },
      });
    });

    it('keeps Pro until the paid period ends, and not a moment longer', async () => {
      const { authId } = await subscriber(20, YEARLY);
      const view = await service.cancelAtPeriodEnd(authId, meta);
      const endsAt = new Date(view.endsAt);

      expect(hasAccess(authId, new Date())).toBe(true);
      expect(hasAccess(authId, new Date(endsAt.getTime() - 1))).toBe(true);
      expect(hasAccess(authId, endsAt)).toBe(false);
    });

    it('allows cancelling until the last instant of the period', async () => {
      const { authId } = await subscriber();
      const endsAt = recordOf(authId)?.proExpiresAt as Date;

      await expect(
        service.cancelAtPeriodEnd(authId, meta, endsAt),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        service.cancelAtPeriodEnd(authId, meta, new Date(endsAt.getTime() - 1)),
      ).resolves.toMatchObject({ autoRenew: false, alreadyCanceled: false });
    });
  });

  describe('repeated and concurrent cancellations', () => {
    it('returns the same cancellation for a repeated request without calling Stripe', async () => {
      const { authId } = await subscriber();
      const first = await service.cancelAtPeriodEnd(authId, meta);
      const requests = api.requests.length;

      const again = await service.cancelAtPeriodEnd(authId, meta);

      expect(again).toEqual({ ...first, alreadyCanceled: true });
      expect(api.requests).toHaveLength(requests);
      expect(eventsOf(authId)).toEqual(['CREATED', 'CANCELED']);
    });

    it('records one cancellation for concurrent requests', async () => {
      const { authId } = await subscriber();

      const views = await Promise.all(
        Array.from({ length: 6 }, () =>
          service.cancelAtPeriodEnd(authId, meta),
        ),
      );

      expect(views.filter((view) => !view.alreadyCanceled)).toHaveLength(1);
      expect(new Set(views.map((view) => view.canceledAt)).size).toBe(1);
      expect(new Set(views.map((view) => view.endsAt)).size).toBe(1);
      expect(eventsOf(authId)).toEqual(['CREATED', 'CANCELED']);
      expect(
        activityLog.logActivity.mock.calls.filter(
          ([params]) => params.changes?.[0]?.fieldName === 'proCanceledAt',
        ),
      ).toHaveLength(1);
    });

    it('records one cancellation when the user request races the Stripe webhook', async () => {
      const { authId, subscriptionId } = await subscriber();
      // Stripe already turned renewal off (e.g. another request); both the
      // webhook and a user request now try to record it.
      await api
        .client()
        .subscriptions.update(subscriptionId, { cancel_at_period_end: true });
      const deliver = subscriptionUpdated(subscriptionId);

      const [view, outcome, outcome2] = await Promise.all([
        service.cancelAtPeriodEnd(authId, meta),
        deliver(),
        deliver(),
      ]);

      // Exactly one of the three recorded it; the others found it recorded.
      const recorders =
        (view.alreadyCanceled ? 0 : 1) +
        [outcome, outcome2].filter((o) => o === 'CANCELED').length;
      expect(recorders).toBe(1);
      expect(
        [outcome, outcome2].every((o) =>
          ['CANCELED', 'ALREADY_PROCESSED'].includes(o),
        ),
      ).toBe(true);
      expect(eventsOf(authId)).toEqual(['CREATED', 'CANCELED']);
      expect(recordOf(authId)?.proCanceledAt).toEqual(
        new Date(Number(stripeSubscription(subscriptionId).canceled_at) * 1000),
      );
    });
  });

  describe('when Stripe cannot cancel', () => {
    it.each([
      ['Stripe is unreachable', 'connection'],
      ['Stripe fails with a server error', 'server'],
      ['Stripe rejects the request', 'invalid'],
    ] as const)(
      'saves nothing and reports an unconfirmed cancellation when %s',
      async (_label, failure) => {
        const { authId, subscriptionId } = await subscriber();
        const before = { ...recordOf(authId) };
        api.failNext('POST /v1/subscriptions/:id', failure);

        await expect(
          service.cancelAtPeriodEnd(authId, meta),
        ).rejects.toMatchObject({
          status: 503,
          message:
            'Cancellation could not be confirmed; please retry or check subscription status',
        });

        expect(recordOf(authId)).toEqual(before);
        expect(eventsOf(authId)).toEqual(['CREATED']);
        expect(stripeSubscription(subscriptionId).cancel_at_period_end).toBe(
          false,
        );
        // A later attempt succeeds normally.
        await expect(
          service.cancelAtPeriodEnd(authId, meta),
        ).resolves.toMatchObject({ alreadyCanceled: false });
      },
    );

    it('records nothing when Stripe does not confirm the cancellation', async () => {
      const { authId } = await subscriber();
      const before = { ...recordOf(authId) };
      jest.spyOn(gateway, 'cancelAtPeriodEnd').mockResolvedValueOnce({
        id: recordOf(authId)?.providerSubscriptionId as string,
        status: 'active',
        cancelAtPeriodEnd: false,
        canceledAt: null,
        cancelAt: null,
      });

      await expect(
        service.cancelAtPeriodEnd(authId, meta),
      ).rejects.toMatchObject({ status: 503 });
      expect(recordOf(authId)).toEqual(before);
      expect(eventsOf(authId)).toEqual(['CREATED']);
    });

    it('records nothing when Stripe already ended the subscription', async () => {
      const { authId, subscriptionId } = await subscriber();
      api.cancelSubscription(subscriptionId);

      await expect(
        service.cancelAtPeriodEnd(authId, meta),
      ).rejects.toMatchObject({ status: 503 });
      expect(recordOf(authId)?.proCanceledAt).toBeNull();
    });

    it('records the cancellation from Stripe after a lost response, once', async () => {
      const { authId, subscriptionId } = await subscriber();
      // Stripe turns renewal off, but the response never arrives.
      api.failNext('POST /v1/subscriptions/:id', 'lost');

      await expect(
        service.cancelAtPeriodEnd(authId, meta),
      ).rejects.toMatchObject({ status: 503 });
      expect(recordOf(authId)?.proCanceledAt).toBeNull();
      expect(stripeSubscription(subscriptionId).cancel_at_period_end).toBe(
        true,
      );

      // Stripe's webhook confirms it; the user's retry then finds it.
      await expect(subscriptionUpdated(subscriptionId)()).resolves.toBe(
        'CANCELED',
      );
      const retry = await service.cancelAtPeriodEnd(authId, meta);

      expect(retry.alreadyCanceled).toBe(true);
      expect(retry.canceledAt).toBe(
        new Date(
          Number(stripeSubscription(subscriptionId).canceled_at) * 1000,
        ).toISOString(),
      );
      expect(eventsOf(authId)).toEqual(['CREATED', 'CANCELED']);
    });

    it('records a retried request after a lost response with the same Stripe time', async () => {
      const { authId, subscriptionId } = await subscriber();
      api.failNext('POST /v1/subscriptions/:id', 'lost');
      await expect(service.cancelAtPeriodEnd(authId, meta)).rejects.toThrow();

      const retry = await service.cancelAtPeriodEnd(authId, meta);

      expect(retry.alreadyCanceled).toBe(false);
      expect(retry.canceledAt).toBe(
        new Date(
          Number(stripeSubscription(subscriptionId).canceled_at) * 1000,
        ).toISOString(),
      );
      expect(eventsOf(authId)).toEqual(['CREATED', 'CANCELED']);
    });

    it('responds 503 and changes nothing while Stripe is not configured', async () => {
      const { authId } = await subscriber();
      build(null);

      await expect(
        service.cancelAtPeriodEnd(authId, meta),
      ).rejects.toMatchObject({
        status: 503,
        message: 'Payments are not configured',
      });
      expect(recordOf(authId)?.proCanceledAt).toBeNull();
    });
  });

  describe('who can cancel what', () => {
    it('only ever cancels the caller’s own subscription', async () => {
      const alice = await subscriber();
      const bob = await subscriber();

      await service.cancelAtPeriodEnd(bob.authId, meta);

      expect(recordOf(alice.authId)?.proCanceledAt).toBeNull();
      expect(
        stripeSubscription(alice.subscriptionId).cancel_at_period_end,
      ).toBe(false);
      expect(eventsOf(alice.authId)).toEqual(['CREATED']);
      expect(stripeSubscription(bob.subscriptionId).cancel_at_period_end).toBe(
        true,
      );
    });

    it('rejects a user without a subscription and touches nobody else', async () => {
      const alice = await subscriber();
      const stranger = await db.authUser.create({ data: {} });

      await expect(
        service.cancelAtPeriodEnd(stranger.id as string, meta),
      ).rejects.toMatchObject({ status: 409 });
      expect(recordOf(alice.authId)?.proCanceledAt).toBeNull();
      expect(cancelRequests()).toBe(0);
    });

    it.each([
      [
        'a free-trial user',
        {
          status: 'TRIAL',
          trialUsed: true,
          trialStartedAt: daysAgo(1),
          trialExpiresAt: new Date(Date.now() + 6 * DAY),
        },
      ],
      [
        'a user whose paid term has expired',
        {
          status: 'EXPIRED',
          billingInterval: MONTHLY,
          proStartedAt: daysAgo(45),
          proExpiresAt: daysAgo(15),
          paymentProvider: 'stripe',
          providerSubscriptionId: 'sub_old',
        },
      ],
      [
        'a paid term that is not backed by Stripe',
        {
          status: 'PRO',
          billingInterval: MONTHLY,
          proStartedAt: daysAgo(5),
          proExpiresAt: new Date(Date.now() + 25 * DAY),
        },
      ],
    ])('rejects %s with 409 without calling Stripe', async (_label, data) => {
      const user = await db.authUser.create({ data: {} });
      await db.userSubscription.create({
        data: { authId: user.id, ...data },
      });

      await expect(
        service.cancelAtPeriodEnd(user.id as string, meta),
      ).rejects.toMatchObject({
        status: 409,
        message: 'You do not have an active paid Pro subscription to cancel',
      });
      expect(cancelRequests()).toBe(0);
      expect(db.subscriptionEvent.rows).toHaveLength(0);
    });
  });

  describe('Stripe webhooks', () => {
    it('records a cancellation made in Stripe (e.g. the dashboard) once', async () => {
      const { authId, subscriptionId } = await subscriber();
      await api
        .client()
        .subscriptions.update(subscriptionId, { cancel_at_period_end: true });
      const deliver = subscriptionUpdated(subscriptionId);

      const outcomes = await Promise.all([deliver(), deliver(), deliver()]);

      expect([...outcomes].sort()).toEqual([
        'ALREADY_PROCESSED',
        'ALREADY_PROCESSED',
        'CANCELED',
      ]);
      expect(eventsOf(authId)).toEqual(['CREATED', 'CANCELED']);
      expect(activityLog.logActivity.mock.calls.at(-1)?.[0].metadata).toEqual({
        ...meta,
        actionedBy: null,
      });
    });

    it('ignores a stale update whose cancellation Stripe no longer schedules', async () => {
      const { authId, subscriptionId } = await subscriber();
      const stripe = api.client();
      await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true,
      });
      const stale = subscriptionUpdated(subscriptionId);
      await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: false,
      });

      await expect(stale()).resolves.toBe('IGNORED');
      expect(recordOf(authId)?.proCanceledAt).toBeNull();
      expect(eventsOf(authId)).toEqual(['CREATED']);
    });

    it('never reverses a recorded cancellation, whatever update arrives later', async () => {
      const { authId, subscriptionId } = await subscriber();
      const older = subscriptionUpdated(subscriptionId); // renewal still on
      await service.cancelAtPeriodEnd(authId, meta);
      const after = { ...recordOf(authId) };
      const requests = api.requests.length;

      await expect(older()).resolves.toBe('ALREADY_PROCESSED');

      expect(recordOf(authId)).toEqual(after);
      expect(api.requests).toHaveLength(requests);
    });

    it('ignores an update that schedules nothing, without calling Stripe', async () => {
      const { authId, subscriptionId } = await subscriber();
      const requests = api.requests.length;

      await expect(subscriptionUpdated(subscriptionId)()).resolves.toBe(
        'IGNORED',
      );
      expect(api.requests).toHaveLength(requests);
      expect(recordOf(authId)?.proCanceledAt).toBeNull();
    });

    it('adds nothing and keeps the expiry when Stripe ends the subscription at period end', async () => {
      const { authId, subscriptionId } = await subscriber();
      const view = await service.cancelAtPeriodEnd(authId, meta);
      const after = { ...recordOf(authId) };
      api.cancelSubscription(subscriptionId);
      const { payload, signature } = api.signedSubscriptionEvent(
        'customer.subscription.deleted',
        subscriptionId,
      );

      await expect(
        webhooks.handleEvent(
          webhooks.verifyEvent(Buffer.from(payload), signature),
          meta,
        ),
      ).resolves.toBe('ALREADY_PROCESSED');

      expect(recordOf(authId)).toEqual(after);
      expect(recordOf(authId)?.proExpiresAt).toEqual(new Date(view.endsAt));
      expect(recordOf(authId)?.proCanceledAt).toEqual(
        new Date(view.canceledAt),
      );
      expect(eventsOf(authId)).toEqual(['CREATED', 'CANCELED']);
    });
  });

  describe('other features stay as they were', () => {
    it('still blocks a new checkout while the canceled term runs', async () => {
      const { authId } = await subscriber();
      await service.cancelAtPeriodEnd(authId, meta);

      await expect(
        checkout.createCheckout(authId, MONTHLY),
      ).rejects.toMatchObject({
        status: 409,
        message: 'You already have an active Pro subscription',
      });
    });

    it('keeps the trial history of a former trial user', async () => {
      const { authId } = await subscriber();
      const trial = {
        trialUsed: true,
        trialStartedAt: daysAgo(30),
        trialExpiresAt: daysAgo(23),
      };
      await db.userSubscription.updateMany({ where: { authId }, data: trial });

      await service.cancelAtPeriodEnd(authId, meta);

      expect(recordOf(authId)).toMatchObject(trial);
    });
  });
});
