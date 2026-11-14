import { HttpException, Injectable } from '@nestjs/common';
import {
  BillingInterval,
  type CheckoutSession,
  CheckoutSessionStatus,
  Prisma,
} from '@prisma/client';
import Stripe from 'stripe';
import AppError from '../../common/errors/app.error';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { planPriceCents } from '../billing.validation';
import type { CheckoutSessionView } from '../interfaces/checkout.interface';
import {
  isProActive,
  isPurchaseAccountEligible,
  TRIAL_ACCOUNT_SELECT,
} from '../subscription-access.policy';
import { SUBSCRIPTION_PLAN_CURRENCY } from '../subscription-plan.constants';
import { SubscriptionPlanService } from '../subscription-plan.service';
import {
  type ProviderCheckoutSession,
  STRIPE_PROVIDER,
  StripeGateway,
} from './stripe.gateway';

/** A user has at most one checkout in these states (partial unique index). */
export const PENDING_CHECKOUT_STATUSES: CheckoutSessionStatus[] = [
  CheckoutSessionStatus.CREATING,
  CheckoutSessionStatus.OPEN,
  CheckoutSessionStatus.PROCESSING,
];

/** Claim/settle rounds before giving up on a checkout that keeps changing. */
const MAX_ATTEMPTS = 3;

const LOG_CONTEXT = 'StripeCheckoutService';

export const CHECKOUT_ERRORS = {
  accountInactive: () =>
    AppError.forbidden('Only active accounts can purchase Pro'),
  planUnavailable: () =>
    AppError.forbidden('The Pro plan is not currently available'),
  alreadySubscribed: () =>
    AppError.conflict('You already have an active Pro subscription'),
  renewalPastDue: () =>
    AppError.conflict(
      'Your last Pro renewal payment failed and Stripe is still retrying it; a new checkout could charge you twice',
    ),
  paymentProcessing: () =>
    AppError.conflict(
      'Your previous checkout payment is still being processed',
    ),
  superseded: () =>
    AppError.conflict(
      'This checkout was replaced by a newer checkout request; please try again',
    ),
  busy: () =>
    AppError.conflict(
      'Checkout is being updated by another request; please try again',
    ),
  notConfigured: () =>
    AppError.serviceUnavailable('Payments are not configured'),
  previousNotExpired: () =>
    AppError.serviceUnavailable(
      'The previous checkout could not be closed; please try again shortly',
    ),
  providerUnavailable: () =>
    AppError.serviceUnavailable(
      'The payment provider is temporarily unavailable',
    ),
};

type ClaimResult =
  | { created: true; checkout: CheckoutSession }
  | { created: false; checkout: CheckoutSession };

/** A pending checkout that can no longer be paid and must be closed. */
interface PendingClose {
  checkoutId: string;
  /** Only close it if it is still in one of these states. */
  from: CheckoutSessionStatus[];
  reason: 'REPLACED' | 'PROVIDER_EXPIRED' | 'NEVER_OPENED';
}

type SettleResult =
  | { kind: 'reuse'; checkout: CheckoutSession }
  | { kind: 'close'; close: PendingClose }
  /** Changed by a concurrent request; claim again. */
  | { kind: 'retry' };

/**
 * Starts Stripe checkouts for the Pro plan.
 *
 * Rules:
 * - the user, price and currency come from the backend, never the client;
 * - users with an active paid term cannot start a checkout, nor can users
 *   whose last renewal failed while Stripe is still retrying it (past due);
 * - a user has at most one pending checkout. A repeated request for the same
 *   option reuses the open Stripe session (with its original price and
 *   expiry); a different option first expires the open Stripe session and
 *   only creates a new one once Stripe confirmed the expiration;
 * - nothing here grants access. Only a verified webhook does
 *   (StripeWebhookService).
 *
 * Concurrency: the pending checkout is claimed in a short transaction that
 * holds the user's UserSubscription row lock; Stripe is called outside any
 * transaction. Stripe sessions are created with an idempotency key derived
 * from the local checkout id, so concurrent requests that find the same
 * pending checkout receive the same Stripe session. A pending checkout is only
 * closed locally once Stripe confirms its session can no longer be paid, so
 * at most one payable Stripe session exists per user; and it is closed in the
 * same locked transaction that creates its replacement, so a request that
 * closes a checkout always leaves a new one behind (last choice wins).
 */
