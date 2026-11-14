import { Injectable } from '@nestjs/common';
import {
  BillingInterval,
  CheckoutSessionStatus,
  type CheckoutSession,
} from '@prisma/client';
import AppError from '../common/errors/app.error';
import {
  ActivityLogService,
  type ActivityLogMetadata,
} from '../common/services/activity-log.service';
import config from '../common/config/app.config';
import { PrismaService } from '../common/services/prisma.service';
import { RedisService } from '../common/services/redis.service';
import { planPriceCents } from './billing.validation';
import { CHECKOUT_LOCK_TTL_SECONDS } from './checkout.constants';
import type { CheckoutSessionView } from './interfaces/checkout.interface';
import {
  isProActive,
  isTrialAccountEligible,
  type SubscriptionRecord,
} from './subscription-access.policy';
import { SubscriptionPlanService } from './subscription-plan.service';
import { SUBSCRIPTION_PLAN_CURRENCY } from './subscription-plan.constants';
import {
  STRIPE_CHECKOUT_CONFIG,
  STRIPE_PROVIDER,
} from './stripe/stripe.config';
import { StripeClientService } from './stripe/stripe-client.service';

const ACCOUNT_SELECT = {
  status: true,
  verified: true,
  deletedAt: true,
  email: true,
} as const;

const SUBSCRIPTION_SELECT = {
  id: true,
  authId: true,
  stripeCustomerId: true,
  trialUsed: true,
  trialStartedAt: true,
  trialExpiresAt: true,
  billingInterval: true,
  proStartedAt: true,
  proExpiresAt: true,
  proCanceledAt: true,
} as const;

type SubscriptionForCheckout = SubscriptionRecord & {
  id: string;
  authId: string;
  stripeCustomerId: string | null;
};

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'P2002';

