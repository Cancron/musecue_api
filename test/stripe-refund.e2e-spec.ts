import { PrismaClient } from '@prisma/client';
import { mock } from 'jest-mock-extended';
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
import { createUser, recordPayment } from './support/subscription-fixtures';

jest.setTimeout(120_000);

const DAY = 24 * 60 * 60 * 1000;
/** Stripe timestamps have whole-second precision. */
const daysAgo = (days: number) =>
  new Date(Math.floor((Date.now() - days * DAY) / 1000) * 1000);

/**
 * Refunds made in Stripe, end to end: signed webhooks over HTTP, the real
 * services and the migrated PostgreSQL schema (refund and payment triggers,
 * CHECK constraints, paid-term rules).
 */
describeWithDatabase('Stripe refunds (PostgreSQL, HTTP)', () => {
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
    harness.sendWebhook(event.payload, event.signature);

  /** Checkout paid in Stripe; `deliver: false` leaves the webhook unsent. */
  async function subscriber(
    startedDaysAgo = 10,
    interval: 'MONTHLY' | 'YEARLY' = 'MONTHLY',
    deliver = true,
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
    if (deliver) {
      await send(
        api.signedEvent('checkout.session.completed', sessionId),
      ).expect(200);
    }
    return {
      authId,
      sessionId,
      subscriptionId: session.subscription as string,
      invoiceId: session.invoice as string,
    };
  }

  const chargeRefunded = (invoiceId: string) =>
    send(api.signedChargeEvent('charge.refunded', api.chargeOf(invoiceId)));

  it('records a refund after account deletion without restoring its subscription', async () => {
    const { authId, invoiceId } = await subscriber();
    const before = await client.paymentTransaction.findUniqueOrThrow({
      where: {
        provider_providerPaymentId: {
          provider: 'stripe',
          providerPaymentId: invoiceId,
        },
      },
    });
    await client.authUser.delete({ where: { id: authId } });
    api.refundInvoice(invoiceId);

    await chargeRefunded(invoiceId).expect(200);
    const payment = await client.paymentTransaction.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(payment).toMatchObject({
      subscriptionId: null,
      amountCents: before.amountCents,
      providerPaymentId: before.providerPaymentId,
      status: 'REFUNDED',
      refundedAmountCents: before.amountCents,
    });
    expect(
      await client.paymentRefund.count({ where: { paymentId: before.id } }),
    ).toBe(1);
    expect(
      await client.authUser.findUnique({ where: { id: authId } }),
    ).toBeNull();
    expect(await client.userSubscription.count({ where: { authId } })).toBe(0);
    await chargeRefunded(invoiceId).expect(200);
    expect(
      await client.paymentRefund.count({ where: { paymentId: before.id } }),
    ).toBe(1);
  });
  const paymentOf = (invoiceId: string) =>
    client.paymentTransaction.findUniqueOrThrow({
      where: {
        provider_providerPaymentId: {
          provider: 'stripe',
          providerPaymentId: invoiceId,
        },
      },
      include: { refunds: true },
    });
  const recordOf = (authId: string) =>
    client.userSubscription.findUniqueOrThrow({
      where: { authId },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });
  const eventTypes = async (authId: string) =>
    (await recordOf(authId)).events.map((event) => event.type);

  describe('full and partial refunds', () => {
    it('records a full refund and revokes Pro immediately', async () => {
      const { authId, invoiceId } = await subscriber(10);
      const before = await recordOf(authId);
      const refund = api.refundInvoice(invoiceId, { reason: 'duplicate' });
      const requestedAt = Date.now();

      await chargeRefunded(invoiceId).expect(200);

      const payment = await paymentOf(invoiceId);
      expect(payment).toMatchObject({
        status: 'REFUNDED',
        amountCents: 1900,
        refundedAmountCents: 1900,
        refundedAt: new Date(Number(refund.created) * 1000),
        refunds: [
          expect.objectContaining({
            provider: 'stripe',
            providerRefundId: refund.id,
            providerChargeId: api.chargeOf(invoiceId),
            status: 'SUCCEEDED',
            amountCents: 1900,
            currency: 'USD',
            reason: 'duplicate',
          }),
        ],
      });
      const record = await recordOf(authId);
      expect(record).toMatchObject({
        status: 'EXPIRED',
        proStartedAt: before.proStartedAt,
        providerSubscriptionId: before.providerSubscriptionId,
      });
      // Revoked at the time of the webhook, long before the paid expiry.
      const revokedAt = (record.proExpiresAt as Date).getTime();
      expect(revokedAt).toBeGreaterThanOrEqual(requestedAt);
      expect(revokedAt).toBeLessThanOrEqual(Date.now());
      expect(revokedAt).toBeLessThan((before.proExpiresAt as Date).getTime());
      expect(record.events.map((event) => event.type)).toEqual([
        'CREATED',
        'PAYMENT_REFUNDED',
      ]);
      await expect(harness.status(authId)).resolves.toMatchObject({
        status: 'EXPIRED',
        hasProAccess: false,
      });
      await expect(access.hasProAccess(authId)).resolves.toBe(false);
      await expect(
        client.activityLogEvent.findMany({
          where: { tableName: 'UserSubscription', recordId: record.id },
          include: { details: true },
          orderBy: { createdAt: 'asc' },
        }),
      ).resolves.toEqual([
        expect.anything(),
        expect.objectContaining({
          actionedBy: null,
          details: expect.arrayContaining([
            expect.objectContaining({
              fieldName: 'status',
              oldValue: 'PRO',
              newValue: 'EXPIRED',
            }),
          ]) as unknown,
        }),
      ]);
    });

    it('records partial refunds as PARTIALLY_REFUNDED, then REFUNDED, revoking once', async () => {
      const { authId, invoiceId } = await subscriber(10, 'YEARLY');
      api.refundInvoice(invoiceId, { amount: 5000 });

      await chargeRefunded(invoiceId).expect(200);
      await expect(paymentOf(invoiceId)).resolves.toMatchObject({
        status: 'PARTIALLY_REFUNDED',
        amountCents: 19000,
        refundedAmountCents: 5000,
      });
      const afterPartial = await recordOf(authId);
      expect(afterPartial.status).toBe('EXPIRED');
      await expect(access.hasProAccess(authId)).resolves.toBe(false);

      api.refundInvoice(invoiceId, { amount: 14000 });
      await chargeRefunded(invoiceId).expect(200);

      const payment = await paymentOf(invoiceId);
      expect(payment).toMatchObject({
        status: 'REFUNDED',
        refundedAmountCents: 19000,
      });
      expect(
        payment.refunds.map((refund) => refund.amountCents).sort(),
      ).toEqual([14000, 5000]);
      await expect(recordOf(authId)).resolves.toMatchObject({
        proExpiresAt: afterPartial.proExpiresAt,
        status: 'EXPIRED',
      });
      await expect(eventTypes(authId)).resolves.toEqual([
        'CREATED',
        'PAYMENT_REFUNDED',
        'PAYMENT_REFUNDED',
      ]);
    });

    it('records a pending refund first and applies it only when Stripe confirms it', async () => {
      const { authId, invoiceId } = await subscriber(10);
      const refund = api.refundInvoice(invoiceId, { status: 'pending' });

      await send(
        api.signedRefundEvent('refund.created', refund.id as string),
      ).expect(200);
      await expect(paymentOf(invoiceId)).resolves.toMatchObject({
        status: 'SUCCEEDED',
        refundedAmountCents: 0,
        refunds: [expect.objectContaining({ status: 'PENDING' })],
      });
      await expect(access.hasProAccess(authId)).resolves.toBe(true);

      api.setRefundStatus(refund.id as string, 'succeeded');
      await send(
        api.signedRefundEvent('refund.updated', refund.id as string),
      ).expect(200);

      await expect(paymentOf(invoiceId)).resolves.toMatchObject({
        status: 'REFUNDED',
        refunds: [expect.objectContaining({ status: 'SUCCEEDED' })],
      });
      await expect(access.hasProAccess(authId)).resolves.toBe(false);
    });
  });

  describe('repeated and delayed events', () => {
    it('records one refund and one revocation for concurrent repeated events', async () => {
      const { authId, invoiceId } = await subscriber(10);
      const refund = api.refundInvoice(invoiceId);
      const events = [
        api.signedChargeEvent('charge.refunded', api.chargeOf(invoiceId)),
        api.signedRefundEvent('refund.created', refund.id as string),
        api.signedRefundEvent('refund.updated', refund.id as string),
        api.signedRefundEvent('charge.refund.updated', refund.id as string),
      ];

      const responses = await Promise.all(
        [...events, ...events, ...events].map((event) => send(event)),
      );

      expect(responses.map((response) => response.status)).toEqual(
        Array(12).fill(200),
      );
      await expect(paymentOf(invoiceId)).resolves.toMatchObject({
        status: 'REFUNDED',
        refunds: [expect.anything()],
      });
      await expect(eventTypes(authId)).resolves.toEqual([
        'CREATED',
        'PAYMENT_REFUNDED',
      ]);
      const record = await recordOf(authId);
      await expect(
        client.activityLogEvent.count({
          where: { tableName: 'UserSubscription', recordId: record.id },
        }),
      ).resolves.toBe(2);

      // Later redeliveries change nothing and never restore access.
      const settled = await client.userSubscription.findUniqueOrThrow({
        where: { authId },
      });
      await send(events[0]).expect(200);
      await send(api.signedInvoiceEvent('invoice.paid', invoiceId)).expect(200);
      await expect(
        client.userSubscription.findUniqueOrThrow({ where: { authId } }),
      ).resolves.toEqual(settled);
      await expect(access.hasProAccess(authId)).resolves.toBe(false);
    });

    it('ignores a stale pending event delivered after the refund succeeded', async () => {
      const { authId, invoiceId } = await subscriber(10);
      const refund = api.refundInvoice(invoiceId, { status: 'pending' });
      const stale = api.signedRefundEvent(
        'refund.created',
        refund.id as string,
      );
      api.setRefundStatus(refund.id as string, 'succeeded');
      await chargeRefunded(invoiceId).expect(200);
      const settled = await client.userSubscription.findUniqueOrThrow({
        where: { authId },
      });

      await send(stale).expect(200);

      await expect(
        client.userSubscription.findUniqueOrThrow({ where: { authId } }),
      ).resolves.toEqual(settled);
      await expect(paymentOf(invoiceId)).resolves.toMatchObject({
        status: 'REFUNDED',
        refunds: [expect.objectContaining({ status: 'SUCCEEDED' })],
      });
    });

    it('leaves a newer paid period and its payment untouched when an old payment is refunded', async () => {
      const { authId, subscriptionId, invoiceId } = await subscriber(40);
      const renewal = api.renewSubscription(subscriptionId).id as string;
      await send(api.signedInvoiceEvent('invoice.paid', renewal)).expect(200);
      const before = await client.userSubscription.findUniqueOrThrow({
        where: { authId },
      });
      const newerPayment = await paymentOf(renewal);
      api.refundInvoice(invoiceId);

      await chargeRefunded(invoiceId).expect(200);

      await expect(paymentOf(invoiceId)).resolves.toMatchObject({
        status: 'REFUNDED',
      });
      await expect(paymentOf(renewal)).resolves.toEqual(newerPayment);
      await expect(
        client.userSubscription.findUniqueOrThrow({ where: { authId } }),
      ).resolves.toEqual(before);
      await expect(harness.status(authId)).resolves.toMatchObject({
        status: 'PRO',
        hasProAccess: true,
      });
    });

    it('grants access again only for a newly paid period after the refund', async () => {
      const { authId, subscriptionId, invoiceId } = await subscriber(10);
      api.refundInvoice(invoiceId);
      await chargeRefunded(invoiceId).expect(200);
      const revoked = await recordOf(authId);

      const renewal = api.renewSubscription(subscriptionId).id as string;
      await send(api.signedInvoiceEvent('invoice.paid', renewal)).expect(200);

      const next = await paymentOf(renewal);
      const record = await recordOf(authId);
      // A new term from the next paid period; the refunded one stays revoked.
      expect(record).toMatchObject({
        proStartedAt: next.periodStart,
        proExpiresAt: next.periodEnd,
      });
      await expect(
        access.hasProAccess(
          authId,
          new Date((revoked.proExpiresAt as Date).getTime() + 1000),
        ),
      ).resolves.toBe(false);
      await expect(access.hasProAccess(authId, next.periodStart)).resolves.toBe(
        true,
      );
      await expect(paymentOf(invoiceId)).resolves.toMatchObject({
        status: 'REFUNDED',
      });
    });

    it('asks Stripe to retry a refund of a payment that is not recorded yet', async () => {
      const { authId, sessionId, invoiceId } = await subscriber(
        10,
        'MONTHLY',
        false,
      );
      api.refundInvoice(invoiceId);

      await chargeRefunded(invoiceId).expect(503);
      await expect(
        client.paymentRefund.count({
          where: { payment: { subscription: { authId } } },
        }),
      ).resolves.toBe(0);

      await send(
        api.signedEvent('checkout.session.completed', sessionId),
      ).expect(200);
      await chargeRefunded(invoiceId).expect(200);

      await expect(paymentOf(invoiceId)).resolves.toMatchObject({
        status: 'REFUNDED',
      });
      await expect(access.hasProAccess(authId)).resolves.toBe(false);
    });
  });

  describe('database rules', () => {
    async function collectedPayment() {
      const { authId, invoiceId } = await subscriber(10);
      const payment = await paymentOf(invoiceId);
      return { authId, payment };
    }
    const refundRow = (
      paymentId: string,
      overrides: Record<string, unknown> = {},
    ) =>
      client.paymentRefund.create({
        data: {
          paymentId,
          provider: 'stripe',
          providerRefundId: `re_${Math.random().toString(36).slice(2)}`,
          providerChargeId: 'ch_test',
          status: 'SUCCEEDED',
          amountCents: 500,
          providerCreatedAt: new Date(),
          ...overrides,
        },
      });

    it('never lets succeeded refunds exceed the payment', async () => {
      const { payment } = await collectedPayment();
      await refundRow(payment.id, { amountCents: 1500 });
      await expect(refundRow(payment.id, { amountCents: 401 })).rejects.toThrow(
        /cannot exceed the payment amount/,
      );
      // Pending refunds do not count yet.
      await expect(
        refundRow(payment.id, { amountCents: 1000, status: 'PENDING' }),
      ).resolves.toBeDefined();
    });

    it('keeps refund facts immutable, statuses final and rows undeletable', async () => {
      const { payment } = await collectedPayment();
      const refund = await refundRow(payment.id);
      await expect(
        client.paymentRefund.update({
          where: { id: refund.id },
          data: { amountCents: 400 },
        }),
      ).rejects.toThrow(/cannot change/);
      await expect(
        client.paymentRefund.update({
          where: { id: refund.id },
          data: { status: 'FAILED' },
        }),
      ).rejects.toThrow(/status cannot change from SUCCEEDED to FAILED/);
      await expect(
        client.paymentRefund.delete({ where: { id: refund.id } }),
      ).rejects.toThrow(/cannot be deleted/);
      await expect(
        refundRow(payment.id, { providerRefundId: refund.providerRefundId }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('only refunds collected payments', async () => {
      const { authId } = await collectedPayment();
      const record = await recordOf(authId);
      const failed = await recordPayment(client, record.id, {
        status: 'FAILED',
        periodStart: new Date('2027-01-01T00:00:00Z'),
        periodEnd: new Date('2027-02-01T00:00:00Z'),
      });
      await expect(refundRow(failed.id)).rejects.toThrow(
        /requires a collected payment/,
      );
    });

    it('keeps the payment refund amount from ever decreasing', async () => {
      const { invoiceId } = await subscriber(10);
      api.refundInvoice(invoiceId, { amount: 700 });
      await chargeRefunded(invoiceId).expect(200);
      const payment = await paymentOf(invoiceId);
      await expect(
        client.paymentTransaction.update({
          where: { id: payment.id },
          data: { refundedAmountCents: 100 },
        }),
      ).rejects.toThrow(/refunded amount cannot decrease/);
      await expect(
        client.paymentTransaction.update({
          where: { id: payment.id },
          data: { status: 'SUCCEEDED', refundedAmountCents: 700 },
        }),
      ).rejects.toThrow(/status cannot change from PARTIALLY_REFUNDED/);
    });
  });
});
