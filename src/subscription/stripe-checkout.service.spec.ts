import { BillingInterval, CheckoutSessionStatus } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { ActivityLogService } from '../common/services/activity-log.service';
import { PrismaService } from '../common/services/prisma.service';
import { RedisService } from '../common/services/redis.service';
import { CheckoutService } from './checkout.service';
import type { SubscriptionPlanView } from './interfaces/subscription-plan.interface';
import { StripeClientService } from './stripe/stripe-client.service';
import { SubscriptionPlanService } from './subscription-plan.service';

describe('CheckoutService', () => {
  const prisma = mockDeep<PrismaService>();
  const plans = mock<SubscriptionPlanService>();
  const stripe = mock<StripeClientService>();
  const activityLog = mock<ActivityLogService>();
  const redis = mock<RedisService>();
  const service = new CheckoutService(
    prisma,
    plans,
    stripe,
    activityLog,
    redis,
  );

  const now = new Date('2026-03-01T09:30:00.000Z');
  const meta = { ip: '127.0.0.1', userAgent: 'jest' };

  const plan = (
    overrides: Partial<SubscriptionPlanView> = {},
  ): SubscriptionPlanView => ({
    code: 'PRO' as const,
    currency: 'USD' as const,
    planEnabled: true,
    monthlyPriceUsdCents: 1900,
    yearlyPriceUsdCents: 19000,
    trialEnabled: true,
    trialDays: 7,
    updatedAt: null,
    ...overrides,
  });

  const activeAccount = {
    status: 'ACTIVE',
    verified: true,
    deletedAt: null,
    email: 'user@example.com',
  };

  const freeRecord = {
    id: 'sub-1',
    authId: 'user-1',
    stripeCustomerId: null as string | null,
    trialUsed: false,
    trialStartedAt: null,
    trialExpiresAt: null,
    billingInterval: null,
    proStartedAt: null,
    proExpiresAt: null,
    proCanceledAt: null,
  };

  const pendingSession = (overrides: Record<string, unknown> = {}) => ({
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

  beforeEach(() => {
    jest.resetAllMocks();
    redis.setNX.mockResolvedValue(true);
    redis.del.mockResolvedValue(1);
    plans.getProPlan.mockResolvedValue(plan());
    prisma.authUser.findUnique.mockResolvedValue(activeAccount as never);
    prisma.userSubscription.createMany.mockResolvedValue({ count: 1 });
    prisma.userSubscription.findUniqueOrThrow.mockResolvedValue(
      freeRecord as never,
    );
    prisma.checkoutSession.findFirst.mockResolvedValue(null);
    prisma.checkoutSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.userSubscription.updateMany.mockResolvedValue({ count: 1 });
    stripe.createCustomer.mockResolvedValue({ id: 'cus_1' } as never);
    stripe.createCheckoutSession.mockResolvedValue({
      id: 'cs_test_1',
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
      expires_at: Math.floor(
        new Date('2026-03-02T09:30:00.000Z').getTime() / 1000,
      ),
    } as never);
    prisma.checkoutSession.create.mockResolvedValue(pendingSession() as never);
  });

  describe('the per-user lock', () => {
    it('rejects with 409 and never touches Stripe or the database when the lock is held', async () => {
      redis.setNX.mockResolvedValue(false);

      await expect(
        service.startCheckout('user-1', BillingInterval.MONTHLY, meta, now),
      ).rejects.toMatchObject({ status: 409 });

      expect(prisma.authUser.findUnique.mock.calls).toHaveLength(0);
      expect(stripe.createCheckoutSession.mock.calls).toHaveLength(0);
      // The lock was never acquired, so it must not be released either.
      expect(redis.del.mock.calls).toHaveLength(0);
    });

    it('always releases the lock, even when the request fails', async () => {
      prisma.authUser.findUnique.mockResolvedValue(null);

      await expect(
        service.startCheckout('user-1', BillingInterval.MONTHLY, meta, now),
      ).rejects.toMatchObject({ status: 401 });

      expect(redis.del.mock.calls).toHaveLength(1);
    });
  });

  describe('account and plan eligibility', () => {
    it('rejects an unknown user with 401', async () => {
      prisma.authUser.findUnique.mockResolvedValue(null);
      await expect(
        service.startCheckout('user-1', BillingInterval.MONTHLY, meta, now),
      ).rejects.toMatchObject({ status: 401 });
    });

    it.each(['INACTIVE', 'SUSPENDED', 'DELETED', 'BLOCKED'])(
      'rejects a %s account with 403',
      async (status) => {
        prisma.authUser.findUnique.mockResolvedValue({
          ...activeAccount,
          status,
        } as never);
        await expect(
          service.startCheckout('user-1', BillingInterval.MONTHLY, meta, now),
        ).rejects.toMatchObject({ status: 403 });
      },
    );

    it('rejects when the Pro plan is disabled', async () => {
      plans.getProPlan.mockResolvedValue(plan({ planEnabled: false }));
      await expect(
        service.startCheckout('user-1', BillingInterval.MONTHLY, meta, now),
      ).rejects.toMatchObject({
        status: 403,
        message: 'The Pro plan is not currently available',
      });
      expect(stripe.createCheckoutSession.mock.calls).toHaveLength(0);
    });
  });

  describe('an already-Pro user', () => {
    it('rejects with 409 and creates no session', async () => {
      prisma.userSubscription.findUniqueOrThrow.mockResolvedValue({
        ...freeRecord,
        billingInterval: BillingInterval.MONTHLY,
        proStartedAt: new Date('2026-02-01T00:00:00.000Z'),
        proExpiresAt: new Date('2026-04-01T00:00:00.000Z'),
      } as never);

      await expect(
        service.startCheckout('user-1', BillingInterval.MONTHLY, meta, now),
      ).rejects.toMatchObject({
        status: 409,
        message: 'An active Pro subscription is already in place',
      });
      expect(stripe.createCheckoutSession.mock.calls).toHaveLength(0);
      expect(prisma.checkoutSession.create.mock.calls).toHaveLength(0);
    });
  });

  describe('creating a new session', () => {
    it('creates a Stripe customer, a checkout session, and returns it as not reused', async () => {
      const result = await service.startCheckout(
        'user-1',
        BillingInterval.MONTHLY,
        meta,
        now,
      );

      expect(result).toEqual({
        billingInterval: BillingInterval.MONTHLY,
        amountCents: 1900,
        currency: 'USD',
        url: 'https://checkout.stripe.com/c/pay/cs_test_1',
        expiresAt: '2026-03-02T09:30:00.000Z',
        reused: false,
      });

      expect(stripe.createCustomer.mock.calls[0]?.[0]).toMatchObject({
        email: 'user@example.com',
        metadata: { authId: 'user-1' },
      });

      const sessionParams = stripe.createCheckoutSession.mock.calls[0]?.[0];
      expect(sessionParams).toMatchObject({
        mode: 'subscription',
        customer: 'cus_1',
        client_reference_id: 'user-1',
      });
      expect(sessionParams?.line_items?.[0]).toMatchObject({
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: 1900,
          recurring: { interval: 'month' },
        },
      });

      expect(prisma.checkoutSession.create.mock.calls[0]?.[0]).toMatchObject({
        data: {
          subscriptionId: 'sub-1',
          provider: 'stripe',
          providerSessionId: 'cs_test_1',
          billingInterval: BillingInterval.MONTHLY,
          amountCents: 1900,
          currency: 'USD',
        },
      });
    });

    it('prices a yearly checkout from the plan’s yearly price', async () => {
      plans.getProPlan.mockResolvedValue(plan({ yearlyPriceUsdCents: 19000 }));
      stripe.createCheckoutSession.mockResolvedValue({
        id: 'cs_test_2',
        url: 'https://checkout.stripe.com/c/pay/cs_test_2',
        expires_at: Math.floor(
          new Date('2026-03-02T09:30:00.000Z').getTime() / 1000,
        ),
      } as never);
      prisma.checkoutSession.create.mockResolvedValue(
        pendingSession({
          billingInterval: BillingInterval.YEARLY,
          amountCents: 19000,
          providerSessionId: 'cs_test_2',
        }) as never,
      );

      await service.startCheckout('user-1', BillingInterval.YEARLY, meta, now);

      const sessionParams = stripe.createCheckoutSession.mock.calls[0]?.[0];
      expect(sessionParams?.line_items?.[0]?.price_data).toMatchObject({
        unit_amount: 19000,
        recurring: { interval: 'year' },
      });
    });

    it('reuses an existing Stripe customer instead of creating another', async () => {
      prisma.userSubscription.findUniqueOrThrow.mockResolvedValue({
        ...freeRecord,
        stripeCustomerId: 'cus_existing',
      } as never);

      await service.startCheckout('user-1', BillingInterval.MONTHLY, meta, now);

      expect(stripe.createCustomer.mock.calls).toHaveLength(0);
      expect(stripe.createCheckoutSession.mock.calls[0]?.[0]).toMatchObject({
        customer: 'cus_existing',
      });
    });

    it('reuses whichever customer id a concurrent request already persisted', async () => {
      prisma.userSubscription.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.userSubscription.findUniqueOrThrow.mockResolvedValueOnce(
        freeRecord as never,
      );
      // Second findUniqueOrThrow call re-reads the now-persisted customer id.
      prisma.userSubscription.findUniqueOrThrow.mockResolvedValueOnce({
        stripeCustomerId: 'cus_from_other_request',
      } as never);

      await service.startCheckout('user-1', BillingInterval.MONTHLY, meta, now);

      expect(stripe.createCheckoutSession.mock.calls[0]?.[0]).toMatchObject({
        customer: 'cus_from_other_request',
      });
      expect(activityLog.logActivity.mock.calls).toHaveLength(1); // only the session create, not the customer id
    });

    it('rejects with 409 and expires the just-created Stripe session on a unique-constraint race', async () => {
      prisma.checkoutSession.create.mockRejectedValue({ code: 'P2002' });

      await expect(
        service.startCheckout('user-1', BillingInterval.MONTHLY, meta, now),
      ).rejects.toMatchObject({ status: 409 });

      expect(stripe.expireCheckoutSession.mock.calls).toEqual([['cs_test_1']]);
    });
  });

  describe('repeated requests for the same option', () => {
    it('returns the existing pending session instead of creating another', async () => {
      prisma.checkoutSession.findFirst.mockResolvedValue(
        pendingSession() as never,
      );

      const result = await service.startCheckout(
        'user-1',
        BillingInterval.MONTHLY,
        meta,
        now,
      );

      expect(result).toMatchObject({
        reused: true,
        billingInterval: 'MONTHLY',
      });
      expect(stripe.createCheckoutSession.mock.calls).toHaveLength(0);
      expect(stripe.expireCheckoutSession.mock.calls).toHaveLength(0);
      expect(prisma.checkoutSession.create.mock.calls).toHaveLength(0);
    });

    it('creates a new session when the pending one has expired', async () => {
      prisma.checkoutSession.findFirst.mockResolvedValue(
        pendingSession({
          expiresAt: new Date('2026-02-28T00:00:00.000Z'),
        }) as never,
      );

      const result = await service.startCheckout(
        'user-1',
        BillingInterval.MONTHLY,
        meta,
        now,
      );

      expect(result.reused).toBe(false);
      expect(stripe.expireCheckoutSession.mock.calls).toEqual([['cs_test_1']]);
      expect(stripe.createCheckoutSession.mock.calls).toHaveLength(1);
    });
  });

  describe('switching the billing option before paying', () => {
    it('expires the old pending session and creates a new one for the new option', async () => {
      prisma.checkoutSession.findFirst.mockResolvedValue(
        pendingSession({ billingInterval: BillingInterval.MONTHLY }) as never,
      );
      stripe.createCheckoutSession.mockResolvedValue({
        id: 'cs_test_yearly',
        url: 'https://checkout.stripe.com/c/pay/cs_test_yearly',
        expires_at: Math.floor(
          new Date('2026-03-02T09:30:00.000Z').getTime() / 1000,
        ),
      } as never);
      prisma.checkoutSession.create.mockResolvedValue(
        pendingSession({
          billingInterval: BillingInterval.YEARLY,
          providerSessionId: 'cs_test_yearly',
          amountCents: 19000,
        }) as never,
      );

      const result = await service.startCheckout(
        'user-1',
        BillingInterval.YEARLY,
        meta,
        now,
      );

      expect(stripe.expireCheckoutSession.mock.calls).toEqual([['cs_test_1']]);
      expect(
        prisma.checkoutSession.updateMany.mock.calls[0]?.[0],
      ).toMatchObject({
        where: { id: 'cs-1', status: CheckoutSessionStatus.PENDING },
        data: { status: CheckoutSessionStatus.EXPIRED },
      });
      expect(result).toMatchObject({
        billingInterval: 'YEARLY',
        reused: false,
      });
    });

    it('rejects with 409 instead of creating a new session if a webhook completed the old one meanwhile', async () => {
      prisma.checkoutSession.findFirst.mockResolvedValue(
        pendingSession({ billingInterval: BillingInterval.MONTHLY }) as never,
      );
      // The expire-attempt loses the race: the session is no longer PENDING.
      prisma.checkoutSession.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.userSubscription.findUniqueOrThrow
        .mockResolvedValueOnce(freeRecord as never)
        .mockResolvedValueOnce({
          ...freeRecord,
          billingInterval: BillingInterval.MONTHLY,
          proStartedAt: new Date('2026-03-01T09:00:00.000Z'),
          proExpiresAt: new Date('2026-04-01T09:00:00.000Z'),
        } as never);

      await expect(
        service.startCheckout('user-1', BillingInterval.YEARLY, meta, now),
      ).rejects.toMatchObject({
        status: 409,
        message: 'An active Pro subscription is already in place',
      });
      expect(stripe.createCheckoutSession.mock.calls).toHaveLength(0);
    });
  });
});
