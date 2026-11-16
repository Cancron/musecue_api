import { PrismaClient } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import { ActivityLogService } from '../src/common/services/activity-log.service';
import type { CustomLoggerService } from '../src/common/services/custom-logger.service';
import type { PrismaService } from '../src/common/services/prisma.service';
import { addBillingInterval } from '../src/subscription/billing.validation';
import { SubscriptionAccessService } from '../src/subscription/subscription-access.service';
import { SubscriptionPlanService } from '../src/subscription/subscription-plan.service';
import { FakeStripeApi } from './support/fake-stripe-api';
import { describeWithDatabase } from './support/migrated-schema';
import {
  createStripeTestApp,
  dataOf,
  type StripeTestApp,
} from './support/stripe-test-app';
import { createUser, recordPayment } from './support/subscription-fixtures';

jest.setTimeout(120_000);

const DAY = 24 * 60 * 60 * 1000;
/** Stripe timestamps have whole-second precision. */
const daysAgo = (days: number) =>
  new Date(Math.floor((Date.now() - days * DAY) / 1000) * 1000);
const justBefore = (date: Date) => new Date(date.getTime() - 1);

/**
 * Failed payments and their recovery end to end: signed webhooks over HTTP,
 * the real services and the migrated PostgreSQL schema (CHECK constraints,
 * paid-term trigger, forward-only payment status).
 */
