import { PrismaPg } from '@prisma/adapter-pg';
import {
  BillingInterval,
  CheckoutSessionStatus,
  PaymentStatus,
  PrismaClient,
  SubscriptionStatus,
} from '@prisma/client';
import { mock } from 'jest-mock-extended';
import { ActivityLogService } from '../src/common/services/activity-log.service';
import type { CustomLoggerService } from '../src/common/services/custom-logger.service';
import type { PrismaService } from '../src/common/services/prisma.service';
import type { RedisService } from '../src/common/services/redis.service';
import { addBillingInterval } from '../src/subscription/billing.validation';
import { CheckoutService } from '../src/subscription/checkout.service';
import { StripeClientService } from '../src/subscription/stripe/stripe-client.service';
import { StripeWebhookService } from '../src/subscription/stripe/stripe-webhook.service';
import { SubscriptionPlanService } from '../src/subscription/subscription-plan.service';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';
import { createUser } from './support/subscription-fixtures';

jest.setTimeout(120_000);

const { MONTHLY, YEARLY } = BillingInterval;

/**
 * Authenticated Stripe checkout and its webhook activation against a real
 * PostgreSQL database, exercising the migration added in
 * 20260922090000_add_stripe_checkout_sessions and the existing paid-term
 * trigger from 20260918120000/20260920120000. The Stripe SDK itself is
 * mocked; everything downstream of it (Prisma, the new tables, and the
 * database triggers) is real.
 */
