import { Injectable } from '@nestjs/common';
import {
  CheckoutSessionStatus,
  PaymentStatus,
  SubscriptionEventType,
  SubscriptionStatus,
} from '@prisma/client';
import type Stripe from 'stripe';
import AppError from '../../common/errors/app.error';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';
import {
  addBillingInterval,
  getPaidTermRejection,
  type NextPaidTerm,
  type PaidTerm,
} from '../billing.validation';
import { StripeClientService } from './stripe-client.service';
import { STRIPE_PROVIDER } from './stripe.config';

/**
 * Processes Stripe webhook events. This is the *only* place that activates
 * Pro access for a checkout: a browser redirect to the success URL, or a
 * client reporting its own session id, never does. Renewal events
 * (`invoice.payment_succeeded` and friends) are a later iteration; only the
 * initial `checkout.session.completed` is handled here.
 */
@Injectable()
export class StripeWebhookService {
  private readonly context = 'StripeWebhookService';

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeClientService,
    private readonly activityLog: ActivityLogService,
    private readonly customLogger: CustomLoggerService,
  ) {}

  /**
   * Verifies the signature and processes the event. Resolves (does not
   * throw) for events this handler intentionally ignores, so the controller
   * can still acknowledge them with `2xx` and stop Stripe from retrying.
   * @throws AppError.badRequest only for an invalid signature/payload.
   */
  async handleWebhook(
    rawBody: Buffer,
    signature: string | string[] | undefined,
    now: Date = new Date(),
  ): Promise<void> {
    const event = this.stripe.constructWebhookEvent(rawBody, signature);

    if (event.type === 'checkout.session.completed') {
      await this.handleCheckoutCompleted(event.data.object, now);
    }
  }

  private async handleCheckoutCompleted(
    session: Stripe.Checkout.Session,
    now: Date,
  ): Promise<void> {
    if (session.payment_status !== 'paid') {
      // Checkout completed but the payment is not yet verified (e.g. an
      // async payment method); a later event will report the outcome.
      return;
    }

    const providerPaymentId = this.resolvePaymentId(session);
    if (!providerPaymentId) {
      this.customLogger.warn(
        `Stripe checkout session ${session.id} completed without a payment reference`,
        this.context,
      );
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const checkout = await tx.checkoutSession.findUnique({
        where: {
          provider_providerSessionId: {
            provider: STRIPE_PROVIDER,
            providerSessionId: session.id,
          },
        },
      });
      // Not one of ours, or a re-delivery of an event already fully
      // processed: nothing left to do.
      if (!checkout || checkout.status !== CheckoutSessionStatus.PENDING) {
        return;
      }

      // Claim the session atomically so a concurrent duplicate delivery of
      // the same event cannot process it twice.
      const claimed = await tx.checkoutSession.updateMany({
        where: { id: checkout.id, status: CheckoutSessionStatus.PENDING },
        data: { status: CheckoutSessionStatus.COMPLETED, completedAt: now },
      });
      if (claimed.count !== 1) return;

      const amountCents = session.amount_total ?? checkout.amountCents;
      const currency = (session.currency ?? checkout.currency).toUpperCase();
      if (
        amountCents !== checkout.amountCents ||
        currency !== checkout.currency
      ) {
        this.customLogger.error(
          `Stripe session ${session.id} charged ${amountCents} ${currency}, expected ${checkout.amountCents} ${checkout.currency}`,
          undefined,
          this.context,
        );
        throw AppError.conflict(
          'Checkout amount does not match the quoted price',
        );
      }

      const periodStart = now;
      const periodEnd = addBillingInterval(
        periodStart,
        checkout.billingInterval,
      );

      const subscription = await tx.userSubscription.findUniqueOrThrow({
        where: { id: checkout.subscriptionId },
      });

      const current: PaidTerm = {
        proStartedAt: subscription.proStartedAt,
        proExpiresAt: subscription.proExpiresAt,
      };
      const next: NextPaidTerm = {
        billingInterval: checkout.billingInterval,
        proStartedAt: periodStart,
        proExpiresAt: periodEnd,
      };

      // The paid-term trigger on UserSubscription requires this payment to
      // already exist (as SUCCEEDED) when the subscription row below is
      // written, so it is inserted first.
      const payment = await tx.paymentTransaction.create({
        data: {
          subscriptionId: checkout.subscriptionId,
          checkoutSessionId: checkout.id,
          provider: STRIPE_PROVIDER,
          providerPaymentId,
          status: PaymentStatus.SUCCEEDED,
          amountCents,
          currency,
          billingInterval: checkout.billingInterval,
          periodStart,
          periodEnd,
          paidAt: now,
        },
      });

      const rejection = getPaidTermRejection(
        {
          subscriptionId: payment.subscriptionId,
          status: payment.status,
          billingInterval: payment.billingInterval,
          periodStart: payment.periodStart,
          periodEnd: payment.periodEnd,
        },
        checkout.subscriptionId,
        current,
        next,
      );
      if (rejection) {
        throw AppError.conflict(`Cannot activate Pro: ${rejection}`);
      }

      const providerSubscriptionId =
        this.resolveSubscriptionId(session) ??
        subscription.providerSubscriptionId;

      await tx.userSubscription.update({
        where: { id: checkout.subscriptionId },
        data: {
          status: SubscriptionStatus.PRO,
          billingInterval: checkout.billingInterval,
          proStartedAt: next.proStartedAt,
          proExpiresAt: next.proExpiresAt,
          paymentProvider: STRIPE_PROVIDER,
          providerSubscriptionId,
        },
      });

      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: checkout.subscriptionId,
          type: subscription.proStartedAt
            ? SubscriptionEventType.RENEWED
            : SubscriptionEventType.CREATED,
          paymentId: payment.id,
          occurredAt: periodStart,
        },
      });

      await this.activityLog.logActivity(
        {
          tableName: 'UserSubscription',
          recordId: checkout.subscriptionId,
          action: 'update',
          changes: [
            {
              fieldName: 'status',
              oldValue: subscription.status,
              newValue: SubscriptionStatus.PRO,
            },
            {
              fieldName: 'proStartedAt',
              oldValue: subscription.proStartedAt?.toISOString() ?? null,
              newValue: next.proStartedAt.toISOString(),
            },
            {
              fieldName: 'proExpiresAt',
              oldValue: subscription.proExpiresAt?.toISOString() ?? null,
              newValue: next.proExpiresAt.toISOString(),
            },
          ],
          metadata: { actionedBy: subscription.authId },
        },
        tx,
      );
    });
  }

  /**
   * Subscription-mode Checkout Sessions are paid through the first
   * invoice's PaymentIntent; fall back to the invoice id if the PaymentIntent
   * somehow isn't present so the payment can still be recorded uniquely.
   */
  private resolvePaymentId(session: Stripe.Checkout.Session): string | null {
    const { payment_intent, invoice } = session;
    if (typeof payment_intent === 'string') return payment_intent;
    if (payment_intent && 'id' in payment_intent) return payment_intent.id;
    if (typeof invoice === 'string') return invoice;
    if (invoice && 'id' in invoice) return invoice.id;
    return null;
  }

  private resolveSubscriptionId(
    session: Stripe.Checkout.Session,
  ): string | null {
    const { subscription } = session;
    if (typeof subscription === 'string') return subscription;
    if (subscription && 'id' in subscription) return subscription.id;
    return null;
  }
}
