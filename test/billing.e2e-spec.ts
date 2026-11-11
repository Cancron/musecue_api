import { PrismaPg } from '@prisma/adapter-pg';
import { BillingInterval, PaymentStatus, PrismaClient } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import { ActivityLogService } from '../src/common/services/activity-log.service';
import type { CustomLoggerService } from '../src/common/services/custom-logger.service';
import type { PrismaService } from '../src/common/services/prisma.service';
import {
  addBillingInterval,
  planPriceCents,
  validateNewPayment,
} from '../src/subscription/billing.validation';
import { SubscriptionAccessService } from '../src/subscription/subscription-access.service';
import { SubscriptionPlanService } from '../src/subscription/subscription-plan.service';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';
import {
  createUser,
  daysFrom,
  givenFreeRecord,
  givenProPurchased,
  givenProRenewed,
  recordPayment,
} from './support/subscription-fixtures';

jest.setTimeout(120_000);

const { MONTHLY, YEARLY } = BillingInterval;

/**
 * Payment and subscription-event models against PostgreSQL (migration
 * 20260918120000_add_payments_and_subscription_events).
 */
describeWithDatabase('Payments and subscription events (PostgreSQL)', () => {
  let schema: string;
  let client: PrismaClient;
  let plans: SubscriptionPlanService;
  let access: SubscriptionAccessService;
  let adminId: string;
  const T0 = new Date('2026-03-01T09:30:00.000Z');
  const month = (start: Date) => addBillingInterval(start, MONTHLY);
  const year = (start: Date) => addBillingInterval(start, YEARLY);

  const connect = () => {
    client = new PrismaClient({
      adapter: new PrismaPg(
        { connectionString: TEST_DATABASE_URL as string },
        { schema },
      ),
    });
    const prisma = client as unknown as PrismaService;
    plans = new SubscriptionPlanService(
      prisma,
      new ActivityLogService(prisma, mock<CustomLoggerService>()),
    );
    access = new SubscriptionAccessService(prisma, plans);
  };

  /** A user with an empty subscription record. */
  const newSubscriber = async () => {
    const authId = await createUser(client);
    const subscription = await givenFreeRecord(client, authId);
    return { authId, subscriptionId: subscription.id };
  };

  /** Sets a paid term directly, as a buggy or future writer might. */
  const setTerm = (
    authId: string,
    term: { billingInterval: BillingInterval; start: Date; end: Date },
  ) =>
    client.userSubscription.update({
      where: { authId },
      data: {
        status: 'PRO',
        billingInterval: term.billingInterval,
        proStartedAt: term.start,
        proExpiresAt: term.end,
      },
    });

  beforeAll(async () => {
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    connect();
    adminId = await createUser(client);
  });

  afterAll(async () => {
    await client?.$disconnect();
    if (schema) await dropSchema(schema);
  });

  describe('model relationships', () => {
    it('links user -> subscription -> payments and events, and payment <-> event', async () => {
      const { authId, subscriptionId } = await newSubscriber();
      await givenProPurchased(client, authId, {
        billingInterval: MONTHLY,
        startedAt: T0,
        expiresAt: month(T0),
      });

      const user = await client.authUser.findUniqueOrThrow({
        where: { id: authId },
        include: {
          subscription: {
            include: {
              payments: { include: { event: true } },
              events: { include: { payment: true } },
            },
          },
        },
      });
      const subscription = user.subscription!;
      expect(subscription.id).toBe(subscriptionId);
      expect(subscription.payments).toHaveLength(1);
      expect(subscription.events).toHaveLength(1);
      expect(subscription.payments[0].event?.id).toBe(
        subscription.events[0].id,
      );
      expect(subscription.events[0]).toMatchObject({
        type: 'CREATED',
        payment: { id: subscription.payments[0].id, status: 'SUCCEEDED' },
      });
    });

    it('rejects a payment or event for a subscription that does not exist', async () => {
      await expect(
        recordPayment(client, 'missing', {
          periodStart: T0,
          periodEnd: month(T0),
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      await expect(
        client.subscriptionEvent.create({
          data: { subscriptionId: 'missing', type: 'CANCELED', occurredAt: T0 },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('keeps payments as financial records: a user with payments cannot be hard-deleted', async () => {
      const { authId } = await newSubscriber();
      await givenProPurchased(client, authId, {
        billingInterval: MONTHLY,
        startedAt: T0,
        expiresAt: month(T0),
      });
      await expect(
        client.authUser.delete({ where: { id: authId } }),
      ).rejects.toThrow();
      await expect(
        client.paymentTransaction.count({
          where: { subscription: { authId } },
        }),
      ).resolves.toBe(1);
    });

    it('still deletes a user without payments together with their subscription events', async () => {
      const { authId, subscriptionId } = await newSubscriber();
      await client.subscriptionEvent.create({
        data: { subscriptionId, type: 'TRIAL_STARTED', occurredAt: T0 },
      });
      await client.authUser.delete({ where: { id: authId } });
      await expect(
        client.subscriptionEvent.count({ where: { subscriptionId } }),
      ).resolves.toBe(0);
    });

    it('requires a payment exactly for CREATED and RENEWED events', async () => {
      const { subscriptionId } = await newSubscriber();
      const payment = await recordPayment(client, subscriptionId, {
        periodStart: T0,
        periodEnd: month(T0),
      });
      for (const type of ['CREATED', 'RENEWED'] as const) {
        await expect(
          client.subscriptionEvent.create({
            data: { subscriptionId, type, occurredAt: T0 },
          }),
        ).rejects.toThrow(/SubscriptionEvent_payment_matches_type/);
      }
      for (const type of ['TRIAL_STARTED', 'CANCELED', 'EXPIRED'] as const) {
        await expect(
          client.subscriptionEvent.create({
            data: {
              subscriptionId,
              type,
              paymentId: payment.id,
              occurredAt: T0,
            },
          }),
        ).rejects.toThrow(/SubscriptionEvent_payment_matches_type/);
      }
    });

    it('links a provider subscription ID to at most one of our subscriptions', async () => {
      const a = await newSubscriber();
      const b = await newSubscriber();
      const link = {
        paymentProvider: 'stripe',
        providerSubscriptionId: 'sub_1',
      };
      await client.userSubscription.update({
        where: { authId: a.authId },
        data: link,
      });
      await expect(
        client.userSubscription.update({
          where: { authId: b.authId },
          data: link,
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      await expect(
        client.userSubscription.update({
          where: { authId: b.authId },
          data: { providerSubscriptionId: 'sub_2' },
        }),
      ).rejects.toThrow(/UserSubscription_provider_link/);
    });
  });

  describe('billing periods (calendar expiry)', () => {
    const at = (iso: string) => new Date(`${iso}Z`);
    const attempt = async (
      billingInterval: BillingInterval,
      start: string,
      end: string,
    ) => {
      const { subscriptionId } = await newSubscriber();
      return recordPayment(client, subscriptionId, {
        billingInterval,
        status: PaymentStatus.FAILED,
        periodStart: at(start),
        periodEnd: at(end),
      });
    };

    it.each([
      [MONTHLY, '2026-03-01T00:00:00', '2026-04-01T00:00:00'],
      [MONTHLY, '2026-01-31T00:00:00', '2026-02-28T00:00:00'],
      [MONTHLY, '2028-01-31T00:00:00', '2028-02-29T00:00:00'],
      [MONTHLY, '2026-03-31T10:15:00', '2026-04-30T10:15:00'],
      [MONTHLY, '2026-12-31T23:59:59.999', '2027-01-31T23:59:59.999'],
      [YEARLY, '2026-03-01T00:00:00', '2027-03-01T00:00:00'],
      [YEARLY, '2027-03-01T00:00:00', '2028-03-01T00:00:00'],
      [YEARLY, '2028-02-29T12:00:00', '2029-02-28T12:00:00'],
    ])(
      'accepts the %s calendar period %s -> %s',
      async (interval, start, end) => {
        await expect(attempt(interval, start, end)).resolves.toBeDefined();
      },
    );

    // Regression: the previous 28-31 / 365-366 day range accepted all of these
    // except the 1 ms case, which is kept as an exactness check.
    it.each([
      [MONTHLY, '2026-03-01T00:00:00', '2026-03-29T00:00:00'],
      [MONTHLY, '2026-03-01T00:00:00', '2026-03-31T00:00:00'],
      [MONTHLY, '2026-01-31T00:00:00', '2026-03-03T00:00:00'],
      [MONTHLY, '2028-01-31T00:00:00', '2028-02-28T00:00:00'],
      [MONTHLY, '2026-03-01T00:00:00', '2026-04-01T00:00:00.001'],
      [YEARLY, '2026-03-01T00:00:00', '2027-03-02T00:00:00'],
      [YEARLY, '2027-03-01T00:00:00', '2028-02-29T00:00:00'],
      [YEARLY, '2028-02-29T00:00:00', '2029-03-01T00:00:00'],
    ])(
      'rejects the non-calendar %s period %s -> %s',
      async (interval, start, end) => {
        await expect(attempt(interval, start, end)).rejects.toThrow(
          /PaymentTransaction_billing_period/,
        );
      },
    );

    it('computes the same expiry as the database for every start time across two years', async () => {
      const starts = Array.from(
        { length: 731 },
        (_, i) => new Date(Date.UTC(2027, 0, 1 + i, 23, 45, 12, 345)),
      );
      const rows = await client.$queryRawUnsafe<
        { start: Date; month: Date; year: Date }[]
      >(
        `SELECT s AS start, s + interval '1 month' AS month, s + interval '1 year' AS year
           FROM unnest($1::timestamp(3)[]) AS s`,
        starts,
      );
      expect(rows).toHaveLength(starts.length);
      for (const row of rows) {
        expect(addBillingInterval(row.start, MONTHLY)).toEqual(row.month);
        expect(addBillingInterval(row.start, YEARLY)).toEqual(row.year);
      }
    });
  });

  describe('pricing', () => {
    it('validates amounts against the plan price stored in the database, including admin changes', async () => {
      const base = {
        provider: 'stripe',
        providerPaymentId: 'pi_price',
        currency: 'USD',
        periodStart: T0,
      };
      const monthly = {
        ...base,
        billingInterval: MONTHLY,
        periodEnd: month(T0),
      };
      const yearly = { ...base, billingInterval: YEARLY, periodEnd: year(T0) };

      let plan = await plans.getProPlan();
      expect(planPriceCents(plan, MONTHLY)).toBe(1900);
      expect(planPriceCents(plan, YEARLY)).toBe(19000);
      expect(
        validateNewPayment({ ...monthly, amountCents: 1900 }, plan),
      ).toEqual([]);
      expect(
        validateNewPayment({ ...yearly, amountCents: 19000 }, plan),
      ).toEqual([]);

      await plans.updateProPlan(
        { monthlyPriceUsdCents: 2400, yearlyPriceUsdCents: 24000 },
        { actionedBy: adminId },
      );
      plan = await plans.getProPlan();
      expect(
        validateNewPayment({ ...monthly, amountCents: 1900 }, plan),
      ).toEqual(['AMOUNT_DOES_NOT_MATCH_PRICE']);
      expect(
        validateNewPayment({ ...yearly, amountCents: 24000 }, plan),
      ).toEqual([]);
      await client.subscriptionPlan.deleteMany();
    });

    it('keeps the amount actually charged after the plan price changes', async () => {
      const { subscriptionId } = await newSubscriber();
      const payment = await recordPayment(client, subscriptionId, {
        periodStart: T0,
        periodEnd: month(T0),
        amountCents: 1900,
      });
      await plans.updateProPlan(
        { monthlyPriceUsdCents: 2900 },
        { actionedBy: adminId },
      );
      await expect(
        client.paymentTransaction.findUniqueOrThrow({
          where: { id: payment.id },
        }),
      ).resolves.toMatchObject({ amountCents: 1900, currency: 'USD' });
      await client.subscriptionPlan.deleteMany();
    });

    it.each([
      [
        'a zero amount',
        { amountCents: 0 },
        /PaymentTransaction_amount_positive/,
      ],
      [
        'a negative amount',
        { amountCents: -1900 },
        /PaymentTransaction_amount_positive/,
      ],
      [
        'a malformed currency',
        { currency: 'usd' },
        /PaymentTransaction_currency_format/,
      ],
      [
        'a blank provider payment ID',
        { providerPaymentId: ' ' },
        /PaymentTransaction_provider_ids_present/,
      ],
    ])('rejects %s', async (_case, overrides, error) => {
      const { subscriptionId } = await newSubscriber();
      await expect(
        client.paymentTransaction.create({
          data: {
            subscriptionId,
            provider: 'stripe',
            providerPaymentId: 'pi_x',
            amountCents: 1900,
            billingInterval: MONTHLY,
            periodStart: T0,
            periodEnd: month(T0),
            ...overrides,
          },
        }),
      ).rejects.toThrow(error);
    });
  });

  describe('transaction uniqueness', () => {
    it('records each provider transaction once', async () => {
      const a = await newSubscriber();
      const b = await newSubscriber();
      const same = {
        provider: 'stripe',
        providerPaymentId: 'pi_dup',
        periodStart: T0,
        periodEnd: month(T0),
      };
      await recordPayment(client, a.subscriptionId, same);
      await expect(
        recordPayment(client, a.subscriptionId, same),
      ).rejects.toMatchObject({ code: 'P2002' });
      await expect(
        recordPayment(client, b.subscriptionId, same),
      ).rejects.toMatchObject({ code: 'P2002' });
      await expect(
        recordPayment(client, b.subscriptionId, {
          ...same,
          provider: 'paypal',
        }),
      ).resolves.toBeDefined();
    });

    it('allows only one verified payment per billing period, but retries after failures and refunds', async () => {
      const { subscriptionId } = await newSubscriber();
      const period = { periodStart: T0, periodEnd: month(T0) };
      await recordPayment(client, subscriptionId, {
        ...period,
        status: PaymentStatus.FAILED,
      });
      await recordPayment(client, subscriptionId, {
        ...period,
        status: PaymentStatus.REFUNDED,
      });
      await recordPayment(client, subscriptionId, {
        ...period,
        status: PaymentStatus.PENDING,
      });
      await recordPayment(client, subscriptionId, period);
      await expect(
        recordPayment(client, subscriptionId, period),
      ).rejects.toMatchObject({ code: 'P2002' });
      await expect(
        recordPayment(client, subscriptionId, {
          ...period,
          status: PaymentStatus.PARTIALLY_REFUNDED,
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('lets one payment back only one lifecycle event', async () => {
      const { subscriptionId } = await newSubscriber();
      const payment = await recordPayment(client, subscriptionId, {
        periodStart: T0,
        periodEnd: month(T0),
      });
      await client.subscriptionEvent.create({
        data: {
          subscriptionId,
          type: 'CREATED',
          paymentId: payment.id,
          occurredAt: T0,
        },
      });
      await expect(
        client.subscriptionEvent.create({
          data: {
            subscriptionId,
            type: 'RENEWED',
            paymentId: payment.id,
            occurredAt: T0,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  describe('payment records', () => {
    const pending = async () => {
      const { subscriptionId } = await newSubscriber();
      return recordPayment(client, subscriptionId, {
        status: PaymentStatus.PENDING,
        periodStart: T0,
        periodEnd: month(T0),
      });
    };
    const update = (id: string, data: object) =>
      client.paymentTransaction.update({ where: { id }, data });

    it('moves PENDING -> SUCCEEDED -> PARTIALLY_REFUNDED -> REFUNDED', async () => {
      const payment = await pending();
      await update(payment.id, { status: 'SUCCEEDED', paidAt: T0 });
      await update(payment.id, {
        status: 'PARTIALLY_REFUNDED',
        refundedAmountCents: 500,
        refundedAt: daysFrom(T0, 1),
      });
      await expect(
        update(payment.id, {
          status: 'REFUNDED',
          refundedAmountCents: 1900,
          refundedAt: daysFrom(T0, 2),
        }),
      ).resolves.toMatchObject({
        status: 'REFUNDED',
        refundedAmountCents: 1900,
      });
    });

    it('records a failure with its error details', async () => {
      const payment = await pending();
      await expect(
        update(payment.id, {
          status: 'FAILED',
          failedAt: T0,
          failureCode: 'card_declined',
          failureMessage: 'Your card was declined.',
        }),
      ).resolves.toMatchObject({
        status: 'FAILED',
        failureCode: 'card_declined',
      });
    });

    it.each([
      [
        'FAILED -> SUCCEEDED',
        { status: 'FAILED', failedAt: T0 },
        { status: 'SUCCEEDED', paidAt: T0, failedAt: null },
      ],
      [
        'SUCCEEDED -> PENDING',
        { status: 'SUCCEEDED', paidAt: T0 },
        { status: 'PENDING' },
      ],
      [
        'SUCCEEDED -> FAILED',
        { status: 'SUCCEEDED', paidAt: T0 },
        { status: 'FAILED', failedAt: T0 },
      ],
    ])('rejects the status change %s', async (_case, first, second) => {
      const payment = await pending();
      await update(payment.id, first);
      await expect(update(payment.id, second)).rejects.toThrow(
        /status cannot change/,
      );
    });

    it.each([
      ['the amount', { amountCents: 100 }],
      ['the currency', { currency: 'EUR' }],
      ['the provider payment ID', { providerPaymentId: 'pi_other' }],
      ['the period', { periodEnd: daysFrom(T0, 29) }],
    ])('rejects changing %s', async (_case, data) => {
      const payment = await pending();
      await expect(update(payment.id, data)).rejects.toThrow(/cannot change/);
    });

    it.each([
      ['SUCCEEDED without a payment time', { status: 'SUCCEEDED' }],
      ['FAILED without a failure time', { status: 'FAILED' }],
      [
        'REFUNDED for less than the amount',
        { status: 'REFUNDED', refundedAt: T0, refundedAmountCents: 100 },
      ],
      [
        'a refund larger than the amount',
        { status: 'REFUNDED', refundedAt: T0, refundedAmountCents: 5000 },
      ],
    ])('rejects %s', async (_case, data) => {
      const payment = await pending();
      if (data.status === 'REFUNDED') {
        // Start from a verified payment so only the refund rules can reject.
        await update(payment.id, { status: 'SUCCEEDED', paidAt: T0 });
      }
      await expect(update(payment.id, data)).rejects.toThrow(
        /PaymentTransaction_(status_consistent|refund_amount)/,
      );
    });

    it('never deletes a payment', async () => {
      const payment = await pending();
      await expect(
        client.paymentTransaction.delete({ where: { id: payment.id } }),
      ).rejects.toThrow(/cannot be deleted/);
    });
  });

  describe('subscription lifecycle', () => {
    it('purchase, renewal, cancellation and expiry: access follows the paid periods and events are append-only', async () => {
      const { authId, subscriptionId } = await newSubscriber();
      const p1End = month(T0);
      const p2End = month(p1End);

      // Created: pending -> verified -> term -> event.
      const first = await recordPayment(client, subscriptionId, {
        status: PaymentStatus.PENDING,
        periodStart: T0,
        periodEnd: p1End,
      });
      await client.paymentTransaction.update({
        where: { id: first.id },
        data: { status: 'SUCCEEDED', paidAt: T0 },
      });
      await setTerm(authId, {
        billingInterval: MONTHLY,
        start: T0,
        end: p1End,
      });
      await client.subscriptionEvent.create({
        data: {
          subscriptionId,
          type: 'CREATED',
          paymentId: first.id,
          occurredAt: T0,
        },
      });
      await expect(access.hasProAccess(authId, daysFrom(T0, 10))).resolves.toBe(
        true,
      );

      // Renewed with a verified payment for the next period.
      await givenProRenewed(client, authId, {
        billingInterval: MONTHLY,
        periodStart: p1End,
        periodEnd: p2End,
      });
      await expect(
        access.getAccess(authId, daysFrom(p1End, 1)),
      ).resolves.toMatchObject({
        status: 'PRO',
        accessExpiresAt: p2End,
      });

      // Canceled: access continues to the end of the paid period.
      const canceledAt = daysFrom(p1End, 3);
      await client.userSubscription.update({
        where: { authId },
        data: { proCanceledAt: canceledAt },
      });
      await client.subscriptionEvent.create({
        data: { subscriptionId, type: 'CANCELED', occurredAt: canceledAt },
      });
      await expect(
        access.hasProAccess(authId, new Date(p2End.getTime() - 1)),
      ).resolves.toBe(true);

      // Expired at the exact end of the paid period.
      await expect(access.getAccess(authId, p2End)).resolves.toMatchObject({
        status: 'EXPIRED',
        hasProAccess: false,
      });
      await client.userSubscription.update({
        where: { authId },
        data: { status: 'EXPIRED' },
      });
      await client.subscriptionEvent.create({
        data: { subscriptionId, type: 'EXPIRED', occurredAt: p2End },
      });

      const events = await client.subscriptionEvent.findMany({
        where: { subscriptionId },
        orderBy: { occurredAt: 'asc' },
      });
      expect(events.map((e) => e.type)).toEqual([
        'CREATED',
        'RENEWED',
        'CANCELED',
        'EXPIRED',
      ]);

      await expect(
        client.subscriptionEvent.update({
          where: { id: events[0].id },
          data: { occurredAt: daysFrom(T0, 1) },
        }),
      ).rejects.toThrow(/cannot be changed/);
      await expect(
        client.subscriptionEvent.delete({ where: { id: events[3].id } }),
      ).rejects.toThrow(/cannot be deleted/);
    });

    it('switches from monthly to yearly on renewal', async () => {
      const { authId } = await newSubscriber();
      await givenProPurchased(client, authId, {
        billingInterval: MONTHLY,
        startedAt: T0,
        expiresAt: month(T0),
      });
      await givenProRenewed(client, authId, {
        billingInterval: YEARLY,
        periodStart: month(T0),
        periodEnd: year(month(T0)),
      });
      await expect(
        access.getAccess(authId, daysFrom(T0, 200)),
      ).resolves.toMatchObject({
        status: 'PRO',
        accessExpiresAt: year(month(T0)),
      });
    });

    it('allows cancelling and shortening a term without a payment, since neither grants access', async () => {
      const { authId } = await newSubscriber();
      await givenProPurchased(client, authId, {
        billingInterval: MONTHLY,
        startedAt: T0,
        expiresAt: month(T0),
      });
      await expect(
        client.userSubscription.update({
          where: { authId },
          data: {
            proCanceledAt: daysFrom(T0, 1),
            proExpiresAt: daysFrom(T0, 5),
          },
        }),
      ).resolves.toMatchObject({ proExpiresAt: daysFrom(T0, 5) });
    });
  });

  describe('database persistence', () => {
    it('keeps payments, events and the paid term across a reconnect', async () => {
      const { authId, subscriptionId } = await newSubscriber();
      await givenProPurchased(client, authId, {
        billingInterval: YEARLY,
        startedAt: T0,
        expiresAt: year(T0),
      });
      await client.$disconnect();
      connect();

      await expect(
        client.userSubscription.findUniqueOrThrow({
          where: { id: subscriptionId },
          include: { payments: true, events: true },
        }),
      ).resolves.toMatchObject({
        billingInterval: 'YEARLY',
        proStartedAt: T0,
        proExpiresAt: year(T0),
        payments: [
          {
            status: 'SUCCEEDED',
            amountCents: 19000,
            currency: 'USD',
            periodEnd: year(T0),
          },
        ],
        events: [{ type: 'CREATED' }],
      });
      await expect(
        access.hasProAccess(authId, daysFrom(T0, 100)),
      ).resolves.toBe(true);
    });
  });

  describe('access restrictions for non-verified payments', () => {
    it.each([
      PaymentStatus.PENDING,
      PaymentStatus.FAILED,
      PaymentStatus.REFUNDED,
      PaymentStatus.PARTIALLY_REFUNDED,
    ])(
      'a %s payment cannot start a paid term, and the user has no Pro access',
      async (status) => {
        const { authId, subscriptionId } = await newSubscriber();
        await recordPayment(client, subscriptionId, {
          status,
          periodStart: T0,
          periodEnd: month(T0),
        });

        await expect(
          setTerm(authId, {
            billingInterval: MONTHLY,
            start: T0,
            end: month(T0),
          }),
        ).rejects.toThrow(/requires a verified \(SUCCEEDED\) payment/);
        await expect(
          access.getAccess(authId, daysFrom(T0, 1)),
        ).resolves.toMatchObject({
          status: 'FREE',
          hasProAccess: false,
        });
      },
    );

    it('a pending renewal does not extend access; it ends with the last verified period', async () => {
      const { authId, subscriptionId } = await newSubscriber();
      const p1End = month(T0);
      await givenProPurchased(client, authId, {
        billingInterval: MONTHLY,
        startedAt: T0,
        expiresAt: p1End,
      });
      await recordPayment(client, subscriptionId, {
        status: PaymentStatus.PENDING,
        periodStart: p1End,
        periodEnd: month(p1End),
      });

      await expect(
        client.userSubscription.update({
          where: { authId },
          data: { proExpiresAt: month(p1End) },
        }),
      ).rejects.toThrow(/requires a verified/);
      await expect(
        access.hasProAccess(authId, new Date(p1End.getTime() - 1)),
      ).resolves.toBe(true);
      await expect(access.hasProAccess(authId, p1End)).resolves.toBe(false);
    });

    it('a failed renewal does not extend access', async () => {
      const { authId, subscriptionId } = await newSubscriber();
      const p1End = month(T0);
      await givenProPurchased(client, authId, {
        billingInterval: MONTHLY,
        startedAt: T0,
        expiresAt: p1End,
      });
      await recordPayment(client, subscriptionId, {
        status: PaymentStatus.FAILED,
        periodStart: p1End,
        periodEnd: month(p1End),
      });
      await expect(
        client.userSubscription.update({
          where: { authId },
          data: { proExpiresAt: month(p1End) },
        }),
      ).rejects.toThrow(/requires a verified/);
      await expect(access.hasProAccess(authId, p1End)).resolves.toBe(false);
    });

    it.each([
      ['another user’s verified payment', 'other'],
      ['a verified payment for a different period end', 'period'],
      ['a verified payment with a different billing interval', 'interval'],
    ])('rejects a paid term backed by %s', async (_case, mismatch) => {
      const { authId, subscriptionId } = await newSubscriber();
      const other = await newSubscriber();
      const end = month(T0);
      await recordPayment(
        client,
        mismatch === 'other' ? other.subscriptionId : subscriptionId,
        {
          billingInterval: mismatch === 'interval' ? YEARLY : MONTHLY,
          periodStart: T0,
          periodEnd: mismatch === 'interval' ? year(T0) : end,
        },
      );
      const termEnd =
        mismatch === 'period'
          ? daysFrom(end, -1)
          : mismatch === 'interval'
            ? year(T0)
            : end;
      await expect(
        setTerm(authId, { billingInterval: MONTHLY, start: T0, end: termEnd }),
      ).rejects.toThrow(/requires a verified/);
    });

    it('cannot create a paid term in the same insert as the record (no payment can exist yet)', async () => {
      const authId = await createUser(client);
      await expect(
        client.userSubscription.create({
          data: {
            authId,
            status: 'PRO',
            billingInterval: MONTHLY,
            proStartedAt: T0,
            proExpiresAt: month(T0),
          },
        }),
      ).rejects.toThrow(/requires a verified/);
    });

    it.each([PaymentStatus.PENDING, PaymentStatus.FAILED])(
      'a CREATED or RENEWED event cannot reference a %s payment',
      async (status) => {
        const { subscriptionId } = await newSubscriber();
        const payment = await recordPayment(client, subscriptionId, {
          status,
          periodStart: T0,
          periodEnd: month(T0),
        });
        for (const type of ['CREATED', 'RENEWED'] as const) {
          await expect(
            client.subscriptionEvent.create({
              data: {
                subscriptionId,
                type,
                paymentId: payment.id,
                occurredAt: T0,
              },
            }),
          ).rejects.toThrow(/requires a SUCCEEDED payment/);
        }
      },
    );

    it('an event cannot reference another subscription’s payment', async () => {
      const a = await newSubscriber();
      const b = await newSubscriber();
      const payment = await recordPayment(client, b.subscriptionId, {
        periodStart: T0,
        periodEnd: month(T0),
      });
      await expect(
        client.subscriptionEvent.create({
          data: {
            subscriptionId: a.subscriptionId,
            type: 'CREATED',
            paymentId: payment.id,
            occurredAt: T0,
          },
        }),
      ).rejects.toThrow(
        /requires a SUCCEEDED payment of the same subscription/,
      );
    });

    describe('a payment grants access only for the period it covers', () => {
      const d = (n: number) => daysFrom(T0, n);

      // Regression: the term only had to end at a paid period end.
      it('rejects an initial term that starts before its paid period', async () => {
        const { authId, subscriptionId } = await newSubscriber();
        const paidFrom = d(19);
        await recordPayment(client, subscriptionId, {
          periodStart: paidFrom,
          periodEnd: month(paidFrom),
        });

        await expect(
          setTerm(authId, {
            billingInterval: MONTHLY,
            start: T0,
            end: month(paidFrom),
          }),
        ).rejects.toThrow(/requires a verified \(SUCCEEDED\) payment covering/);
        await expect(access.hasProAccess(authId, d(5))).resolves.toBe(false);

        await setTerm(authId, {
          billingInterval: MONTHLY,
          start: paidFrom,
          end: month(paidFrom),
        });
        await expect(access.hasProAccess(authId, d(18))).resolves.toBe(false);
        await expect(access.hasProAccess(authId, paidFrom)).resolves.toBe(true);
      });

      it('accepts an initial term that starts after its paid period starts', async () => {
        const { authId, subscriptionId } = await newSubscriber();
        await recordPayment(client, subscriptionId, {
          periodStart: T0,
          periodEnd: month(T0),
        });
        await expect(
          setTerm(authId, {
            billingInterval: MONTHLY,
            start: d(2),
            end: month(T0),
          }),
        ).resolves.toBeDefined();
      });

      // Regression: a renewal only had to end at a paid period end.
      it('rejects a renewal that would bridge an unpaid gap, and access ends at the last paid expiry', async () => {
        const { authId, subscriptionId } = await newSubscriber();
        const firstEnd = month(T0);
        await givenProPurchased(client, authId, {
          billingInterval: MONTHLY,
          startedAt: T0,
        });
        const laterStart = daysFrom(firstEnd, 10);
        await recordPayment(client, subscriptionId, {
          periodStart: laterStart,
          periodEnd: month(laterStart),
        });

        await expect(
          client.userSubscription.update({
            where: { authId },
            data: { proExpiresAt: month(laterStart) },
          }),
        ).rejects.toThrow(/requires a verified \(SUCCEEDED\) payment covering/);
        await expect(
          access.hasProAccess(authId, daysFrom(firstEnd, 5)),
        ).resolves.toBe(false);

        // The same payment is valid as a new term after the lapse.
        await client.userSubscription.update({
          where: { authId },
          data: { proStartedAt: laterStart, proExpiresAt: month(laterStart) },
        });
        await expect(
          access.hasProAccess(authId, daysFrom(firstEnd, 5)),
        ).resolves.toBe(false);
        await expect(access.hasProAccess(authId, laterStart)).resolves.toBe(
          true,
        );
      });

      it('rejects a renewal that starts 1 ms after the current expiry', async () => {
        const { authId, subscriptionId } = await newSubscriber();
        const firstEnd = month(T0);
        await givenProPurchased(client, authId, {
          billingInterval: MONTHLY,
          startedAt: T0,
        });
        const late = new Date(firstEnd.getTime() + 1);
        await recordPayment(client, subscriptionId, {
          periodStart: late,
          periodEnd: month(late),
        });
        await expect(
          client.userSubscription.update({
            where: { authId },
            data: { proExpiresAt: month(late) },
          }),
        ).rejects.toThrow(/requires a verified/);
      });

      it('rejects moving the term start earlier than its payments cover', async () => {
        const { authId } = await newSubscriber();
        await givenProPurchased(client, authId, {
          billingInterval: MONTHLY,
          startedAt: T0,
        });
        await expect(
          client.userSubscription.update({
            where: { authId },
            data: { proStartedAt: d(-10) },
          }),
        ).rejects.toThrow(/requires a verified/);
      });

      it('keeps valid renewals working: contiguous, early (overlapping) and several in a row', async () => {
        const { authId, subscriptionId } = await newSubscriber();
        const m1 = month(T0);
        await givenProPurchased(client, authId, {
          billingInterval: MONTHLY,
          startedAt: T0,
        });
        await givenProRenewed(client, authId, {
          billingInterval: MONTHLY,
          periodStart: m1,
        });
        const m2 = month(m1);
        await givenProRenewed(client, authId, {
          billingInterval: MONTHLY,
          periodStart: m2,
        });
        const m3 = month(m2);

        // Early renewal: paid 3 days before the current expiry.
        const early = daysFrom(m3, -3);
        await recordPayment(client, subscriptionId, {
          periodStart: early,
          periodEnd: month(early),
        });
        await client.userSubscription.update({
          where: { authId },
          data: { proExpiresAt: month(early) },
        });

        await expect(
          access.getAccess(authId, daysFrom(m3, 1)),
        ).resolves.toMatchObject({
          status: 'PRO',
          accessExpiresAt: month(early),
        });
      });

      it('keeps interval changes working: monthly to yearly at renewal and mid-term', async () => {
        const atRenewal = await newSubscriber();
        await givenProPurchased(client, atRenewal.authId, {
          billingInterval: MONTHLY,
          startedAt: T0,
        });
        await givenProRenewed(client, atRenewal.authId, {
          billingInterval: YEARLY,
          periodStart: month(T0),
        });
        await expect(
          access.getAccess(atRenewal.authId, d(200)),
        ).resolves.toMatchObject({
          status: 'PRO',
          accessExpiresAt: year(month(T0)),
        });

        const midTerm = await newSubscriber();
        await givenProPurchased(client, midTerm.authId, {
          billingInterval: MONTHLY,
          startedAt: T0,
        });
        const upgradeAt = d(12);
        await recordPayment(client, midTerm.subscriptionId, {
          billingInterval: YEARLY,
          periodStart: upgradeAt,
          periodEnd: year(upgradeAt),
        });
        await client.userSubscription.update({
          where: { authId: midTerm.authId },
          data: { billingInterval: YEARLY, proExpiresAt: year(upgradeAt) },
        });
        await expect(
          access.getAccess(midTerm.authId, d(300)),
        ).resolves.toMatchObject({
          status: 'PRO',
          accessExpiresAt: year(upgradeAt),
        });
      });
    });

    it('a pending payment that later succeeds can then start the term', async () => {
      const { authId, subscriptionId } = await newSubscriber();
      const payment = await recordPayment(client, subscriptionId, {
        status: PaymentStatus.PENDING,
        periodStart: T0,
        periodEnd: month(T0),
      });
      await expect(
        setTerm(authId, {
          billingInterval: MONTHLY,
          start: T0,
          end: month(T0),
        }),
      ).rejects.toThrow(/requires a verified/);

      await client.paymentTransaction.update({
        where: { id: payment.id },
        data: { status: 'SUCCEEDED', paidAt: daysFrom(T0, 0) },
      });
      await setTerm(authId, {
        billingInterval: MONTHLY,
        start: T0,
        end: month(T0),
      });
      await expect(access.hasProAccess(authId, daysFrom(T0, 1))).resolves.toBe(
        true,
      );
    });
  });
});