@Injectable()
export class StripeCheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: SubscriptionPlanService,
    private readonly stripe: StripeGateway,
    private readonly logger: CustomLoggerService,
  ) {}

  async createCheckout(
    authId: string,
    billingInterval: BillingInterval,
    now: Date = new Date(),
  ): Promise<CheckoutSessionView> {
    if (!this.stripe.checkoutConfigured) throw CHECKOUT_ERRORS.notConfigured();

    // Fail fast before creating anything at Stripe; repeated under the lock.
    const { email } = await this.assertCanPurchase(this.prisma, authId, now);
    const customerId = await this.ensureCustomer(authId, email);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let claim = await this.claim(authId, billingInterval, customerId, now);
      if (claim === null) continue;
      if (!claim.created) {
        const settled = await this.settlePending(
          claim.checkout,
          authId,
          billingInterval,
          now,
        );
        if (settled.kind === 'reuse')
          return this.toView(settled.checkout, true);
        if (settled.kind === 'retry') continue;
        // Close the old checkout and create its replacement atomically, so a
        // request that closes a checkout always leaves a new one behind.
        claim = await this.claim(
          authId,
          billingInterval,
          customerId,
          now,
          settled.close,
        );
        if (claim === null || !claim.created) continue;
      }
      return this.toView(
        await this.openProviderSession(claim.checkout, authId),
        false,
      );
    }
    throw CHECKOUT_ERRORS.busy();
  }

  /**
   * Account, plan and paid-term checks. Returns the account email (for the
   * Stripe customer), the plan settings and the subscription record.
   */
  private async assertCanPurchase(
    client: Prisma.TransactionClient,
    authId: string,
    now: Date,
  ) {
    const user = await client.authUser.findUnique({
      where: { id: authId },
      select: { ...TRIAL_ACCOUNT_SELECT, email: true },
    });
    if (!user) throw AppError.unauthorized('User not found');
    if (!isPurchaseAccountEligible(user)) {
      throw CHECKOUT_ERRORS.accountInactive();
    }

    const plan = await this.plans.getProPlan(client);
    if (!plan.planEnabled) throw CHECKOUT_ERRORS.planUnavailable();

    const record = await client.userSubscription.findUnique({
      where: { authId },
      select: {
        id: true,
        trialUsed: true,
        trialStartedAt: true,
        trialExpiresAt: true,
        billingInterval: true,
        proStartedAt: true,
        proExpiresAt: true,
        proCanceledAt: true,
        pastDueSince: true,
      },
    });
    if (isProActive(record, now)) throw CHECKOUT_ERRORS.alreadySubscribed();
    // Stripe may still collect the failed renewal: a second subscription
    // bought now could be charged on top of it.
    if (record?.pastDueSince) throw CHECKOUT_ERRORS.renewalPastDue();
    return { email: user.email, plan, record };
  }

  /**
   * The user's own Stripe customer, created once. The idempotency key makes
   * concurrent first checkouts create a single Stripe customer; the unique
   * constraints make sure only one is ever linked to the user.
   */
  private async ensureCustomer(authId: string, email: string) {
    const where = {
      authId_provider: { authId, provider: STRIPE_PROVIDER },
    };
    const existing = await this.prisma.paymentCustomer.findUnique({ where });
    if (existing) return existing.providerCustomerId;

    const customerId = await this.callStripe('customers.create', null, () =>
      this.stripe.createCustomer(authId, email),
    );
    await this.prisma.paymentCustomer.createMany({
      data: [
        { authId, provider: STRIPE_PROVIDER, providerCustomerId: customerId },
      ],
      skipDuplicates: true,
    });
    const stored = await this.prisma.paymentCustomer.findUnique({ where });
    if (!stored) {
      // The Stripe customer is already linked to another user; never share it.
      this.logger.logWithMetadata(
        'error',
        'Stripe customer is already linked to another user',
        { context: LOG_CONTEXT, authId, providerCustomerId: customerId },
      );
      throw AppError.internalServerError('Unable to link the payment customer');
    }
    if (stored.providerCustomerId !== customerId) {
      this.logger.logWithMetadata(
        'warn',
        'Stripe customer created after another was linked; using the linked one',
        { context: LOG_CONTEXT, authId },
      );
    }
    return stored.providerCustomerId;
  }

  /**
   * Under the user's UserSubscription row lock: re-checks eligibility,
   * closes `close` if given (and still in the expected state), then either
   * returns the pending checkout or creates a CREATING one at the current
   * backend price. Returns null if a concurrent claim won the partial unique
   * index (the caller retries).
   */
  private async claim(
    authId: string,
    billingInterval: BillingInterval,
    customerId: string,
    now: Date,
    close?: PendingClose,
  ): Promise<ClaimResult | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.userSubscription.createMany({
          data: [{ authId }],
          skipDuplicates: true,
        });
        await tx.$queryRaw`
          SELECT "id" FROM "UserSubscription" WHERE "authId" = ${authId} FOR UPDATE
        `;
        const { plan, record } = await this.assertCanPurchase(tx, authId, now);
        if (!record) throw AppError.internalServerError();
        const amountCents = planPriceCents(plan, billingInterval);

        if (close) {
          await tx.checkoutSession.updateMany({
            where: { id: close.checkoutId, status: { in: close.from } },
            data: {
              status: CheckoutSessionStatus.EXPIRED,
              closedAt: new Date(),
              closedReason: close.reason,
            },
          });
        }

        const pending = await tx.checkoutSession.findFirst({
          where: {
            subscriptionId: record.id,
            status: { in: PENDING_CHECKOUT_STATUSES },
          },
        });
        if (pending) return { created: false, checkout: pending };

        const checkout = await tx.checkoutSession.create({
          data: {
            subscriptionId: record.id,
            provider: STRIPE_PROVIDER,
            providerCustomerId: customerId,
            billingInterval,
            amountCents,
            currency: SUBSCRIPTION_PLAN_CURRENCY,
            expiresAt: new Date(
              now.getTime() + this.stripe.checkoutExpiresMinutes * 60_000,
            ),
          },
        });
        return { created: true, checkout };
      });
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  /**
   * Creates (or, for a retried/concurrent request, re-reads through the
   * idempotency key) the Stripe session of a CREATING checkout and marks it
   * OPEN. Returns the checkout as stored afterwards, which may already have
   * been moved on by a concurrent request.
   */
  private async openProviderSession(
    checkout: CheckoutSession,
    authId: string,
  ): Promise<CheckoutSession> {
    let session: ProviderCheckoutSession;
    try {
      session = await this.stripe.createCheckoutSession({
        checkoutId: checkout.id,
        authId,
        customerId: checkout.providerCustomerId,
        billingInterval: checkout.billingInterval,
        amountCents: checkout.amountCents,
        expiresAt: checkout.expiresAt,
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logStripeError('checkout.sessions.create', checkout.id, error);
      // Only a definitive rejection proves no Stripe session exists. Anything
      // else stays CREATING and is resolved through the idempotency key.
      if (StripeGateway.isDefinitiveRejection(error)) {
        await this.markFailed(checkout.id, 'PROVIDER_REJECTED');
      }
      throw CHECKOUT_ERRORS.providerUnavailable();
    }
    if (!session.url || session.status !== 'open') {
      this.logger.logWithMetadata(
        'error',
        'Stripe returned an unpayable checkout',
        {
          context: LOG_CONTEXT,
          checkoutId: checkout.id,
          providerSessionId: session.id,
          providerStatus: session.status,
        },
      );
      throw CHECKOUT_ERRORS.providerUnavailable();
    }

    await this.prisma.checkoutSession.updateMany({
      where: { id: checkout.id, status: CheckoutSessionStatus.CREATING },
      data: {
        status: CheckoutSessionStatus.OPEN,
        providerSessionId: session.id,
        url: session.url,
      },
    });
    return this.prisma.checkoutSession.findUniqueOrThrow({
      where: { id: checkout.id },
    });
  }

  /**
   * Resolves an existing pending checkout: reuse it for the same option, or
   * report that it must be closed (after Stripe confirmed its session can no
   * longer be paid). Never closes anything itself; the caller closes and
   * replaces it in one transaction.
   */
  private async settlePending(
    pending: CheckoutSession,
    authId: string,
    billingInterval: BillingInterval,
    now: Date,
  ): Promise<SettleResult> {
    let checkout = pending;
    if (checkout.status === CheckoutSessionStatus.CREATING) {
      if (checkout.expiresAt.getTime() <= now.getTime()) {
        // Past its expiry Stripe cannot accept payment for it, and its URL
        // was never handed out.
        return closeResult(
          checkout,
          [CheckoutSessionStatus.CREATING],
          'NEVER_OPENED',
        );
      }
      checkout = await this.openProviderSession(checkout, authId);
    }
    if (checkout.status === CheckoutSessionStatus.PROCESSING) {
      throw CHECKOUT_ERRORS.paymentProcessing();
    }
    if (checkout.status !== CheckoutSessionStatus.OPEN)
      return { kind: 'retry' };

    const sessionId = checkout.providerSessionId;
    if (!sessionId) throw AppError.internalServerError();
    const remote = await this.callStripe(
      'checkout.sessions.retrieve',
      checkout.id,
      () => this.stripe.retrieveCheckoutSession(sessionId),
    );
    if ((await this.applyProviderStatus(checkout, remote)) === 'expired') {
      return closeResult(
        checkout,
        [CheckoutSessionStatus.OPEN],
        'PROVIDER_EXPIRED',
      );
    }

    // A valid session for the same option is always reused, with the price
    // and expiry it was created with (admin price changes apply to new
    // checkouts only).
    if (checkout.billingInterval === billingInterval) {
      return { kind: 'reuse', checkout };
    }

    // The other option: the old Stripe session must be confirmed expired
    // before a new one may be created. Any failure (Stripe unreachable, an
    // error, a lost response or a non-expired result) stops here: the old
    // checkout is kept and nothing new is created.
    let expired: ProviderCheckoutSession;
    try {
      expired = await this.stripe.expireCheckoutSession(sessionId);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logStripeError('checkout.sessions.expire', checkout.id, error);
      await this.explainFailedExpiration(checkout, sessionId);
      throw CHECKOUT_ERRORS.previousNotExpired();
    }
    if (expired.status !== 'expired') {
      this.logger.logWithMetadata(
        'error',
        'Stripe did not confirm the checkout expiration',
        {
          context: LOG_CONTEXT,
          checkoutId: checkout.id,
          providerStatus: expired.status,
        },
      );
      throw CHECKOUT_ERRORS.previousNotExpired();
    }
    return closeResult(checkout, [CheckoutSessionStatus.OPEN], 'REPLACED');
  }

  /**
   * After a failed expiration, reads the session again only to choose the
   * error: paid in the meantime (409, processing), already expired by a
   * concurrent request (409, retry), otherwise the caller's 503. It never
   * closes the checkout or allows a new one in this request.
   */
  private async explainFailedExpiration(
    checkout: CheckoutSession,
    sessionId: string,
  ) {
    let latest: ProviderCheckoutSession;
    try {
      latest = await this.stripe.retrieveCheckoutSession(sessionId);
    } catch {
      return;
    }
    if (latest.status === 'complete') {
      await this.applyProviderStatus(checkout, latest);
    }
    if (latest.status === 'expired') throw CHECKOUT_ERRORS.busy();
  }

  /**
   * Interprets Stripe's view of an OPEN checkout. A completed session is
   * waiting for its webhook: it is marked PROCESSING, which blocks new
   * checkouts but grants nothing.
   */
  private async applyProviderStatus(
    checkout: CheckoutSession,
    remote: ProviderCheckoutSession,
  ): Promise<'open' | 'expired'> {
    if (remote.status === 'open' || remote.status === 'expired') {
      return remote.status;
    }
    if (remote.status === 'complete') {
      await this.prisma.checkoutSession.updateMany({
        where: { id: checkout.id, status: CheckoutSessionStatus.OPEN },
        data: { status: CheckoutSessionStatus.PROCESSING },
      });
      throw CHECKOUT_ERRORS.paymentProcessing();
    }
    this.logger.logWithMetadata('error', 'Unknown Stripe checkout status', {
      context: LOG_CONTEXT,
      checkoutId: checkout.id,
      providerStatus: remote.status,
    });
    throw CHECKOUT_ERRORS.providerUnavailable();
  }

  /** A definitively rejected checkout: no Stripe session exists for it. */
  private async markFailed(checkoutId: string, reason: string) {
    await this.prisma.checkoutSession.updateMany({
      where: { id: checkoutId, status: CheckoutSessionStatus.CREATING },
      data: {
        status: CheckoutSessionStatus.FAILED,
        closedAt: new Date(),
        closedReason: reason,
      },
    });
  }

  private toView(
    checkout: CheckoutSession,
    reused: boolean,
  ): CheckoutSessionView {
    if (checkout.status !== CheckoutSessionStatus.OPEN || !checkout.url) {
      throw CHECKOUT_ERRORS.superseded();
    }
    return {
      checkoutSessionId: checkout.id,
      provider: STRIPE_PROVIDER,
      status: CheckoutSessionStatus.OPEN,
      billingInterval: checkout.billingInterval,
      amountCents: checkout.amountCents,
      currency: SUBSCRIPTION_PLAN_CURRENCY,
      url: checkout.url,
      expiresAt: checkout.expiresAt.toISOString(),
      reused,
    };
  }

  /** Runs a Stripe call, turning provider failures into a 503. */
  private async callStripe<T>(
    operation: string,
    checkoutId: string | null,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logStripeError(operation, checkoutId, error);
      throw CHECKOUT_ERRORS.providerUnavailable();
    }
  }

  /** Logs allowlisted Stripe error fields only (messages can contain PII). */
  private logStripeError(
    operation: string,
    checkoutId: string | null,
    error: unknown,
  ) {
    this.logger.logWithMetadata('warn', 'Stripe request failed', {
      context: LOG_CONTEXT,
      operation,
      checkoutId,
      errorType:
        error instanceof Stripe.errors.StripeError
          ? error.type
          : error instanceof Error
            ? error.name
            : typeof error,
      rawType:
        error instanceof Stripe.errors.StripeError ? error.rawType : undefined,
      code: error instanceof Stripe.errors.StripeError ? error.code : undefined,
      statusCode:
        error instanceof Stripe.errors.StripeError
          ? error.statusCode
          : undefined,
      requestId:
        error instanceof Stripe.errors.StripeError
          ? error.requestId
          : undefined,
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

function closeResult(
  checkout: CheckoutSession,
  from: CheckoutSessionStatus[],
  reason: PendingClose['reason'],
): SettleResult {
  return { kind: 'close', close: { checkoutId: checkout.id, from, reason } };
}