describeWithDatabase('Stripe payment failures (PostgreSQL, HTTP)', () => {
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

  /** Starts a checkout; returns the user and the Stripe session. */
  async function checkoutStarted(interval: 'MONTHLY' | 'YEARLY' = 'MONTHLY') {
    const authId = await createUser(client);
    const view = dataOf(
      await harness.startCheckout(authId, interval).expect(201),
    );
    const checkout = await client.checkoutSession.findUniqueOrThrow({
      where: { id: view.checkoutSessionId },
    });
    return {
      authId,
      checkoutId: checkout.id,
      sessionId: checkout.providerSessionId as string,
    };
  }

  /** A user whose first payment (period starting at `periodStart`) is confirmed. */
  async function subscribed(periodStart: Date) {
    const started = await checkoutStarted('MONTHLY');
    const session = api.completeSession(started.sessionId, { periodStart });
    await send(
      api.signedEvent('checkout.session.completed', started.sessionId),
    );
    return { ...started, subscriptionId: session.subscription as string };
  }

  const send = (event: { payload: string; signature: string }) =>
    harness.sendWebhook(event.payload, event.signature).expect(200);
  const failed = (invoiceId: string) =>
    send(api.signedInvoiceEvent('invoice.payment_failed', invoiceId));
  const paid = (invoiceId: string) =>
    send(api.signedInvoiceEvent('invoice.paid', invoiceId));
  /** The period end Stripe reports for an invoice (anchored billing dates). */
  const stripePeriodEnd = (invoiceId: string) => {
    const lines = api.invoices.get(invoiceId)?.lines as {
      data: { period: { end: number } }[];
    };
    return new Date(lines.data[0].period.end * 1000);
  };
  const failedRenewal = (subscriptionId: string) =>
    api.renewSubscription(subscriptionId, { paid: false }).id as string;

  const recordOf = (authId: string) =>
    client.userSubscription.findUniqueOrThrow({
      where: { authId },
      include: {
        payments: { orderBy: { createdAt: 'asc' } },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });
  const eventTypes = async (authId: string) =>
    (await recordOf(authId)).events.map((event) => event.type);
  const hasAccess = (authId: string, at: Date) =>
    access.hasProAccess(authId, at);

  describe('a failed renewal', () => {
    it('is recorded without extending access, which runs until the paid expiry', async () => {
      const start = daysAgo(25);
      const { authId, subscriptionId } = await subscribed(start);
      const expiry = (await recordOf(authId)).proExpiresAt as Date;
      const invoiceId = failedRenewal(subscriptionId);

      await failed(invoiceId);

      const record = await recordOf(authId);
      expect(record.payments).toEqual([
        expect.objectContaining({ status: 'SUCCEEDED' }),
        expect.objectContaining({
          provider: 'stripe',
          providerInvoiceId: invoiceId,
          providerPaymentId: expect.stringMatching(
            new RegExp(`^${invoiceId}:failed:evt_`),
          ) as string,
          status: 'FAILED',
          amountCents: 1900,
          periodStart: expiry,
          paidAt: null,
          failedAt: expect.any(Date) as Date,
          failureCode: 'insufficient_funds',
          failureMessage: 'Your card has insufficient funds.',
        }),
      ]);
      expect(record).toMatchObject({
        status: 'PRO',
        proStartedAt: start,
        proExpiresAt: expiry,
        pastDueSince: record.payments[1].failedAt,
      });
      expect(record.events.map((event) => event.type)).toEqual([
        'CREATED',
        'PAYMENT_FAILED',
      ]);
      // The user keeps what they paid for, and nothing more.
      await expect(harness.status(authId)).resolves.toMatchObject({
        status: 'PRO',
        hasProAccess: true,
        accessExpiresAt: expiry.toISOString(),
      });
      await expect(hasAccess(authId, justBefore(expiry))).resolves.toBe(true);
      await expect(hasAccess(authId, expiry)).resolves.toBe(false);
    });

    it('records each retry and recovers once when Stripe collects the invoice', async () => {
      const { authId, subscriptionId } = await subscribed(daysAgo(25));
      const expiry = (await recordOf(authId)).proExpiresAt as Date;
      const invoiceId = failedRenewal(subscriptionId);
      await failed(invoiceId);
      api.failInvoiceAttempt(invoiceId, { declineCode: 'expired_card' });
      await failed(invoiceId);
      api.payInvoice(invoiceId);

      await paid(invoiceId);

      const record = await recordOf(authId);
      const renewedEnd = stripePeriodEnd(invoiceId);
      expect(
        record.payments
          .filter((payment) => payment.providerInvoiceId === invoiceId)
          .map((payment) => [payment.status, payment.failureCode]),
      ).toEqual([
        ['FAILED', 'insufficient_funds'],
        ['FAILED', 'expired_card'],
        ['SUCCEEDED', null],
      ]);
      expect(record.events.map((event) => event.type)).toEqual([
        'CREATED',
        'PAYMENT_FAILED',
        'PAYMENT_FAILED',
        'RENEWED',
      ]);
      expect(record).toMatchObject({
        pastDueSince: null,
        proExpiresAt: renewedEnd,
      });
      // The recovered period continues the paid term exactly: no gap, no overlap.
      expect(record.payments.at(-1)).toMatchObject({
        periodStart: expiry,
        periodEnd: renewedEnd,
      });
      await expect(harness.status(authId)).resolves.toMatchObject({
        status: 'PRO',
        accessExpiresAt: renewedEnd.toISOString(),
      });
      await expect(hasAccess(authId, justBefore(renewedEnd))).resolves.toBe(
        true,
      );
      await expect(hasAccess(authId, renewedEnd)).resolves.toBe(false);
    });

    it('restores access from the old expiry when collected after the term lapsed', async () => {
      const start = daysAgo(45);
      const { authId, subscriptionId } = await subscribed(start);
      const lapsedAt = (await recordOf(authId)).proExpiresAt as Date;
      const invoiceId = failedRenewal(subscriptionId);
      await failed(invoiceId);
      await expect(harness.status(authId)).resolves.toMatchObject({
        status: 'EXPIRED',
        hasProAccess: false,
      });

      api.payInvoice(invoiceId);
      await paid(invoiceId);

      const record = await recordOf(authId);
      const renewedEnd = stripePeriodEnd(invoiceId);
      expect(record).toMatchObject({
        proStartedAt: start,
        proExpiresAt: renewedEnd,
        pastDueSince: null,
      });
      expect(record.payments.at(-1)).toMatchObject({
        status: 'SUCCEEDED',
        periodStart: lapsedAt,
        periodEnd: renewedEnd,
      });
      await expect(harness.status(authId)).resolves.toMatchObject({
        status: 'PRO',
        hasProAccess: true,
      });
      await expect(hasAccess(authId, justBefore(renewedEnd))).resolves.toBe(
        true,
      );
      await expect(hasAccess(authId, renewedEnd)).resolves.toBe(false);
    });
  });

  describe('duplicated and delayed events', () => {
    it('records one attempt for concurrent deliveries of the same failure', async () => {
      const { authId, subscriptionId } = await subscribed(daysAgo(25));
      const event = api.signedInvoiceEvent(
        'invoice.payment_failed',
        failedRenewal(subscriptionId),
      );

      await Promise.all(Array.from({ length: 8 }, () => send(event)));

      const record = await recordOf(authId);
      expect(
        record.payments.filter((payment) => payment.status === 'FAILED'),
      ).toHaveLength(1);
      expect(record.events.map((e) => e.type)).toEqual([
        'CREATED',
        'PAYMENT_FAILED',
      ]);
    });

    it('records one payment and one renewal for concurrent recovery deliveries', async () => {
      const { authId, subscriptionId } = await subscribed(daysAgo(25));
      const invoiceId = failedRenewal(subscriptionId);
      await failed(invoiceId);
      api.payInvoice(invoiceId);
      const events = [
        api.signedInvoiceEvent('invoice.paid', invoiceId),
        api.signedInvoiceEvent('invoice.paid', invoiceId),
      ];

      await Promise.all(
        Array.from({ length: 8 }, (_, i) => send(events[i % 2])),
      );

      const record = await recordOf(authId);
      expect(
        record.payments.filter((payment) => payment.status === 'SUCCEEDED'),
      ).toHaveLength(2);
      expect(record.events.filter((e) => e.type === 'RENEWED')).toHaveLength(1);
    });

    it('keeps a failure delivered after the recovery as history only', async () => {
      const { authId, subscriptionId } = await subscribed(daysAgo(25));
      const invoiceId = failedRenewal(subscriptionId);
      const lateFailure = api.signedInvoiceEvent(
        'invoice.payment_failed',
        invoiceId,
      );
      api.payInvoice(invoiceId);
      await paid(invoiceId);
      const afterRecovery = await client.userSubscription.findUniqueOrThrow({
        where: { authId },
      });

      await send(lateFailure);

      await expect(
        client.userSubscription.findUniqueOrThrow({ where: { authId } }),
      ).resolves.toEqual(afterRecovery);
      await expect(eventTypes(authId)).resolves.toEqual([
        'CREATED',
        'RENEWED',
        'PAYMENT_FAILED',
      ]);
    });
  });

  describe('a failed first payment', () => {
    it('is recorded, grants nothing, and activates once when paid in the same checkout', async () => {
      const { authId, checkoutId, sessionId } = await checkoutStarted('YEARLY');
      const invoiceId = api.failFirstPayment(sessionId).id as string;

      await failed(invoiceId);

      await expect(recordOf(authId)).resolves.toMatchObject({
        proStartedAt: null,
        pastDueSince: null,
        payments: [
          expect.objectContaining({
            status: 'FAILED',
            providerInvoiceId: invoiceId,
            amountCents: 19000,
            billingInterval: 'YEARLY',
          }),
        ],
      });
      await expect(harness.status(authId)).resolves.toMatchObject({
        status: 'FREE',
        hasProAccess: false,
      });
      await expect(
        client.checkoutSession.findUniqueOrThrow({ where: { id: checkoutId } }),
      ).resolves.toMatchObject({ status: 'OPEN' });

      // The customer tries another card; invoice.paid arrives first.
      api.completeSession(sessionId);
      await Promise.all([
        paid(invoiceId),
        send(api.signedEvent('checkout.session.completed', sessionId)),
        paid(invoiceId),
      ]);

      const record = await recordOf(authId);
      expect(record.payments.map((payment) => payment.status)).toEqual([
        'FAILED',
        'SUCCEEDED',
      ]);
      expect(record.events.map((event) => event.type)).toEqual([
        'PAYMENT_FAILED',
        'CREATED',
      ]);
      await expect(harness.status(authId)).resolves.toMatchObject({
        status: 'PRO',
        pro: { billingInterval: 'YEARLY' },
      });
      await expect(
        client.checkoutSession.findUniqueOrThrow({ where: { id: checkoutId } }),
      ).resolves.toMatchObject({ status: 'COMPLETED' });
    });
  });

  describe('when Stripe gives up', () => {
    it('blocks a second purchase while retrying, then ends renewal and allows checkout', async () => {
      const { authId, subscriptionId } = await subscribed(daysAgo(45));
      const expiry = (await recordOf(authId)).proExpiresAt as Date;
      const invoiceId = api.renewSubscription(subscriptionId, {
        paid: false,
        failure: { final: true },
      }).id as string;
      await failed(invoiceId);

      const blocked = await harness.startCheckout(authId, 'MONTHLY');
      expect(blocked.status).toBe(409);
      expect(api.openSessions()).toHaveLength(0);

      api.cancelSubscription(subscriptionId);
      const deleted = api.signedSubscriptionEvent(
        'customer.subscription.deleted',
        subscriptionId,
      );
      await send(deleted);
      await send(deleted);

      const record = await recordOf(authId);
      expect(record).toMatchObject({
        pastDueSince: null,
        proExpiresAt: expiry,
        proCanceledAt: expect.any(Date) as Date,
      });
      expect(record.events.map((event) => event.type)).toEqual([
        'CREATED',
        'PAYMENT_FAILED',
        'CANCELED',
      ]);
      await expect(harness.status(authId)).resolves.toMatchObject({
        status: 'EXPIRED',
        pro: { canceledAt: (record.proCanceledAt as Date).toISOString() },
      });
      await harness.startCheckout(authId, 'MONTHLY').expect(201);
    });
  });

  describe('database rules', () => {
    async function linkedSubscription() {
      const { authId, subscriptionId } = await subscribed(daysAgo(5));
      return { authId, subscriptionId, record: await recordOf(authId) };
    }

    it('never lets a failed attempt back an extension of the paid term', async () => {
      const { record } = await linkedSubscription();
      const nextEnd = addBillingInterval(
        record.proExpiresAt as Date,
        'MONTHLY',
      );
      await recordPayment(client, record.id, {
        status: 'FAILED',
        periodStart: record.proExpiresAt as Date,
        periodEnd: nextEnd,
        providerPaymentId: 'in_x:failed:evt_x',
      });

      await expect(
        client.userSubscription.update({
          where: { id: record.id },
          data: { proExpiresAt: nextEnd },
        }),
      ).rejects.toThrow(/requires a verified \(SUCCEEDED\) payment/);
    });

    it('keeps FAILED attempts terminal and allows several for one period', async () => {
      const { record } = await linkedSubscription();
      const start = record.proExpiresAt as Date;
      const end = addBillingInterval(start, 'MONTHLY');
      const first = await recordPayment(client, record.id, {
        status: 'FAILED',
        periodStart: start,
        periodEnd: end,
      });
      await expect(
        recordPayment(client, record.id, {
          status: 'FAILED',
          periodStart: start,
          periodEnd: end,
        }),
      ).resolves.toBeDefined();
      await expect(
        client.paymentTransaction.update({
          where: { id: first.id },
          data: {
            status: 'SUCCEEDED',
            paidAt: new Date(),
            failedAt: null,
            failureCode: null,
          },
        }),
      ).rejects.toThrow(/status cannot change from FAILED to SUCCEEDED/);
    });

    it('never changes the invoice of a recorded attempt', async () => {
      const { record } = await linkedSubscription();
      const payment = record.payments[0];
      expect(payment.providerInvoiceId).toBe(payment.providerPaymentId);
      await expect(
        client.paymentTransaction.update({
          where: { id: payment.id },
          data: { providerInvoiceId: 'in_other' },
        }),
      ).rejects.toThrow(/provider invoice cannot change/);
    });

    it('only marks a subscription linked to Stripe as past due', async () => {
      const authId = await createUser(client);
      await expect(
        client.userSubscription.create({
          data: { authId, pastDueSince: new Date() },
        }),
      ).rejects.toThrow(/UserSubscription_past_due_linked/);
    });
  });
});
