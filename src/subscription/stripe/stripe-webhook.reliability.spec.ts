import { BillingInterval } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import Stripe from 'stripe';
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
import { SubscriptionAccessService } from '../subscription-access.service';
import { SubscriptionPlanService } from '../subscription-plan.service';
import { StripeCancellationService } from './stripe-cancellation.service';
import { StripeCheckoutService } from './stripe-checkout.service';
import { StripeRefundService } from './stripe-refund.service';
import { StripeWebhookService } from './stripe-webhook.service';
import type { StripeSettings } from './stripe.config';
import { StripeGateway } from './stripe.gateway';

const { MONTHLY } = BillingInterval;
const DAY = 24 * 60 * 60 * 1000;
/** Stripe timestamps have whole-second precision. */
const daysAgo = (days: number) =>
  new Date(Math.floor((Date.now() - days * DAY) / 1000) * 1000);

/**
 * Webhook security and reliability through the real entry point, `receive`
 * (raw body + Stripe-Signature, as the HTTP controller calls it). Pro status
 * is always checked with SubscriptionAccessService.
 */
describe('Stripe webhooks: security and reliability', () => {
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
  const meta = { ip: '203.0.113.1', userAgent: 'Stripe/1.0' };
  let api: FakeStripeApi;
  let db: InMemoryBillingPrisma;
  let checkout: StripeCheckoutService;
  let webhooks: StripeWebhookService;
  let access: SubscriptionAccessService;

  const build = (config: StripeSettings = settings) => {
    const prisma = db as unknown as PrismaService;
    const gateway = new StripeGateway(config, api.client());
    checkout = new StripeCheckoutService(prisma, plans, gateway, logger);
    webhooks = new StripeWebhookService(
      prisma,
      gateway,
      activityLog,
      logger,
      new StripeCancellationService(prisma, gateway, activityLog, logger),
      new StripeRefundService(prisma, gateway, activityLog, logger),
    );
    access = new SubscriptionAccessService(prisma, plans);
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

  /** Delivers raw bytes and a signature header, like the controller. */
  const deliver = (payload: string, signature: string | undefined) =>
    webhooks.receive(Buffer.from(payload), signature, meta);
  const send = (event: { payload: string; signature: string }) =>
    deliver(event.payload, event.signature);
  const sign = (payload: string, secret = FAKE_WEBHOOK_SECRET) =>
    api.client().webhooks.generateTestHeaderString({ payload, secret });

  /** Everything the webhooks could change, to prove nothing changed. */
  const snapshot = () =>
    JSON.stringify({
      userSubscription: db.userSubscription.rows,
      paymentTransaction: db.paymentTransaction.rows,
      paymentRefund: db.paymentRefund.rows,
      subscriptionEvent: db.subscriptionEvent.rows,
      checkoutSession: db.checkoutSession.rows,
      paymentWebhookEvent: db.paymentWebhookEvent.rows,
    });

  /** A checkout whose payment Stripe collected (event not yet delivered). */
  async function paidCheckout(startedDaysAgo = 10) {
    const user = await db.authUser.create({ data: {} });
    const authId = user.id as string;
    const view = await checkout.createCheckout(authId, MONTHLY);
    const sessionId = db.checkoutSession.rows.find(
      (row) => row.id === view.checkoutSessionId,
    )?.providerSessionId as string;
    const session = api.completeSession(sessionId, {
      periodStart: daysAgo(startedDaysAgo),
    });
    return {
      authId,
      sessionId,
      subscriptionId: session.subscription as string,
      invoiceId: session.invoice as string,
      completed: api.signedEvent('checkout.session.completed', sessionId),
    };
  }
  async function subscriber(startedDaysAgo = 10) {
    const user = await paidCheckout(startedDaysAgo);
    await send(user.completed);
    return user;
  }
  const logOf = (eventId: string) =>
    db.paymentWebhookEvent.rows.find((row) => row.providerEventId === eventId);
  const eventIdOf = (payload: string) =>
    (JSON.parse(payload) as { id: string }).id;

  describe('signature verification comes before any read or write', () => {
    it.each<
      [
        string,
        (payload: string, signature: string) => [string, string | undefined],
      ]
    >([
      ['a missing signature header', (p) => [p, undefined]],
      ['a garbage signature', (p) => [p, 't=1,v1=00']],
      [
        'a signature made with another secret',
        (p) => [p, sign(p, 'whsec_someone_else')],
      ],
      [
        'a tampered payload (another session)',
        (p, s) => [
          p.replace(/"id":"cs_test_[^"]+"/, '"id":"cs_test_other"'),
          s,
        ],
      ],
      [
        'a tampered payload (payment status)',
        (p, s) => [
          p.replace('"payment_status":"paid"', '"payment_status":"paid "'),
          s,
        ],
      ],
      [
        'a replayed signature outside the tolerance',
        (p) => [
          p,
          api.client().webhooks.generateTestHeaderString({
            payload: p,
            secret: FAKE_WEBHOOK_SECRET,
            timestamp: Math.floor(Date.now() / 1000) - 600,
          }),
        ],
      ],
      ['an empty body', (_p, s) => ['', s]],
    ])('rejects %s with 400 and changes nothing', async (_label, tamper) => {
      const { authId, completed } = await paidCheckout();
      const before = snapshot();
      const requests = api.requests.length;
      const [payload, signature] = tamper(
        completed.payload,
        completed.signature,
      );

      await expect(deliver(payload, signature)).rejects.toMatchObject({
        status: 400,
      });

      expect(snapshot()).toBe(before);
      expect(api.requests).toHaveLength(requests);
      await expect(access.hasProAccess(authId)).resolves.toBe(false);
    });

    it('logs a verified event and its outcome, without any payload', async () => {
      const { authId, sessionId, completed } = await paidCheckout();

      await expect(send(completed)).resolves.toBe('ACTIVATED');

      expect(logOf(eventIdOf(completed.payload))).toMatchObject({
        provider: 'stripe',
        type: 'checkout.session.completed',
        objectId: sessionId,
        livemode: false,
        eventCreatedAt: expect.any(Date) as Date,
        status: 'PROCESSED',
        outcome: 'ACTIVATED',
        attempts: 1,
        lastErrorCode: null,
        processedAt: expect.any(Date) as Date,
      });
      expect(
        Object.keys(logOf(eventIdOf(completed.payload)) ?? {}),
      ).not.toContain('payload');
      await expect(access.hasProAccess(authId)).resolves.toBe(true);
    });
  });

  describe('events that are not about this integration', () => {
    it('ignores a connected-account event, whatever it says', async () => {
      const { authId, completed } = await paidCheckout();
      const payload = JSON.stringify({
        ...(JSON.parse(completed.payload) as object),
        account: 'acct_connected',
      });
      const requests = api.requests.length;

      await expect(deliver(payload, sign(payload))).resolves.toBe(
        'NOT_FOR_THIS_ACCOUNT',
      );

      expect(api.requests).toHaveLength(requests);
      await expect(access.hasProAccess(authId)).resolves.toBe(false);
      expect(db.paymentTransaction.rows).toHaveLength(0);
    });

    it('ignores a live-mode event at a test-mode integration and vice versa', async () => {
      const { authId, completed } = await paidCheckout();
      const live = JSON.stringify({
        ...(JSON.parse(completed.payload) as object),
        livemode: true,
      });
      await expect(deliver(live, sign(live))).resolves.toBe(
        'NOT_FOR_THIS_ACCOUNT',
      );

      build({ ...settings, secretKey: 'sk_live_fake' });
      await expect(send(completed)).resolves.toBe('NOT_FOR_THIS_ACCOUNT');
      await expect(access.hasProAccess(authId)).resolves.toBe(false);
    });

    it('acknowledges an event naming an object that does not exist in this account', async () => {
      const payload = JSON.stringify({
        id: 'evt_missing_charge',
        object: 'event',
        type: 'charge.refunded',
        livemode: false,
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: 'ch_not_here', object: 'charge' } },
      });

      await expect(deliver(payload, sign(payload))).resolves.toBe(
        'UNKNOWN_OBJECT',
      );
      expect(logOf('evt_missing_charge')).toMatchObject({
        status: 'PROCESSED',
        outcome: 'UNKNOWN_OBJECT',
      });
    });

    it('never lets another customer’s events change a user', async () => {
      const alice = await subscriber(10);
      const aliceBefore = JSON.stringify({
        record: db.userSubscription.rows.find((r) => r.authId === alice.authId),
        payments: db.paymentTransaction.rows.filter(
          (p) =>
            p.subscriptionId ===
            db.userSubscription.rows.find((r) => r.authId === alice.authId)?.id,
        ),
      });

      // Bob's whole lifecycle, delivered with valid signatures.
      const bob = await subscriber(45);
      const failed = api.renewSubscription(bob.subscriptionId, { paid: false });
      await send(
        api.signedInvoiceEvent('invoice.payment_failed', failed.id as string),
      );
      api.payInvoice(failed.id as string);
      await send(api.signedInvoiceEvent('invoice.paid', failed.id as string));
      api.refundInvoice(bob.invoiceId);
      await send(
        api.signedChargeEvent('charge.refunded', api.chargeOf(bob.invoiceId)),
      );
      await api.client().subscriptions.update(bob.subscriptionId, {
        cancel_at_period_end: true,
      });
      await send(
        api.signedSubscriptionEvent(
          'customer.subscription.updated',
          bob.subscriptionId,
        ),
      );

      const aliceRecord = db.userSubscription.rows.find(
        (r) => r.authId === alice.authId,
      );
      expect(
        JSON.stringify({
          record: aliceRecord,
          payments: db.paymentTransaction.rows.filter(
            (p) => p.subscriptionId === aliceRecord?.id,
          ),
        }),
      ).toBe(aliceBefore);
      await expect(access.hasProAccess(alice.authId)).resolves.toBe(true);
    });
  });

  describe('failures while applying a confirmed payment', () => {
    it('records nothing, reports a generic 500, and applies the event once on redelivery', async () => {
      const { authId, completed } = await paidCheckout();
      const transaction = db.$transaction;
      let failNext = true;
      db.$transaction = ((callback: (tx: unknown) => Promise<unknown>) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(
            Object.assign(new Error('connection terminated'), {
              code: 'P1017',
            }),
          );
        }
        return transaction(callback);
      }) as typeof db.$transaction;

      await expect(send(completed)).rejects.toMatchObject({
        status: 500,
        message: 'Webhook processing failed',
      });
      expect(db.paymentTransaction.rows).toHaveLength(0);
      await expect(access.hasProAccess(authId)).resolves.toBe(false);
      expect(logOf(eventIdOf(completed.payload))).toMatchObject({
        status: 'FAILED',
        lastErrorCode: 'db:P1017',
        attempts: 1,
        processedAt: null,
      });

      // Stripe redelivers the same event.
      await expect(send(completed)).resolves.toBe('ACTIVATED');
      await expect(send(completed)).resolves.toBe('ALREADY_PROCESSED');

      expect(db.paymentTransaction.rows).toHaveLength(1);
      expect(
        db.subscriptionEvent.rows.filter((row) => row.type === 'CREATED'),
      ).toHaveLength(1);
      await expect(access.hasProAccess(authId)).resolves.toBe(true);
      expect(logOf(eventIdOf(completed.payload))).toMatchObject({
        status: 'PROCESSED',
        outcome: 'ALREADY_PROCESSED',
        attempts: 3,
        lastErrorCode: null,
      });
    });

    it('applies concurrent deliveries of one event once', async () => {
      const { authId, completed } = await paidCheckout();

      const outcomes = await Promise.all(
        Array.from({ length: 6 }, () => send(completed)),
      );

      expect([...outcomes].sort()).toEqual([
        'ACTIVATED',
        ...Array<string>(5).fill('ALREADY_PROCESSED'),
      ]);
      expect(db.paymentTransaction.rows).toHaveLength(1);
      expect(logOf(eventIdOf(completed.payload))?.attempts).toBe(6);
      await expect(access.hasProAccess(authId)).resolves.toBe(true);
    });
  });

  describe('events that arrive before the first payment is recorded', () => {
    it('asks Stripe to retry a renewal instead of losing it', async () => {
      const { authId, subscriptionId, completed } = await paidCheckout(40);
      const renewal = api.renewSubscription(subscriptionId).id as string;
      const renewalEvent = api.signedInvoiceEvent('invoice.paid', renewal);

      await expect(send(renewalEvent)).rejects.toMatchObject({ status: 503 });
      expect(logOf(renewalEvent.eventId)).toMatchObject({
        status: 'FAILED',
        lastErrorCode: 'http:503',
      });

      await send(completed);
      await expect(send(renewalEvent)).resolves.toBe('RENEWED');
      expect(db.paymentTransaction.rows).toHaveLength(2);
      await expect(access.hasProAccess(authId)).resolves.toBe(true);
    });

    it('asks Stripe to retry a cancellation instead of losing it', async () => {
      const { authId, subscriptionId, completed } = await paidCheckout(10);
      await api
        .client()
        .subscriptions.update(subscriptionId, { cancel_at_period_end: true });
      const canceled = api.signedSubscriptionEvent(
        'customer.subscription.updated',
        subscriptionId,
      );

      await expect(send(canceled)).rejects.toMatchObject({ status: 503 });

      await send(completed);
      await expect(send(canceled)).resolves.toBe('CANCELED');
      expect(
        db.userSubscription.rows.find((r) => r.authId === authId)
          ?.proCanceledAt,
      ).toBeInstanceOf(Date);
      // Canceled at period end: still Pro until then.
      await expect(access.hasProAccess(authId)).resolves.toBe(true);
    });

    it('asks Stripe to retry the end of a subscription, and keeps Stripe’s cancellation date', async () => {
      const { authId, subscriptionId, completed } = await paidCheckout(10);
      // Renewal turned off two days ago; the subscription ended now.
      const turnedOffAt = daysAgo(2);
      const clock = jest
        .spyOn(Date, 'now')
        .mockReturnValue(turnedOffAt.getTime());
      await api
        .client()
        .subscriptions.update(subscriptionId, { cancel_at_period_end: true });
      clock.mockRestore();
      api.cancelSubscription(subscriptionId);
      const ended = api.signedSubscriptionEvent(
        'customer.subscription.deleted',
        subscriptionId,
      );

      await expect(send(ended)).rejects.toMatchObject({ status: 503 });

      await send(completed);
      await expect(send(ended)).resolves.toBe('SUBSCRIPTION_ENDED');
      const record = db.userSubscription.rows.find((r) => r.authId === authId);
      // Stripe `canceled_at`, not `ended_at`.
      expect(record?.proCanceledAt).toEqual(turnedOffAt);
      expect(
        db.subscriptionEvent.rows.filter((row) => row.type === 'CANCELED'),
      ).toEqual([expect.objectContaining({ occurredAt: turnedOffAt })]);
    });

    /**
     * Records the first payment (as a concurrent delivery would) right after
     * the `nth` lookup of `table` that matches `isLookup` found nothing.
     */
    function recordFirstPaymentAfterLookup(
      table: { findFirst: (args?: { where?: object }) => Promise<unknown> },
      isLookup: (where: Record<string, unknown>) => boolean,
      nth: number,
      completed: { payload: string; signature: string },
    ) {
      // The store's methods are arrow functions: no `this` to bind.
      const findFirst = table.findFirst;
      let misses = 0;
      table.findFirst = async (args) => {
        const result = await findFirst(args);
        if (
          result === null &&
          misses < nth &&
          isLookup((args?.where ?? {}) as Record<string, unknown>) &&
          ++misses === nth
        ) {
          await send(completed);
        }
        return result;
      };
    }

    it('never reports a renewal as unknown when the first payment is recorded during its lookup', async () => {
      const { authId, subscriptionId, completed } = await paidCheckout(40);
      const renewal = api.renewSubscription(subscriptionId).id as string;
      const renewalEvent = api.signedInvoiceEvent('invoice.paid', renewal);
      // The second "linked checkout" lookup misses; the payment is linked
      // just before the fallback lookup by checkout id.
      recordFirstPaymentAfterLookup(
        db.checkoutSession,
        (where) => where.providerSubscriptionId === subscriptionId,
        2,
        completed,
      );

      await expect(send(renewalEvent)).rejects.toMatchObject({ status: 503 });
      expect(db.paymentTransaction.rows).toHaveLength(1);

      await expect(send(renewalEvent)).resolves.toBe('RENEWED');
      expect(db.paymentTransaction.rows).toHaveLength(2);
      await expect(access.hasProAccess(authId)).resolves.toBe(true);
    });

    it('never drops the end of a subscription when the first payment is recorded during its lookup', async () => {
      const { authId, subscriptionId, completed } = await paidCheckout(10);
      api.cancelSubscription(subscriptionId);
      const ended = api.signedSubscriptionEvent(
        'customer.subscription.deleted',
        subscriptionId,
      );
      recordFirstPaymentAfterLookup(
        db.userSubscription,
        (where) => where.providerSubscriptionId === subscriptionId,
        1,
        completed,
      );

      await expect(send(ended)).rejects.toMatchObject({ status: 503 });
      await expect(send(ended)).resolves.toBe('SUBSCRIPTION_ENDED');
      expect(
        db.userSubscription.rows.find((r) => r.authId === authId)
          ?.proCanceledAt,
      ).toBeInstanceOf(Date);
    });

    it('keeps an event logged as processed when a concurrent duplicate delivery fails', async () => {
      const { authId, subscriptionId, completed } = await paidCheckout(40);
      const renewal = api.renewSubscription(subscriptionId).id as string;
      const renewalEvent = api.signedInvoiceEvent('invoice.paid', renewal);
      // While this delivery waits (no first payment yet), the first payment
      // and another delivery of the same event are processed; this one then
      // asks for a retry that Stripe will not make (it got a 200).
      const findFirst = db.checkoutSession.findFirst;
      let raced = false;
      db.checkoutSession.findFirst = async (args) => {
        const result = await findFirst(args);
        if (!raced && result === null) {
          raced = true;
          await send(completed);
          await expect(send(renewalEvent)).resolves.toBe('RENEWED');
        }
        return result;
      };

      await expect(send(renewalEvent)).rejects.toMatchObject({ status: 503 });
      expect(logOf(renewalEvent.eventId)).toMatchObject({
        status: 'PROCESSED',
        outcome: 'RENEWED',
        attempts: 2,
      });
      await expect(access.hasProAccess(authId)).resolves.toBe(true);
    });

    it('finds the checkout of a paid session whose id is stored during the webhook lookup', async () => {
      const user = await db.authUser.create({ data: {} });
      const authId = user.id as string;
      // Stripe created the session but its response was lost: the checkout
      // stays CREATING without a session id.
      api.failNext('POST /v1/checkout/sessions', 'lost');
      await expect(
        checkout.createCheckout(authId, MONTHLY),
      ).rejects.toMatchObject({ status: 503 });
      const [row] = db.checkoutSession.rows;
      expect(row.providerSessionId ?? null).toBeNull();
      const [sessionId] = [...api.sessions.keys()];
      api.completeSession(sessionId);

      // A retried checkout request stores the session id right after the
      // webhook's lookup by session id missed.
      const findUnique = db.checkoutSession.findUnique;
      let raced = false;
      db.checkoutSession.findUnique = async (args) => {
        const result = await findUnique(args);
        if (!raced && result === null) {
          raced = true;
          await db.checkoutSession.updateMany({
            where: { id: row.id },
            data: { providerSessionId: sessionId },
          });
        }
        return result;
      };

      await expect(
        send(api.signedEvent('checkout.session.completed', sessionId)),
      ).resolves.toBe('ACTIVATED');
      await expect(access.hasProAccess(authId)).resolves.toBe(true);
    });

    it('does not retry a cancellation of a subscription that was never paid', async () => {
      const user = await db.authUser.create({ data: {} });
      const view = await checkout.createCheckout(user.id as string, MONTHLY);
      const sessionId = db.checkoutSession.rows.find(
        (row) => row.id === view.checkoutSessionId,
      )?.providerSessionId as string;
      const invoice = api.failFirstPayment(sessionId);
      const subscriptionId = api.sessions.get(sessionId)
        ?.subscription as string;
      await api
        .client()
        .subscriptions.update(subscriptionId, { cancel_at_period_end: true });
      expect(invoice.status).toBe('open');

      await expect(
        send(
          api.signedSubscriptionEvent(
            'customer.subscription.updated',
            subscriptionId,
          ),
        ),
      ).resolves.toBe('IGNORED');
    });
  });

  it('only ever processes verified events (compile-time guarantee)', () => {
    // handleEvent takes a VerifiedStripeEvent, which only verifyEvent
    // produces; passing a parsed payload is a type error:
    // @ts-expect-error an unverified Stripe.Event is not accepted
    const call = () => webhooks.handleEvent({} as Stripe.Event, meta);
    expect(typeof call).toBe('function');
  });
});