/**
 * Starts (or reuses) a Stripe Checkout Session for the caller's chosen
 * billing option. Only a webhook-verified payment activates Pro access
 * (`StripeWebhookService`); nothing here writes `UserSubscription`'s paid
 * fields.
 *
 * Duplicate checkout requests are prevented in layers:
 *   - a per-user Redis lock serializes repeated or concurrent requests from
 *     the same user, so only one is ever building a session at a time;
 *   - while a PENDING session for the *same* option is still valid, it is
 *     returned as-is instead of creating another;
 *   - a PENDING session for a *different* option is expired (on Stripe and
 *     locally) before a new one is created;
 *   - a database partial unique index (one PENDING session per subscription)
 *     rejects a second insert even if the lock is somehow bypassed.
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: SubscriptionPlanService,
    private readonly stripe: StripeClientService,
    private readonly activityLog: ActivityLogService,
    private readonly redis: RedisService,
  ) {}

  async startCheckout(
    authId: string,
    billingInterval: BillingInterval,
    metadata: ActivityLogMetadata,
    now: Date = new Date(),
  ): Promise<CheckoutSessionView> {
    const lockKey = `${config.redis_cache_key_prefix}:lock:checkout:${authId}`;
    const lockAcquired = await this.redis.setNX(
      lockKey,
      '1',
      CHECKOUT_LOCK_TTL_SECONDS,
    );
    if (!lockAcquired) {
      throw AppError.conflict(
        'A checkout request is already being processed. Please try again in a moment.',
      );
    }

    try {
      return await this.createOrReuseSession(
        authId,
        billingInterval,
        metadata,
        now,
      );
    } finally {
      await this.redis.del(lockKey);
    }
  }

  private async createOrReuseSession(
    authId: string,
    billingInterval: BillingInterval,
    metadata: ActivityLogMetadata,
    now: Date,
  ): Promise<CheckoutSessionView> {
    const account = await this.prisma.authUser.findUnique({
      where: { id: authId },
      select: ACCOUNT_SELECT,
    });
    if (!account) throw AppError.unauthorized('User not found');
    if (!isTrialAccountEligible(account)) {
      throw AppError.forbidden('Only active accounts can start checkout');
    }

    const plan = await this.plans.getProPlan();
    if (!plan.planEnabled) {
      throw AppError.forbidden('The Pro plan is not currently available');
    }

    // Make sure the user's single record exists (no-op if it already does).
    await this.prisma.userSubscription.createMany({
      data: [{ authId }],
      skipDuplicates: true,
    });

    let record = await this.findSubscription(authId);
    this.assertNotAlreadyPro(record, now);

    const pending = await this.prisma.checkoutSession.findFirst({
      where: {
        subscriptionId: record.id,
        status: CheckoutSessionStatus.PENDING,
      },
    });

    if (pending) {
      if (
        pending.billingInterval === billingInterval &&
        pending.expiresAt.getTime() > now.getTime()
      ) {
        return this.toView(pending, true);
      }
      await this.expirePendingSession(pending, metadata);
      // A webhook could have completed the old session in the meantime.
      record = await this.findSubscription(authId);
      this.assertNotAlreadyPro(record, now);
    }

    const customerId = await this.ensureStripeCustomer(
      record,
      account.email,
      metadata,
    );
    return this.createSession(
      record,
      customerId,
      billingInterval,
      plan,
      metadata,
    );
  }

  private assertNotAlreadyPro(record: SubscriptionRecord, now: Date): void {
    if (isProActive(record, now)) {
      throw AppError.conflict('An active Pro subscription is already in place');
    }
  }

  private findSubscription(authId: string): Promise<SubscriptionForCheckout> {
    return this.prisma.userSubscription.findUniqueOrThrow({
      where: { authId },
      select: SUBSCRIPTION_SELECT,
    });
  }

  private async ensureStripeCustomer(
    record: SubscriptionForCheckout,
    email: string,
    metadata: ActivityLogMetadata,
  ): Promise<string> {
    if (record.stripeCustomerId) return record.stripeCustomerId;

    const customer = await this.stripe.createCustomer(
      { email, metadata: { authId: record.authId } },
      { idempotencyKey: `stripe-customer:${record.authId}` },
    );

    const claimed = await this.prisma.userSubscription.updateMany({
      where: { id: record.id, stripeCustomerId: null },
      data: { stripeCustomerId: customer.id },
    });
    if (claimed.count === 1) {
      await this.activityLog.logActivity({
        tableName: 'UserSubscription',
        recordId: record.id,
        action: 'update',
        changes: [
          {
            fieldName: 'stripeCustomerId',
            oldValue: null,
            newValue: customer.id,
          },
        ],
        metadata: { ...metadata, actionedBy: record.authId },
      });
      return customer.id;
    }

    // Lost a race (the per-user lock normally prevents this): reuse whatever
    // customer id actually won.
    const current = await this.prisma.userSubscription.findUniqueOrThrow({
      where: { id: record.id },
      select: { stripeCustomerId: true },
    });
    return current.stripeCustomerId as string;
  }

  /**
   * Expires a stale or superseded pending session, both on Stripe and
   * locally. If the session was already claimed by a concurrent webhook
   * (no longer PENDING), this is a no-op: the caller re-checks Pro access
   * before creating anything new.
   */
  private async expirePendingSession(
    pending: CheckoutSession,
    metadata: ActivityLogMetadata,
  ): Promise<void> {
    await this.stripe.expireCheckoutSession(pending.providerSessionId);

    const updated = await this.prisma.checkoutSession.updateMany({
      where: { id: pending.id, status: CheckoutSessionStatus.PENDING },
      data: { status: CheckoutSessionStatus.EXPIRED },
    });
    if (updated.count === 1) {
      await this.activityLog.logActivity({
        tableName: 'CheckoutSession',
        recordId: pending.id,
        action: 'update',
        changes: [
          {
            fieldName: 'status',
            oldValue: CheckoutSessionStatus.PENDING,
            newValue: CheckoutSessionStatus.EXPIRED,
          },
        ],
        metadata,
      });
    }
  }

  private async createSession(
    record: SubscriptionForCheckout,
    customerId: string,
    billingInterval: BillingInterval,
    plan: { monthlyPriceUsdCents: number; yearlyPriceUsdCents: number },
    metadata: ActivityLogMetadata,
  ): Promise<CheckoutSessionView> {
    const amountCents = planPriceCents(plan, billingInterval);
    const interval =
      billingInterval === BillingInterval.MONTHLY ? 'month' : 'year';
    const label =
      billingInterval === BillingInterval.MONTHLY ? 'Monthly' : 'Yearly';

    const session = await this.stripe.createCheckoutSession({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: record.authId,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: SUBSCRIPTION_PLAN_CURRENCY.toLowerCase(),
            unit_amount: amountCents,
            recurring: { interval },
            product_data: { name: `MuseCue Pro (${label})` },
          },
        },
      ],
      success_url: STRIPE_CHECKOUT_CONFIG.SUCCESS_URL,
      cancel_url: STRIPE_CHECKOUT_CONFIG.CANCEL_URL,
      metadata: {
        authId: record.authId,
        subscriptionId: record.id,
        billingInterval,
      },
    });

    if (!session.url) {
      throw AppError.internalServerError(
        'Stripe did not return a checkout URL',
      );
    }
    const expiresAt = new Date(session.expires_at * 1000);

    try {
      const created = await this.prisma.checkoutSession.create({
        data: {
          subscriptionId: record.id,
          provider: STRIPE_PROVIDER,
          providerSessionId: session.id,
          billingInterval,
          amountCents,
          currency: SUBSCRIPTION_PLAN_CURRENCY,
          url: session.url,
          expiresAt,
        },
      });

      await this.activityLog.logActivity({
        tableName: 'CheckoutSession',
        recordId: created.id,
        action: 'create',
        changes: [
          {
            fieldName: 'billingInterval',
            oldValue: null,
            newValue: billingInterval,
          },
          {
            fieldName: 'amountCents',
            oldValue: null,
            newValue: String(amountCents),
          },
        ],
        metadata: { ...metadata, actionedBy: record.authId },
      });

      return this.toView(created, false);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        // A concurrent request won the race for the one-PENDING-per-
        // subscription slot; this session is not ours to keep.
        await this.stripe.expireCheckoutSession(session.id);
        throw AppError.conflict(
          'A checkout request is already being processed. Please try again in a moment.',
        );
      }
      throw error;
    }
  }

  private toView(
    session: CheckoutSession,
    reused: boolean,
  ): CheckoutSessionView {
    return {
      billingInterval: session.billingInterval,
      amountCents: session.amountCents,
      currency: session.currency,
      url: session.url,
      expiresAt: session.expiresAt.toISOString(),
      reused,
    };
  }
}
