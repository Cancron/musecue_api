import { BillingInterval, PaymentStatus, PrismaClient } from '@prisma/client';
import request from 'supertest';
import {
  addBillingInterval,
  isValidBillingPeriod,
} from '../src/subscription/billing.validation';
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
const seconds = (date: Date) =>
  new Date(Math.floor(date.getTime() / 1000) * 1000);
const iso = (value: string) => new Date(value);

/**
 * Automatic renewals end to end: signed `invoice.paid` webhooks over HTTP,
 * the real services and the migrated PostgreSQL schema, whose CHECK
 * constraint and paid-term trigger must accept exactly the periods Stripe
 * reports and nothing unpaid.
 */
describeWithDatabase('Stripe renewals (PostgreSQL, HTTP)', () => {
  let harness: StripeTestApp;
  let client: PrismaClient;
  let api: FakeStripeApi;

  beforeAll(async () => {
    harness = await createStripeTestApp();
    client = harness.client;
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(() => {
    api = new FakeStripeApi(5);
    harness.stripe.api = api;
  });

  /** Buys Pro through checkout; the first paid period starts at `periodStart`. */
  async function subscribed(
    interval: 'MONTHLY' | 'YEARLY',
    periodStart: Date,
    userId?: string,
  ) {
    const authId = userId ?? (await createUser(client));
    const view = dataOf(
      await harness.startCheckout(authId, interval).expect(201),
    );
    const checkout = await client.checkoutSession.findUniqueOrThrow({
      where: { id: view.checkoutSessionId },
    });
    const sessionId = checkout.providerSessionId as string;
    const session = api.completeSession(sessionId, { periodStart });
    const event = api.signedEvent('checkout.session.completed', sessionId);
    await harness.sendWebhook(event.payload, event.signature).expect(200);
    return {
      authId,
      sessionId,
      subscriptionId: session.subscription as string,
      firstInvoiceId: session.invoice as string,
    };
  }

  const deliverInvoice = (invoiceId: string) => {
    const { payload, signature } = api.signedInvoiceEvent(
      'invoice.paid',
      invoiceId,
    );
    return harness.sendWebhook(payload, signature);
  };
  const renew = (subscriptionId: string) =>
    api.renewSubscription(subscriptionId).id as string;

  const recordOf = (authId: string) =>
    client.userSubscription.findUniqueOrThrow({
      where: { authId },
      include: {
        payments: { orderBy: { periodStart: 'asc' } },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });
  const periodsOf = async (authId: string) =>
    (await recordOf(authId)).payments.map((payment) => [
      payment.periodStart.toISOString(),
      payment.periodEnd.toISOString(),
    ]);

  describe('monthly and yearly renewals', () => {
    it('extends a monthly subscription to the period end Stripe reports and shows it to the user', async () => {
      const start = seconds(new Date(Date.now() - 25 * DAY));
      const { authId, subscriptionId } = await subscribed('MONTHLY', start);
      const firstEnd = (await recordOf(authId)).proExpiresAt as Date;

      const invoiceId = renew(subscriptionId);
      const stripeLine = (
        api.invoices.get(invoiceId)?.lines as {
          data: { period: { start: number; end: number } }[];
        }
      ).data[0].period;
      await deliverInvoice(invoiceId).expect(200);

      const renewedEnd = new Date(stripeLine.end * 1000);
      expect(new Date(stripeLine.start * 1000)).toEqual(firstEnd);
      await expect(harness.status(authId)).resolves.toMatchObject({
        status: 'PRO',
        hasProAccess: true,
        accessExpiresAt: renewedEnd.toISOString(),
        pro: {
          active: true,
          billingInterval: 'MONTHLY',
          startedAt: start.toISOString(),
          expiresAt: renewedEnd.toISOString(),
        },
      });
      const record = await recordOf(authId);
      expect(record.payments).toEqual([
        expect.objectContaining({ periodStart: start, periodEnd: firstEnd }),
        expect.objectContaining({
          provider: 'stripe',
          providerPaymentId: invoiceId,
          status: 'SUCCEEDED',
          amountCents: 1900,
          currency: 'USD',
          billingInterval: 'MONTHLY',
          periodStart: firstEnd,
          periodEnd: renewedEnd,
        }),
      ]);
      expect(record.events.map((event) => event.type)).toEqual([
        'CREATED',
        'RENEWED',
      ]);
      expect(record.events[1].paymentId).toBe(record.payments[1].id);
      await expect(
        client.activityLogEvent.count({
          where: { tableName: 'UserSubscription', recordId: record.id },
        }),
      ).resolves.toBe(2);
    });

    it('follows Stripe month-end anchoring: Jan 31 -> Feb 28 -> Mar 31 -> Apr 30', async () => {
      const { authId, subscriptionId } = await subscribed(
        'MONTHLY',
        iso('2027-01-31T10:00:00.000Z'),
      );
      for (let i = 0; i < 3; i++) {
        await deliverInvoice(renew(subscriptionId)).expect(200);
      }

      await expect(periodsOf(authId)).resolves.toEqual([
        ['2027-01-31T10:00:00.000Z', '2027-02-28T10:00:00.000Z'],
        ['2027-02-28T10:00:00.000Z', '2027-03-31T10:00:00.000Z'],
        ['2027-03-31T10:00:00.000Z', '2027-04-30T10:00:00.000Z'],
        ['2027-04-30T10:00:00.000Z', '2027-05-31T10:00:00.000Z'],
      ]);
      await expect(recordOf(authId)).resolves.toMatchObject({
        proStartedAt: iso('2027-01-31T10:00:00.000Z'),
        proExpiresAt: iso('2027-05-31T10:00:00.000Z'),
      });
    });

    it('extends a yearly subscription, including a leap-day anchor', async () => {
      const { authId, subscriptionId } = await subscribed(
        'YEARLY',
        iso('2028-02-29T12:00:00.000Z'),
      );
      for (let i = 0; i < 3; i++) {
        await deliverInvoice(renew(subscriptionId)).expect(200);
      }

      await expect(periodsOf(authId)).resolves.toEqual([
        ['2028-02-29T12:00:00.000Z', '2029-02-28T12:00:00.000Z'],
        ['2029-02-28T12:00:00.000Z', '2030-02-28T12:00:00.000Z'],
        ['2030-02-28T12:00:00.000Z', '2031-02-28T12:00:00.000Z'],
        ['2031-02-28T12:00:00.000Z', '2032-02-29T12:00:00.000Z'],
      ]);
      const record = await recordOf(authId);
      expect(record).toMatchObject({
        billingInterval: 'YEARLY',
        proExpiresAt: iso('2032-02-29T12:00:00.000Z'),
      });
      expect(record.payments.map((payment) => payment.amountCents)).toEqual([
        19000, 19000, 19000, 19000,
      ]);
      expect(record.events.map((event) => event.type)).toEqual([
        'CREATED',
        'RENEWED',
        'RENEWED',
        'RENEWED',
      ]);
    });

    it('keeps renewing at the purchase price after an admin price change', async () => {
      const { authId, subscriptionId } = await subscribed(
        'MONTHLY',
        seconds(new Date(Date.now() - 10 * DAY)),
      );
      await client.subscriptionPlan.upsert({
        where: { code: 'PRO' },
        create: { code: 'PRO', monthlyPriceUsdCents: 2900 },
        update: { monthlyPriceUsdCents: 2900 },
      });
      try {
        await deliverInvoice(renew(subscriptionId)).expect(200);
        const record = await recordOf(authId);
        expect(record.payments.map((payment) => payment.amountCents)).toEqual([
          1900, 1900,
        ]);
        expect(record.events.map((event) => event.type)).toEqual([
          'CREATED',
          'RENEWED',
        ]);
      } finally {
        await client.subscriptionPlan.deleteMany();
      }
    });

    it('keeps the free trial history when a former trial user renews', async () => {
      const authId = await createUser(client);
      const trial = await request(harness.app.getHttpServer())
        .post('/v1/subscription/trial')
        .set('Authorization', harness.bearer(authId))
        .expect(201);
      const before = await recordOf(authId);
      const { subscriptionId } = await subscribed(
        'MONTHLY',
        seconds(new Date()),
        authId,
      );

      await deliverInvoice(renew(subscriptionId)).expect(200);

      const after = await recordOf(authId);
      expect(after).toMatchObject({
        trialUsed: true,
        trialStartedAt: before.trialStartedAt,
        trialExpiresAt: before.trialExpiresAt,
      });
      expect(dataOf(trial).trialStartedAt).toBe(
        before.trialStartedAt?.toISOString(),
      );
      expect(after.events.map((event) => event.type)).toEqual([
        'CREATED',
        'RENEWED',
      ]);
    });
  });

  describe('duplicate and delayed events', () => {
    it('records one payment and one renewal for concurrent duplicate deliveries', async () => {
      const { authId, subscriptionId } = await subscribed(
        'MONTHLY',
        seconds(new Date(Date.now() - 5 * DAY)),
      );
      const invoiceId = renew(subscriptionId);

      const responses = await Promise.all(
        Array.from({ length: 8 }, () => deliverInvoice(invoiceId)),
      );

      expect(responses.map((response) => response.status)).toEqual(
        Array(8).fill(200),
      );
      const record = await recordOf(authId);
      expect(record.payments).toHaveLength(2);
      expect(record.events.map((event) => event.type)).toEqual([
        'CREATED',
        'RENEWED',
      ]);
    });

    it('does not double count a mix of redelivered checkout and invoice events', async () => {
      const { authId, sessionId, subscriptionId, firstInvoiceId } =
        await subscribed('YEARLY', seconds(new Date(Date.now() - DAY)));
      const renewal = renew(subscriptionId);

      const redeliveries = [
        api.signedEvent('checkout.session.completed', sessionId),
        api.signedEvent('checkout.session.async_payment_succeeded', sessionId),
        api.signedInvoiceEvent('invoice.paid', firstInvoiceId),
        api.signedInvoiceEvent('invoice.paid', renewal),
        api.signedInvoiceEvent('invoice.paid', renewal),
        api.signedEvent('checkout.session.completed', sessionId),
      ];
      await Promise.all(
        redeliveries.map(({ payload, signature }) =>
          harness.sendWebhook(payload, signature).expect(200),
        ),
      );

      const record = await recordOf(authId);
      expect(
        record.payments.map((payment) => payment.providerPaymentId),
      ).toEqual([firstInvoiceId, renewal]);
      expect(record.events.map((event) => event.type)).toEqual([
        'CREATED',
        'RENEWED',
      ]);
    });

    it('restores access from the old expiry when the renewal event arrives after the term lapsed', async () => {
      const start = seconds(new Date(Date.now() - 40 * DAY));
      const { authId, subscriptionId } = await subscribed('MONTHLY', start);
      const lapsedAt = (await recordOf(authId)).proExpiresAt as Date;
      await expect(harness.status(authId)).resolves.toMatchObject({
        status: 'EXPIRED',
        hasProAccess: false,
      });

      await deliverInvoice(renew(subscriptionId)).expect(200);

      const record = await recordOf(authId);
      expect(record.proStartedAt).toEqual(start);
      expect(record.payments[1].periodStart).toEqual(lapsedAt);
      await expect(harness.status(authId)).resolves.toMatchObject({
        status: 'PRO',
        hasProAccess: true,
        accessExpiresAt: (record.proExpiresAt as Date).toISOString(),
      });
    });

    it('never lets an older delayed renewal overwrite a newer period', async () => {
      const { authId, subscriptionId } = await subscribed(
        'MONTHLY',
        iso('2027-01-31T10:00:00.000Z'),
      );
      const older = renew(subscriptionId);
      const newer = renew(subscriptionId);

      await deliverInvoice(newer).expect(200);
      const afterNewer = await client.userSubscription.findUniqueOrThrow({
        where: { authId },
      });
      await deliverInvoice(older).expect(200);

      const record = await recordOf(authId);
      expect(record).toMatchObject({
        proStartedAt: afterNewer.proStartedAt,
        proExpiresAt: iso('2027-04-30T10:00:00.000Z'),
        updatedAt: afterNewer.updatedAt,
      });
      expect(
        record.payments.map((payment) => payment.providerPaymentId),
      ).toEqual(expect.arrayContaining([older, newer]));
      expect(record.payments).toHaveLength(3);
    });

    it('does not extend access for an invoice that Stripe reports as unpaid', async () => {
      const { authId, subscriptionId } = await subscribed(
        'MONTHLY',
        seconds(new Date(Date.now() - 5 * DAY)),
      );
      const before = await client.userSubscription.findUniqueOrThrow({
        where: { authId },
      });
      const unpaid = api.renewSubscription(subscriptionId, { paid: false });
      const { payload, signature } = api.signedInvoiceEvent(
        'invoice.paid',
        unpaid.id as string,
        { status: 'paid', amount_paid: 1900 },
      );

      await harness.sendWebhook(payload, signature).expect(200);

      await expect(
        client.userSubscription.findUniqueOrThrow({ where: { authId } }),
      ).resolves.toEqual(before);
      await expect(recordOf(authId)).resolves.toMatchObject({
        payments: [expect.objectContaining({ status: 'SUCCEEDED' })],
      });
    });

    it('rejects an unsigned renewal event', async () => {
      const { authId, subscriptionId } = await subscribed(
        'MONTHLY',
        seconds(new Date()),
      );
      const { payload } = api.signedInvoiceEvent(
        'invoice.paid',
        renew(subscriptionId),
      );

      await harness.sendWebhook(payload, 't=1,v1=forged').expect(400);
      await expect(recordOf(authId)).resolves.toMatchObject({
        payments: [expect.anything()],
      });
    });
  });

  describe('database rules for Stripe periods', () => {
    async function subscriptionId() {
      const authId = await createUser(client);
      return (await client.userSubscription.create({ data: { authId } })).id;
    }

    it('accepts Stripe anchored periods and still rejects non-billing periods', async () => {
      const id = await subscriptionId();
      const attempt = (interval: BillingInterval, start: string, end: string) =>
        recordPayment(client, id, {
          billingInterval: interval,
          status: PaymentStatus.FAILED,
          periodStart: iso(start),
          periodEnd: iso(end),
        });

      await expect(
        attempt('MONTHLY', '2026-02-28T10:00:00Z', '2026-03-31T10:00:00Z'),
      ).resolves.toBeDefined();
      await expect(
        attempt('YEARLY', '2027-02-28T12:00:00Z', '2028-02-29T12:00:00Z'),
      ).resolves.toBeDefined();
      for (const [interval, start, end] of [
        ['MONTHLY', '2026-03-01T00:00:00Z', '2026-03-29T00:00:00Z'],
        ['MONTHLY', '2026-02-27T10:00:00Z', '2026-03-31T10:00:00Z'],
        ['MONTHLY', '2026-02-28T10:00:00Z', '2026-03-31T10:30:00Z'],
        ['MONTHLY', '2026-02-28T10:00:00Z', '2026-04-30T10:00:00Z'],
        ['YEARLY', '2028-02-29T00:00:00Z', '2029-03-01T00:00:00Z'],
      ] as const) {
        await expect(attempt(interval, start, end)).rejects.toThrow(
          /PaymentTransaction_billing_period/,
        );
      }
    });

    it('applies the same period rule as isValidBillingPeriod', async () => {
      const cases: { start: Date; end: Date; interval: BillingInterval }[] = [];
      for (let day = 0; day < 430; day += 1) {
        const start = new Date(Date.UTC(2027, 0, 1 + day, 10, 30, 15));
        for (const interval of ['MONTHLY', 'YEARLY'] as const) {
          const calendar = addBillingInterval(start, interval);
          for (const shiftDays of [-1, 0, 1, 2, 3, 31]) {
            cases.push({
              start,
              end: new Date(calendar.getTime() + shiftDays * DAY),
              interval,
            });
          }
          cases.push({
            start,
            end: new Date(calendar.getTime() + 1000),
            interval,
          });
        }
      }
      const rows = await client.$queryRawUnsafe<{ valid: boolean }[]>(
        `SELECT "billing_period_is_valid"(s, e,
            CASE i WHEN 'MONTHLY' THEN interval '1 month' ELSE interval '1 year' END) AS valid
           FROM unnest($1::timestamp(3)[], $2::timestamp(3)[], $3::text[]) AS t(s, e, i)`,
        cases.map((c) => c.start),
        cases.map((c) => c.end),
        cases.map((c) => c.interval),
      );
      const mismatches = cases.filter(
        (c, index) =>
          isValidBillingPeriod(c.start, c.end, c.interval) !==
          rows[index].valid,
      );
      expect(mismatches).toEqual([]);
      // The sample includes both kinds of valid period.
      expect(rows.filter((row) => row.valid).length).toBeGreaterThan(860);
    });

    it('does not let a Stripe renewal period extend the term without a SUCCEEDED payment', async () => {
      const { authId } = await subscribed(
        'MONTHLY',
        iso('2027-01-31T10:00:00.000Z'),
      );
      const record = await client.userSubscription.findUniqueOrThrow({
        where: { authId },
      });
      await recordPayment(client, record.id, {
        status: PaymentStatus.PENDING,
        periodStart: iso('2027-02-28T10:00:00.000Z'),
        periodEnd: iso('2027-03-31T10:00:00.000Z'),
      });

      await expect(
        client.userSubscription.update({
          where: { authId },
          data: { proExpiresAt: iso('2027-03-31T10:00:00.000Z') },
        }),
      ).rejects.toThrow(/requires a verified \(SUCCEEDED\) payment/);
    });
  });
});
