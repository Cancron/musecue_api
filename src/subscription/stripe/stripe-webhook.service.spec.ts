import {
  BillingInterval,
  CheckoutSessionStatus,
  PaymentStatus,
  SubscriptionStatus,
} from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { ActivityLogService } from '../../common/services/activity-log.service';
import type { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { addBillingInterval } from '../billing.validation';
import { StripeClientService } from './stripe-client.service';
import { StripeWebhookService } from './stripe-webhook.service';

describe('StripeWebhookService', () => {
  const prisma = mockDeep<PrismaService>();
  const stripe = mock<StripeClientService>();
  const activityLog = mock<ActivityLogService>();
  const customLogger = mock<CustomLoggerService>();
  const service = new StripeWebhookService(
    prisma,
    stripe,
    activityLog,
    customLogger,
  );

  const now = new Date('2026-03-01T09:30:00.000Z');
  const rawBody = Buffer.from('{}');
  const signature = 'sig_test';

  const checkoutRecord = (overrides: Record<string, unknown> = {}) => ({
    id: 'cs-1',
    subscriptionId: 'sub-1',
    provider: 'stripe',
    providerSessionId: 'cs_test_1',
    billingInterval: BillingInterval.MONTHLY,
    amountCents: 1900,
    currency: 'USD',
    status: CheckoutSessionStatus.PENDING,
    url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    expiresAt: new Date('2026-03-02T09:30:00.000Z'),
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

  const subscriptionRecord = (overrides: Record<string, unknown> = {}) => ({
    id: 'sub-1',
    authId: 'user-1',
    status: SubscriptionStatus.FREE,
    trialUsed: false,
    trialStartedAt: null,
    trialExpiresAt: null,
    billingInterval: null,
    proStartedAt: null,
    proExpiresAt: null,
    proCanceledAt: null,
    paymentProvider: null,
    providerSubscriptionId: null,
    stripeCustomerId: 'cus_1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

  const session = (overrides: Record<string, unknown> = {}) => ({
    id: 'cs_test_1',
    payment_status: 'paid',
    payment_intent: 'pi_test_1',
    invoice: null,
    subscription: 'sub_stripe_1',
    amount_total: 1900,
    currency: 'usd',
    ...overrides,
  });

  const event = (type: string, object: Record<string, unknown>) => ({
    id: 'evt_1',
    type,
    data: { object },
  });

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(((
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => callback(prisma)) as never);
    prisma.checkoutSession.findUnique.mockResolvedValue(
      checkoutRecord() as never,
    );
    prisma.checkoutSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.userSubscription.findUniqueOrThrow.mockResolvedValue(
      subscriptionRecord() as never,
    );
    prisma.paymentTransaction.create.mockImplementation(((args: {
      data: Record<string, unknown>;
    }) =>
      Promise.resolve({
        id: 'pay-1',
        ...args.data,
      })) as never);
    prisma.userSubscription.update.mockResolvedValue(
      subscriptionRecord() as never,
    );
    prisma.subscriptionEvent.create.mockResolvedValue({
      id: 'evt-row-1',
    } as never);
  });

  describe('signature verification', () => {
    it('propagates a signature failure without touching the database', async () => {
      stripe.constructWebhookEvent.mockImplementation(() => {
        throw new Error('bad signature');
      });

      await expect(
        service.handleWebhook(rawBody, signature, now),
      ).rejects.toThrow('bad signature');
      expect(prisma.$transaction.mock.calls).toHaveLength(0);
    });
  });

  describe('events this handler ignores', () => {
    it('does nothing for an unrelated event type', async () => {
      stripe.constructWebhookEvent.mockReturnValue(
        event('invoice.payment_succeeded', {}) as never,
      );
      await service.handleWebhook(rawBody, signature, now);
      expect(prisma.$transaction.mock.calls).toHaveLength(0);
    });

    it('does nothing while the payment is not yet verified', async () => {
      stripe.constructWebhookEvent.mockReturnValue(
        event(
          'checkout.session.completed',
          session({ payment_status: 'unpaid' }),
        ) as never,
      );
      await service.handleWebhook(rawBody, signature, now);
      expect(prisma.$transaction.mock.calls).toHaveLength(0);
    });

    it('logs and does nothing when there is no payment reference to record', async () => {
      stripe.constructWebhookEvent.mockReturnValue(
        event(
          'checkout.session.completed',
          session({ payment_intent: null, invoice: null }),
        ) as never,
      );
      await service.handleWebhook(rawBody, signature, now);
      expect(prisma.$transaction.mock.calls).toHaveLength(0);
      expect(customLogger.warn.mock.calls).toHaveLength(1);
    });

    it('does nothing when the session is not one of ours', async () => {
      prisma.checkoutSession.findUnique.mockResolvedValue(null);
      stripe.constructWebhookEvent.mockReturnValue(
        event('checkout.session.completed', session()) as never,
      );
      await service.handleWebhook(rawBody, signature, now);
      expect(prisma.paymentTransaction.create.mock.calls).toHaveLength(0);
    });

    it('does nothing when the session was already processed (idempotent replay)', async () => {
      prisma.checkoutSession.findUnique.mockResolvedValue(
        checkoutRecord({ status: CheckoutSessionStatus.COMPLETED }) as never,
      );
      stripe.constructWebhookEvent.mockReturnValue(
        event('checkout.session.completed', session()) as never,
      );
      await service.handleWebhook(rawBody, signature, now);
      expect(prisma.paymentTransaction.create.mock.calls).toHaveLength(0);
    });

    it('does nothing when a concurrent delivery already claimed the session', async () => {
      prisma.checkoutSession.updateMany.mockResolvedValue({ count: 0 });
      stripe.constructWebhookEvent.mockReturnValue(
        event('checkout.session.completed', session()) as never,
      );
      await service.handleWebhook(rawBody, signature, now);
      expect(prisma.paymentTransaction.create.mock.calls).toHaveLength(0);
    });
  });

  describe('amount verification', () => {
    it('rejects and writes nothing further when the charged amount does not match the quote', async () => {
      stripe.constructWebhookEvent.mockReturnValue(
        event(
          'checkout.session.completed',
          session({ amount_total: 999 }),
        ) as never,
      );
      await expect(
        service.handleWebhook(rawBody, signature, now),
      ).rejects.toMatchObject({ status: 409 });
      expect(prisma.paymentTransaction.create.mock.calls).toHaveLength(0);
      expect(customLogger.error.mock.calls).toHaveLength(1);
    });
  });

  describe('activating Pro on a verified payment', () => {
    it('records a SUCCEEDED payment for exactly one calendar month and grants Pro', async () => {
      stripe.constructWebhookEvent.mockReturnValue(
        event('checkout.session.completed', session()) as never,
      );

      await service.handleWebhook(rawBody, signature, now);

      expect(prisma.paymentTransaction.create.mock.calls[0]?.[0]).toMatchObject(
        {
          data: {
            subscriptionId: 'sub-1',
            checkoutSessionId: 'cs-1',
            provider: 'stripe',
            providerPaymentId: 'pi_test_1',
            status: PaymentStatus.SUCCEEDED,
            amountCents: 1900,
            currency: 'USD',
            billingInterval: BillingInterval.MONTHLY,
            periodStart: now,
            periodEnd: addBillingInterval(now, BillingInterval.MONTHLY),
            paidAt: now,
          },
        },
      );

      expect(prisma.userSubscription.update.mock.calls[0]?.[0]).toMatchObject({
        where: { id: 'sub-1' },
        data: {
          status: SubscriptionStatus.PRO,
          billingInterval: BillingInterval.MONTHLY,
          proStartedAt: now,
          proExpiresAt: addBillingInterval(now, BillingInterval.MONTHLY),
          paymentProvider: 'stripe',
          providerSubscriptionId: 'sub_stripe_1',
        },
      });

      expect(prisma.subscriptionEvent.create.mock.calls[0]?.[0]).toMatchObject({
        data: {
          subscriptionId: 'sub-1',
          type: 'CREATED',
          paymentId: 'pay-1',
          occurredAt: now,
        },
      });

      expect(
        prisma.checkoutSession.updateMany.mock.calls[0]?.[0],
      ).toMatchObject({
        where: { id: 'cs-1', status: CheckoutSessionStatus.PENDING },
        data: { status: CheckoutSessionStatus.COMPLETED, completedAt: now },
      });

      expect(activityLog.logActivity.mock.calls).toHaveLength(1);
    });

    it('records a RENEWED event when the subscription already has a paid term', async () => {
      prisma.userSubscription.findUniqueOrThrow.mockResolvedValue(
        subscriptionRecord({
          status: SubscriptionStatus.PRO,
          billingInterval: BillingInterval.MONTHLY,
          proStartedAt: new Date('2026-02-01T09:30:00.000Z'),
          proExpiresAt: now,
        }) as never,
      );
      stripe.constructWebhookEvent.mockReturnValue(
        event('checkout.session.completed', session()) as never,
      );

      await service.handleWebhook(rawBody, signature, now);

      expect(prisma.subscriptionEvent.create.mock.calls[0]?.[0]).toMatchObject({
        data: { type: 'RENEWED' },
      });
    });

    it('prices and extends a yearly checkout for exactly one calendar year', async () => {
      prisma.checkoutSession.findUnique.mockResolvedValue(
        checkoutRecord({
          billingInterval: BillingInterval.YEARLY,
          amountCents: 19000,
        }) as never,
      );
      stripe.constructWebhookEvent.mockReturnValue(
        event(
          'checkout.session.completed',
          session({ amount_total: 19000 }),
        ) as never,
      );

      await service.handleWebhook(rawBody, signature, now);

      expect(prisma.userSubscription.update.mock.calls[0]?.[0]).toMatchObject({
        data: {
          billingInterval: BillingInterval.YEARLY,
          proStartedAt: now,
          proExpiresAt: addBillingInterval(now, BillingInterval.YEARLY),
        },
      });
    });

    it('falls back to the invoice id when there is no payment intent', async () => {
      stripe.constructWebhookEvent.mockReturnValue(
        event(
          'checkout.session.completed',
          session({ payment_intent: null, invoice: 'in_test_1' }),
        ) as never,
      );

      await service.handleWebhook(rawBody, signature, now);

      expect(prisma.paymentTransaction.create.mock.calls[0]?.[0]).toMatchObject(
        { data: { providerPaymentId: 'in_test_1' } },
      );
    });

    it('keeps the existing provider subscription id when Stripe omits one', async () => {
      prisma.userSubscription.findUniqueOrThrow.mockResolvedValue(
        subscriptionRecord({ providerSubscriptionId: 'sub_previous' }) as never,
      );
      stripe.constructWebhookEvent.mockReturnValue(
        event(
          'checkout.session.completed',
          session({ subscription: null }),
        ) as never,
      );

      await service.handleWebhook(rawBody, signature, now);

      expect(prisma.userSubscription.update.mock.calls[0]?.[0]).toMatchObject({
        data: { providerSubscriptionId: 'sub_previous' },
      });
    });
  });
});