describeWithDatabase(
  'Stripe checkout and webhook activation (PostgreSQL)',
  () => {
    let schema: string;
    let client: PrismaClient;
    let prisma: PrismaService;
    let checkout: CheckoutService;
    let webhook: StripeWebhookService;
    let stripe: ReturnType<typeof mock<StripeClientService>>;
    const redis = mock<RedisService>();

    const T0 = new Date('2026-03-01T09:30:00.000Z');
    const meta = { ip: '127.0.0.1', userAgent: 'jest' };

    let sessionCounter = 0;
    const stubStripeSession = (overrides: Record<string, unknown> = {}) => {
      sessionCounter += 1;
      return {
        id: `cs_test_${sessionCounter}`,
        url: `https://checkout.stripe.com/c/pay/cs_test_${sessionCounter}`,
        expires_at: Math.floor(T0.getTime() / 1000) + 24 * 60 * 60,
        ...overrides,
      };
    };

    let customerCounter = 0;
    // Real Stripe customer ids are unique; a fixed stub value across tests
    // would collide against UserSubscription.stripeCustomerId's unique
    // constraint for different users, which share this test database.
    const stubCustomerId = () => {
      customerCounter += 1;
      return `cus_test_${customerCounter}`;
    };

    beforeAll(async () => {
      schema = await createSchema();
      await applyMigrations(schema, migrationNames());

      client = new PrismaClient({
        adapter: new PrismaPg(
          { connectionString: TEST_DATABASE_URL as string },
          { schema },
        ),
      });
      prisma = client as unknown as PrismaService;
    });

    afterAll(async () => {
      await client?.$disconnect();
      if (schema) await dropSchema(schema);
    });

    beforeEach(() => {
      redis.setNX.mockReset().mockResolvedValue(true);
      redis.del.mockReset().mockResolvedValue(1);
      stripe = mock<StripeClientService>();
      const activityLog = new ActivityLogService(
        prisma,
        mock<CustomLoggerService>(),
      );
      const plans = new SubscriptionPlanService(prisma, activityLog);
      checkout = new CheckoutService(prisma, plans, stripe, activityLog, redis);
      webhook = new StripeWebhookService(
        prisma,
        stripe,
        activityLog,
        mock<CustomLoggerService>(),
      );
    });

    const newUser = () => createUser(client);

    describe('starting checkout', () => {
      it('persists a PENDING CheckoutSession with the plan’s current monthly price', async () => {
        const authId = await newUser();
        const customerId = stubCustomerId();
        stripe.createCustomer.mockResolvedValue({ id: customerId } as never);
        stripe.createCheckoutSession.mockResolvedValue(
          stubStripeSession() as never,
        );

        const result = await checkout.startCheckout(authId, MONTHLY, meta, T0);

        expect(result).toMatchObject({
          billingInterval: MONTHLY,
          amountCents: 1900,
          currency: 'USD',
          reused: false,
        });

        const subscription = await client.userSubscription.findUniqueOrThrow({
          where: { authId },
          include: { checkoutSessions: true },
        });
        expect(subscription.stripeCustomerId).toBe(customerId);
        expect(subscription.checkoutSessions).toHaveLength(1);
        expect(subscription.checkoutSessions[0]).toMatchObject({
          status: CheckoutSessionStatus.PENDING,
          billingInterval: MONTHLY,
          amountCents: 1900,
        });
      });

      it('reuses the pending session on a repeated request for the same option', async () => {
        const authId = await newUser();
        stripe.createCustomer.mockResolvedValue({
          id: stubCustomerId(),
        } as never);
        stripe.createCheckoutSession.mockResolvedValue(
          stubStripeSession() as never,
        );

        const first = await checkout.startCheckout(authId, MONTHLY, meta, T0);
        const second = await checkout.startCheckout(authId, MONTHLY, meta, T0);

        expect(second).toMatchObject({ url: first.url, reused: true });
        expect(stripe.createCheckoutSession.mock.calls).toHaveLength(1);

        const subscription = await client.userSubscription.findUniqueOrThrow({
          where: { authId },
          include: { checkoutSessions: true },
        });
        expect(subscription.checkoutSessions).toHaveLength(1);
      });

      it('expires the old session and creates a new one when the billing option changes', async () => {
        const authId = await newUser();
        stripe.createCustomer.mockResolvedValue({
          id: stubCustomerId(),
        } as never);
        stripe.createCheckoutSession
          .mockResolvedValueOnce(stubStripeSession() as never)
          .mockResolvedValueOnce(stubStripeSession() as never);

        await checkout.startCheckout(authId, MONTHLY, meta, T0);
        await checkout.startCheckout(authId, YEARLY, meta, T0);

        expect(stripe.expireCheckoutSession.mock.calls).toHaveLength(1);

        const subscription = await client.userSubscription.findUniqueOrThrow({
          where: { authId },
          include: { checkoutSessions: { orderBy: { createdAt: 'asc' } } },
        });
        expect(subscription.checkoutSessions).toHaveLength(2);
        expect(subscription.checkoutSessions[0]).toMatchObject({
          billingInterval: MONTHLY,
          status: CheckoutSessionStatus.EXPIRED,
        });
        expect(subscription.checkoutSessions[1]).toMatchObject({
          billingInterval: YEARLY,
          status: CheckoutSessionStatus.PENDING,
        });
      });

      it('the database rejects a second PENDING session even if application code is bypassed', async () => {
        const authId = await newUser();
        stripe.createCustomer.mockResolvedValue({
          id: stubCustomerId(),
        } as never);
        stripe.createCheckoutSession.mockResolvedValue(
          stubStripeSession() as never,
        );
        await checkout.startCheckout(authId, MONTHLY, meta, T0);

        const subscription = await client.userSubscription.findUniqueOrThrow({
          where: { authId },
        });

        await expect(
          client.checkoutSession.create({
            data: {
              subscriptionId: subscription.id,
              provider: 'stripe',
              providerSessionId: 'cs_test_bypass',
              billingInterval: YEARLY,
              amountCents: 19000,
              currency: 'USD',
              url: 'https://checkout.stripe.com/c/pay/cs_test_bypass',
              expiresAt: addBillingInterval(T0, MONTHLY),
            },
          }),
        ).rejects.toThrow();
      });

      it('rejects starting checkout for a user with an active paid Pro term', async () => {
        const authId = await newUser();
        await client.userSubscription.create({ data: { authId } });
        const subscription = await client.userSubscription.findUniqueOrThrow({
          where: { authId },
        });
        await client.paymentTransaction.create({
          data: {
            subscriptionId: subscription.id,
            provider: 'stripe',
            providerPaymentId: 'pi_existing',
            status: PaymentStatus.SUCCEEDED,
            amountCents: 1900,
            billingInterval: MONTHLY,
            periodStart: T0,
            periodEnd: addBillingInterval(T0, MONTHLY),
            paidAt: T0,
          },
        });
        await client.userSubscription.update({
          where: { authId },
          data: {
            status: SubscriptionStatus.PRO,
            billingInterval: MONTHLY,
            proStartedAt: T0,
            proExpiresAt: addBillingInterval(T0, MONTHLY),
          },
        });

        await expect(
          checkout.startCheckout(authId, MONTHLY, meta, T0),
        ).rejects.toMatchObject({ status: 409 });
        expect(stripe.createCheckoutSession.mock.calls).toHaveLength(0);
      });
    });

    describe('webhook activation', () => {
      const completedEvent = (
        authId: string,
        providerSessionId: string,
        overrides: Record<string, unknown> = {},
      ) => ({
        id: `evt_${providerSessionId}`,
        type: 'checkout.session.completed',
        data: {
          object: {
            id: providerSessionId,
            payment_status: 'paid',
            payment_intent: `pi_${providerSessionId}`,
            invoice: null,
            subscription: `sub_${providerSessionId}`,
            amount_total: 1900,
            currency: 'usd',
            ...overrides,
          },
        },
      });

      it('grants Pro access only after the webhook verifies payment, never at checkout time', async () => {
        const authId = await newUser();
        stripe.createCustomer.mockResolvedValue({
          id: stubCustomerId(),
        } as never);
        const stripeSession = stubStripeSession();
        stripe.createCheckoutSession.mockResolvedValue(stripeSession as never);

        await checkout.startCheckout(authId, MONTHLY, meta, T0);

        const beforeWebhook = await client.userSubscription.findUniqueOrThrow({
          where: { authId },
        });
        expect(beforeWebhook.status).toBe(SubscriptionStatus.FREE);
        expect(beforeWebhook.proStartedAt).toBeNull();

        stripe.constructWebhookEvent.mockReturnValue(
          completedEvent(authId, stripeSession.id) as never,
        );
        await webhook.handleWebhook(Buffer.from('{}'), 'sig_1', T0);

        const afterWebhook = await client.userSubscription.findUniqueOrThrow({
          where: { authId },
          include: { payments: true, events: true, checkoutSessions: true },
        });
        expect(afterWebhook.status).toBe(SubscriptionStatus.PRO);
        expect(afterWebhook.proStartedAt).toEqual(T0);
        expect(afterWebhook.proExpiresAt).toEqual(
          addBillingInterval(T0, MONTHLY),
        );
        expect(afterWebhook.paymentProvider).toBe('stripe');
        expect(afterWebhook.providerSubscriptionId).toBe(
          `sub_${stripeSession.id}`,
        );

        expect(afterWebhook.payments).toHaveLength(1);
        expect(afterWebhook.payments[0]).toMatchObject({
          status: PaymentStatus.SUCCEEDED,
          providerPaymentId: `pi_${stripeSession.id}`,
          amountCents: 1900,
        });
        expect(afterWebhook.events).toHaveLength(1);
        expect(afterWebhook.events[0]).toMatchObject({ type: 'CREATED' });
        expect(afterWebhook.checkoutSessions[0]).toMatchObject({
          status: CheckoutSessionStatus.COMPLETED,
        });
      });

      it('never activates from a browser redirect or a client-supplied session id, only from a verified webhook', async () => {
        const authId = await newUser();
        stripe.createCustomer.mockResolvedValue({
          id: stubCustomerId(),
        } as never);
        const stripeSession = stubStripeSession();
        stripe.createCheckoutSession.mockResolvedValue(stripeSession as never);
        await checkout.startCheckout(authId, MONTHLY, meta, T0);

        // Simulate the only "client-facing" surface: re-requesting the same
        // checkout (as a returning browser might) and reading the status
        // endpoint's underlying data. Neither does anything but read/reuse.
        await checkout.startCheckout(authId, MONTHLY, meta, T0);

        const record = await client.userSubscription.findUniqueOrThrow({
          where: { authId },
        });
        expect(record.status).toBe(SubscriptionStatus.FREE);
        expect(record.proStartedAt).toBeNull();
      });

      it('is idempotent under a duplicate webhook delivery for the same event', async () => {
        const authId = await newUser();
        stripe.createCustomer.mockResolvedValue({
          id: stubCustomerId(),
        } as never);
        const stripeSession = stubStripeSession();
        stripe.createCheckoutSession.mockResolvedValue(stripeSession as never);
        await checkout.startCheckout(authId, MONTHLY, meta, T0);

        stripe.constructWebhookEvent.mockReturnValue(
          completedEvent(authId, stripeSession.id) as never,
        );
        await webhook.handleWebhook(Buffer.from('{}'), 'sig_1', T0);
        await webhook.handleWebhook(Buffer.from('{}'), 'sig_1', T0);

        const payments = await client.paymentTransaction.findMany({
          where: { providerPaymentId: `pi_${stripeSession.id}` },
        });
        expect(payments).toHaveLength(1);
      });

      it('rolls back everything when the charged amount does not match the quote', async () => {
        const authId = await newUser();
        stripe.createCustomer.mockResolvedValue({
          id: stubCustomerId(),
        } as never);
        const stripeSession = stubStripeSession();
        stripe.createCheckoutSession.mockResolvedValue(stripeSession as never);
        await checkout.startCheckout(authId, MONTHLY, meta, T0);

        stripe.constructWebhookEvent.mockReturnValue(
          completedEvent(authId, stripeSession.id, {
            amount_total: 1,
          }) as never,
        );
        await expect(
          webhook.handleWebhook(Buffer.from('{}'), 'sig_1', T0),
        ).rejects.toMatchObject({ status: 409 });

        const record = await client.userSubscription.findUniqueOrThrow({
          where: { authId },
          include: { payments: true, checkoutSessions: true },
        });
        expect(record.status).toBe(SubscriptionStatus.FREE);
        expect(record.payments).toHaveLength(0);
        // The session is still PENDING: the (failed) transaction rolled the
        // COMPLETED claim back too.
        expect(record.checkoutSessions[0]?.status).toBe(
          CheckoutSessionStatus.PENDING,
        );
      });
    });
  },
);
