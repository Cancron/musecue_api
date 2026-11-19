import { HttpException, Injectable } from '@nestjs/common';
import {
  type CheckoutSession,
  CheckoutSessionStatus,
  PaymentStatus,
  Prisma,
  SubscriptionEventType,
  SubscriptionStatus,
  type UserSubscription,
  WebhookEventStatus,
} from '@prisma/client';
import Stripe from 'stripe';
import AppError from '../../common/errors/app.error';
import {
  ActivityLogService,
  type ActivityLogMetadata,
  type FieldChange,
} from '../../common/services/activity-log.service';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { CreditAllowanceService } from '../credit-allowance.service';
import { isProActive } from '../subscription-access.policy';
import { StripeCancellationService } from './stripe-cancellation.service';
import { StripeRefundService } from './stripe-refund.service';
import { PENDING_CHECKOUT_STATUSES } from './stripe-checkout.service';
import {
  type InvoiceVerification,
  type VerifiedStripeInvoice,
  type VerifiedStripePayment,
  type VerifiedStripeRenewal,
  verifyStripeCheckout,
  verifyStripeInvoice,
  verifyStripeRenewal,
} from './stripe-payment.verification';
import type { PaymentFailureDetails } from './stripe.gateway';
import {
  CHECKOUT_METADATA,
  STRIPE_PROVIDER,
  StripeGateway,
  toProviderCancellation,
} from './stripe.gateway';

const LOG_CONTEXT = 'StripeWebhookService';

/** What processing an event did; used for logs and tests. */
export type WebhookOutcome =
  | 'IGNORED'
  | 'UNKNOWN_CHECKOUT'
  | 'UNKNOWN_SUBSCRIPTION'
  | 'ACTIVATED'
  | 'RENEWED'
  /** A delayed renewal for a period the paid term already covers. */
  | 'ALREADY_COVERED'
  | 'ALREADY_PROCESSED'
  | 'DUPLICATE_PAYMENT'
  | 'AWAITING_PAYMENT'
  /** A failed collection attempt was recorded; nothing was granted. */
  | 'PAYMENT_FAILED'
  /** The linked provider subscription ended; retries stopped. */
  | 'SUBSCRIPTION_ENDED'
  /** A period-end cancellation confirmed by Stripe was recorded. */
  | 'CANCELED'
  /** A refund newly succeeded: payment updated and its access revoked. */
  | 'REFUNDED'
  /** Refunds were recorded or updated, but none newly succeeded. */
  | 'REFUND_RECORDED'
  /** A refund of a charge that paid no MuseCue invoice. */
  | 'UNKNOWN_PAYMENT'
  | 'REJECTED'
  | 'CLOSED'
  /** A connected-account or other-mode event: not about this integration. */
  | 'NOT_FOR_THIS_ACCOUNT'
  /** Stripe reports that the object the event names does not exist. */
  | 'UNKNOWN_OBJECT';

declare const verifiedBrand: unique symbol;

/**
 * A Stripe event whose signature was verified against the raw request body.
 * Only verifyEvent produces it, and only it can be processed, so no code path
 * can apply an unverified payload.
 */
export type VerifiedStripeEvent = Stripe.Event & {
  readonly [verifiedBrand]: true;
};

/** The identifying fields of a checkout session in an event payload. */
type SessionRef = Pick<Stripe.Checkout.Session, 'id' | 'metadata'>;

/** Payments that count as paying for their period (database unique index). */
const VERIFIED_PAYMENT_STATUSES: PaymentStatus[] = [
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
];

const idOf = (value: string | { id: string } | null | undefined) =>
  typeof value === 'string' ? value : (value?.id ?? null);

const iso = (date: Date | null) => date?.toISOString() ?? null;

const truncate = (value: string | null | undefined, length: number) =>
  value ? value.slice(0, length) : null;

/**
 * The payment id of one failed collection attempt: the invoice plus the
 * Stripe event that reported it, so a redelivered event is recorded once and
 * every failed attempt keeps its own immutable record.
 */
export const failedAttemptId = (invoiceId: string, eventId: string) =>
  `${invoiceId}:failed:${eventId}`;

/**
 * Handles Stripe webhooks. This is the only place that grants or extends paid
 * Pro access, and only after:
 *
 * 1. the event signature is verified against the raw body (StripeGateway);
 * 2. the checkout session / invoice and subscription are re-read from the
 *    Stripe API (the event payload is never trusted for payment facts);
 * 3. they are matched to what the backend stored when the subscription was
 *    bought (customer, price, interval).
 *
 * - `checkout.session.completed` / `async_payment_succeeded`: first payment,
 *   starts the paid term (CREATED event).
 * - `invoice.paid` with `billing_reason = subscription_cycle`: recurring
 *   payment, extends the paid term to the period end reported by Stripe
 *   (RENEWED event). For `subscription_create` it confirms the first payment
 *   like the checkout events (whichever arrives first records it).
 * - `invoice.payment_failed`: one failed collection attempt (first payment
 *   or renewal), recorded as its own FAILED PaymentTransaction with a
 *   PAYMENT_FAILED event. It never grants, extends or shortens access; a
 *   failed renewal marks the subscription past due until Stripe collects the
 *   invoice (recovery: `invoice.paid`, recorded once like any payment) or
 *   ends the subscription (`customer.subscription.deleted`).
 * - `charge.refunded`, `charge.refund.updated`, `refund.created`,
 *   `refund.updated`, `refund.failed`: refunds made in Stripe, recorded and
 *   applied by StripeRefundService (access paid by a refunded payment ends).
 * - `customer.subscription.updated`: records a period-end cancellation that
 *   Stripe confirms (e.g. when the response to the user's own cancellation
 *   request was lost). It never reverses a recorded cancellation, so stale or
 *   out-of-order updates cannot conflict with it.
 *
 * Each payment, the term change, its event and the audit record are written
 * in one transaction under the user's UserSubscription row lock. A payment is
 * identified by its Stripe invoice id, so replayed, concurrent or delayed
 * deliveries record it once, and the term is only ever extended, never
 * shortened or overwritten by an older period. Browser redirects never reach
 * this code, so they cannot grant anything.
 */
@Injectable()
export class StripeWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeGateway,
    private readonly activityLog: ActivityLogService,
    private readonly logger: CustomLoggerService,
    private readonly cancellation: StripeCancellationService,
    private readonly refunds: StripeRefundService,
    private readonly credits: CreditAllowanceService,
  ) {}

  /**
   * Verifies the `Stripe-Signature` header against the raw body (400 when it
   * is missing, invalid, tampered, signed with another secret or outside the
   * replay tolerance). Nothing is read or written before this succeeds.
   */
  verifyEvent(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): VerifiedStripeEvent {
    return this.stripe.constructEvent(
      rawBody,
      signature,
    ) as VerifiedStripeEvent;
  }

  /**
   * The webhook endpoint: verify, log the verified event, process it and
   * record the outcome. A processing failure is recorded as FAILED and
   * answered with a generic 5xx (no internal details), so Stripe retries; the
   * transaction that failed left nothing half-written, and a redelivery
   * applies the event once.
   */
  async receive(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    metadata: ActivityLogMetadata,
  ): Promise<WebhookOutcome> {
    const event = this.verifyEvent(rawBody, signature);
    const logged = await this.logReceived(event);
    try {
      const outcome = await this.handleEvent(event, metadata);
      await this.prisma.paymentWebhookEvent.update({
        where: { id: logged.id },
        data: {
          status: WebhookEventStatus.PROCESSED,
          outcome,
          processedAt: new Date(),
          lastErrorCode: null,
        },
      });
      return outcome;
    } catch (error) {
      const errorCode = errorCodeOf(error);
      // Best effort: the database may be what failed. A concurrent delivery
      // of the same event that already processed it is not overwritten.
      try {
        await this.prisma.paymentWebhookEvent.updateMany({
          where: { id: logged.id, status: WebhookEventStatus.RECEIVED },
          data: {
            status: WebhookEventStatus.FAILED,
            processedAt: null,
            lastErrorCode: errorCode,
          },
        });
      } catch {
        // Logged below; the original error is what the caller gets.
      }
      this.logger.logWithMetadata(
        'error',
        'Stripe webhook processing failed; Stripe will retry',
        {
          context: LOG_CONTEXT,
          providerEventId: event.id,
          type: event.type,
          errorCode,
        },
      );
      // Retry-later answers keep their own (generic) message; anything else
      // never exposes internal error details to the caller.
      if (error instanceof HttpException && error.getStatus() >= 500) {
        throw error;
      }
      throw AppError.internalServerError('Webhook processing failed');
    }
  }

  /** Records (or counts another delivery of) a verified event. */
  private logReceived(event: VerifiedStripeEvent) {
    const object = event.data.object as { id?: unknown };
    return this.prisma.paymentWebhookEvent.upsert({
      where: {
        provider_providerEventId: {
          provider: STRIPE_PROVIDER,
          providerEventId: event.id,
        },
      },
      create: {
        provider: STRIPE_PROVIDER,
        providerEventId: event.id,
        type: event.type.slice(0, 100),
        objectId:
          typeof object.id === 'string' ? object.id.slice(0, 255) : null,
        livemode: event.livemode,
        eventCreatedAt: new Date(event.created * 1000),
      },
      update: {
        attempts: { increment: 1 },
        status: WebhookEventStatus.RECEIVED,
        processedAt: null,
      },
    });
  }

  async handleEvent(
    event: VerifiedStripeEvent,
    metadata: ActivityLogMetadata,
    now: Date = new Date(),
  ): Promise<WebhookOutcome> {
    // Events of connected accounts or of the other mode (test/live) are not
    // about this integration's customers, whatever their payload says.
    if (event.account || event.livemode !== this.stripe.liveMode) {
      this.logger.logWithMetadata(
        'warn',
        'Stripe event for another account or mode ignored',
        {
          context: LOG_CONTEXT,
          providerEventId: event.id,
          type: event.type,
          livemode: event.livemode,
          connectedAccount: Boolean(event.account),
        },
      );
      return 'NOT_FOR_THIS_ACCOUNT';
    }
    try {
      return await this.dispatch(event, metadata, now);
    } catch (error) {
      // A verified event naming an object that does not exist in this Stripe
      // account can never be applied; retrying would only repeat the error.
      if (
        error instanceof Stripe.errors.StripeInvalidRequestError &&
        error.code === 'resource_missing'
      ) {
        this.logger.logWithMetadata(
          'error',
          'Stripe event names an object that does not exist; ignored',
          { context: LOG_CONTEXT, providerEventId: event.id, type: event.type },
        );
        return 'UNKNOWN_OBJECT';
      }
      throw error;
    }
  }

  private dispatch(
    event: VerifiedStripeEvent,
    metadata: ActivityLogMetadata,
    now: Date,
  ): Promise<WebhookOutcome> | WebhookOutcome {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        return this.confirmPayment(event.data.object, metadata, now);
      case 'checkout.session.async_payment_failed':
        return this.close(
          event.data.object,
          CheckoutSessionStatus.FAILED,
          'ASYNC_PAYMENT_FAILED',
          [CheckoutSessionStatus.OPEN, CheckoutSessionStatus.PROCESSING],
          now,
        );
      case 'checkout.session.expired':
        return this.close(
          event.data.object,
          CheckoutSessionStatus.EXPIRED,
          'PROVIDER_EXPIRED',
          [CheckoutSessionStatus.CREATING, CheckoutSessionStatus.OPEN],
          now,
        );
      case 'invoice.paid':
        return event.data.object.billing_reason === 'subscription_create'
          ? this.confirmFirstInvoice(event.data.object, metadata, now)
          : this.confirmRenewal(event.data.object, metadata, now);
      case 'invoice.payment_failed':
        return this.recordPaymentFailure(
          event.id,
          new Date(event.created * 1000),
          event.data.object,
          metadata,
        );
      case 'customer.subscription.deleted':
        return this.endSubscription(event.data.object, metadata, now);
      case 'customer.subscription.updated':
        return this.syncCancellation(event.data.object, metadata, now);
      // Refunds: every event only names the charge; StripeRefundService
      // reads the charge and all of its refunds from Stripe.
      case 'charge.refunded':
        return this.refunds.syncCharge(event.data.object.id, metadata, now);
      case 'charge.refund.updated':
      case 'refund.created':
      case 'refund.updated':
      case 'refund.failed': {
        const chargeId = idOf(event.data.object.charge);
        return chargeId
          ? this.refunds.syncCharge(chargeId, metadata, now)
          : 'IGNORED';
      }
      default:
        return 'IGNORED';
    }
  }

  // -------------------------------------------------------------------------
  // First payment (checkout)
  // -------------------------------------------------------------------------

  private async confirmPayment(
    ref: SessionRef,
    metadata: ActivityLogMetadata,
    now: Date,
  ): Promise<WebhookOutcome> {
    const checkout = await this.findCheckout(ref);
    if (!checkout) return this.unknownCheckout(ref);
    if (checkout.status === CheckoutSessionStatus.COMPLETED) {
      return 'ALREADY_PROCESSED';
    }

    // Payment facts come from the Stripe API, not from the event payload.
    const session = await this.stripe.retrieveCheckoutForVerification(ref.id);
    const verification = verifyStripeCheckout(session, checkout);

    if (verification.outcome === 'AWAITING_PAYMENT') {
      await this.prisma.checkoutSession.updateMany({
        where: {
          id: checkout.id,
          status: {
            in: [CheckoutSessionStatus.CREATING, CheckoutSessionStatus.OPEN],
          },
        },
        data: {
          status: CheckoutSessionStatus.PROCESSING,
          providerSessionId: session.id,
        },
      });
      return 'AWAITING_PAYMENT';
    }
    if (verification.outcome === 'REJECTED') {
      // Deterministic: a retry would be rejected again, so acknowledge and
      // leave the checkout pending (it blocks a second purchase) for review.
      this.logger.logWithMetadata(
        'error',
        'Stripe checkout failed payment verification; access not granted',
        {
          context: LOG_CONTEXT,
          checkoutId: checkout.id,
          providerSessionId: session.id,
          reason: verification.reason,
        },
      );
      return 'REJECTED';
    }
    return this.applyEarlierRefunds(
      verification.payment.providerPaymentId,
      await this.recordFirstPayment(
        checkout,
        verification.payment,
        metadata,
        now,
      ),
      metadata,
      now,
    );
  }

  private recordFirstPayment(
    checkout: CheckoutSession,
    payment: VerifiedStripePayment,
    metadata: ActivityLogMetadata,
    now: Date,
  ): Promise<WebhookOutcome> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockSubscription(tx, checkout.subscriptionId);

      const recorded = await this.findPayment(tx, payment.providerPaymentId);
      if (recorded) {
        if (recorded.subscriptionId === checkout.subscriptionId) {
          await this.completeCheckout(
            tx,
            checkout.id,
            recorded.id,
            payment,
            now,
          );
        }
        return 'ALREADY_PROCESSED';
      }

      const record = await tx.userSubscription.findUniqueOrThrow({
        where: { id: checkout.subscriptionId },
      });
      const paidAt = payment.paidAt ?? now;
      const saved = await this.createPayment(tx, record.id, payment, paidAt);
      const linked = await this.completeCheckout(
        tx,
        checkout.id,
        saved.id,
        payment,
        now,
      );
      if (!linked) {
        // Keep the link to the Stripe subscription so its renewals can be
        // traced back to this user.
        await tx.checkoutSession.update({
          where: { id: checkout.id },
          data: { providerSubscriptionId: payment.providerSubscriptionId },
        });
        this.logger.logWithMetadata(
          'error',
          'Stripe payment received for a closed checkout; review required',
          {
            context: LOG_CONTEXT,
            checkoutId: checkout.id,
            paymentId: saved.id,
          },
        );
      }

      if (isProActive(record, payment.periodStart)) {
        // Never stack a second paid subscription on an active term. The
        // payment is kept as a fact so it can be refunded.
        this.logger.logWithMetadata(
          'error',
          'Duplicate paid Pro checkout; access unchanged, refund required',
          {
            context: LOG_CONTEXT,
            checkoutId: checkout.id,
            paymentId: saved.id,
          },
        );
        return 'DUPLICATE_PAYMENT';
      }

      // The database trigger re-checks that this SUCCEEDED payment covers
      // exactly [proStartedAt, proExpiresAt).
      const next = {
        status: SubscriptionStatus.PRO,
        billingInterval: payment.billingInterval,
        proStartedAt: payment.periodStart,
        proExpiresAt: payment.periodEnd,
        proCanceledAt: null,
        paymentProvider: STRIPE_PROVIDER,
        providerSubscriptionId: payment.providerSubscriptionId,
        pastDueSince: null,
      };
      await tx.userSubscription.update({
        where: { id: record.id },
        data: next,
      });
      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: record.id,
          type: SubscriptionEventType.CREATED,
          paymentId: saved.id,
          occurredAt: paidAt,
        },
      });
      await this.audit(tx, record, next, metadata);
      // Buying Pro ends any unused trial credits, in the same transaction
      // (purchased and referral credits are kept).
      await this.credits.expireTrialCreditsOnUpgrade(tx, record.authId, now);
      return 'ACTIVATED';
    });
  }

  /** Links the payment to a pending checkout. False if it was already closed. */
  private async completeCheckout(
    tx: Prisma.TransactionClient,
    checkoutId: string,
    paymentId: string,
    payment: VerifiedStripePayment,
    now: Date,
  ): Promise<boolean> {
    const updated = await tx.checkoutSession.updateMany({
      where: { id: checkoutId, status: { in: PENDING_CHECKOUT_STATUSES } },
      data: {
        status: CheckoutSessionStatus.COMPLETED,
        completedAt: now,
        paymentId,
        ...(payment.providerSessionId
          ? { providerSessionId: payment.providerSessionId }
          : {}),
        providerSubscriptionId: payment.providerSubscriptionId,
      },
    });
    return updated.count === 1;
  }

  // -------------------------------------------------------------------------
  // Recurring payments (renewals)
  // -------------------------------------------------------------------------

  private async confirmRenewal(
    ref: Stripe.Invoice,
    metadata: ActivityLogMetadata,
    now: Date,
  ): Promise<WebhookOutcome> {
    // The first invoice (`subscription_create`) is handled through its
    // checkout session; anything else is not a renewal of the Pro plan.
    if (ref.billing_reason !== 'subscription_cycle') return 'IGNORED';
    const subscriptionId = idOf(ref.parent?.subscription_details?.subscription);
    if (!subscriptionId || !ref.id) return 'IGNORED';

    // Replays need no Stripe call (the transaction checks again).
    if (await this.findPayment(this.prisma, ref.id)) return 'ALREADY_PROCESSED';

    // The checkout that created this Stripe subscription fixes its customer,
    // price and interval; later admin price changes do not apply to it.
    const origin = await this.findOrigin(subscriptionId, null);
    if (!origin) {
      // A renewal of a MuseCue subscription whose first payment is not
      // recorded yet: acknowledging it would lose the payment for good, so ask
      // Stripe to deliver it again later.
      if (await this.findOrigin(subscriptionId, ref)) {
        this.logger.logWithMetadata(
          'warn',
          'Stripe renewal before its first payment was recorded; retry later',
          {
            context: LOG_CONTEXT,
            providerSubscriptionId: subscriptionId,
            providerPaymentId: ref.id,
          },
        );
        throw AppError.serviceUnavailable(
          'The first payment of this subscription is not recorded yet; retry later',
        );
      }
      return this.unknownSubscription(subscriptionId, ref.id);
    }

    // Payment facts come from the Stripe API, not from the event payload.
    const invoice = await this.stripe.retrieveInvoice(ref.id);
    const subscription = await this.stripe.retrieveSubscription(subscriptionId);
    const verification = verifyStripeRenewal(invoice, subscription, {
      providerSubscriptionId: subscriptionId,
      providerCustomerId: origin.providerCustomerId,
      billingInterval: origin.billingInterval,
      amountCents: origin.amountCents,
      currency: origin.currency,
      checkoutId: origin.id,
    });
    if (verification.outcome === 'REJECTED') {
      this.logger.logWithMetadata(
        'error',
        'Stripe renewal failed payment verification; access not extended',
        {
          context: LOG_CONTEXT,
          providerSubscriptionId: subscriptionId,
          providerPaymentId: ref.id,
          reason: verification.reason,
        },
      );
      return 'REJECTED';
    }
    return this.applyEarlierRefunds(
      verification.payment.providerPaymentId,
      await this.recordRenewal(
        origin.subscriptionId,
        verification.payment,
        metadata,
        now,
      ),
      metadata,
      now,
    );
  }

  /**
   * After a payment newly granted or extended access: a refund made in Stripe
   * before the payment was recorded (its events were answered "retry later")
   * is applied now, so access paid by a refunded payment ends at once rather
   * than at Stripe's next retry. Best effort: the payment stays recorded, and
   * if Stripe cannot be asked, the retried refund events still apply it.
   */
  private async applyEarlierRefunds(
    invoiceId: string,
    outcome: WebhookOutcome,
    metadata: ActivityLogMetadata,
    now: Date,
  ): Promise<WebhookOutcome> {
    if (outcome !== 'ACTIVATED' && outcome !== 'RENEWED') return outcome;
    try {
      const refunded = await this.refunds.syncInvoiceRefunds(
        invoiceId,
        metadata,
        now,
      );
      if (refunded) {
        this.logger.logWithMetadata(
          'warn',
          'Payment was refunded in Stripe before it was recorded; refund applied',
          { context: LOG_CONTEXT, providerInvoiceId: invoiceId, refunded },
        );
      }
    } catch (error) {
      this.logger.logWithMetadata(
        'warn',
        'Could not check a newly recorded payment for refunds; the refund events will apply them',
        {
          context: LOG_CONTEXT,
          providerInvoiceId: invoiceId,
          errorCode: errorCodeOf(error),
        },
      );
    }
    return outcome;
  }

  private recordRenewal(
    subscriptionRecordId: string,
    payment: VerifiedStripeRenewal,
    metadata: ActivityLogMetadata,
    now: Date,
  ): Promise<WebhookOutcome> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockSubscription(tx, subscriptionRecordId);

      if (await this.findPayment(tx, payment.providerPaymentId)) {
        return 'ALREADY_PROCESSED';
      }
      const record = await tx.userSubscription.findUniqueOrThrow({
        where: { id: subscriptionRecordId },
      });
      const logContext = {
        context: LOG_CONTEXT,
        subscriptionId: record.id,
        providerSubscriptionId: payment.providerSubscriptionId,
        providerPaymentId: payment.providerPaymentId,
      };

      // A second, different charge for a period that is already paid.
      const samePeriod = await tx.paymentTransaction.findFirst({
        where: {
          subscriptionId: record.id,
          periodEnd: payment.periodEnd,
          status: { in: VERIFIED_PAYMENT_STATUSES },
        },
      });
      if (samePeriod) {
        this.logger.logWithMetadata(
          'error',
          'Second Stripe payment for an already paid period; refund required',
          { ...logContext, existingPaymentId: samePeriod.id },
        );
        return 'DUPLICATE_PAYMENT';
      }

      const paidAt = payment.paidAt ?? now;
      const saved = await this.createPayment(tx, record.id, payment, paidAt);

      if (
        record.paymentProvider !== STRIPE_PROVIDER ||
        record.providerSubscriptionId !== payment.providerSubscriptionId
      ) {
        // A renewal of a duplicate Stripe subscription (not the one linked to
        // the user's paid term): keep the payment, never stack access.
        this.logger.logWithMetadata(
          'error',
          'Renewal of a Stripe subscription that is not linked to the paid term; access unchanged, refund and cancellation required',
          { ...logContext, paymentId: saved.id },
        );
        return 'DUPLICATE_PAYMENT';
      }

      const renewedEvent = {
        subscriptionId: record.id,
        type: SubscriptionEventType.RENEWED,
        paymentId: saved.id,
        occurredAt: paidAt,
      };

      if (
        record.proExpiresAt !== null &&
        payment.periodEnd.getTime() <= record.proExpiresAt.getTime()
      ) {
        // A delayed delivery for a period the term already covers: record it,
        // but never move the term backwards or overwrite it. The collection
        // still ends a past-due state.
        await tx.subscriptionEvent.create({ data: renewedEvent });
        if (record.pastDueSince !== null) {
          const cleared = { pastDueSince: null };
          await tx.userSubscription.update({
            where: { id: record.id },
            data: cleared,
          });
          await this.audit(tx, record, cleared, metadata);
        }
        return 'ALREADY_COVERED';
      }

      // Contiguous (or overlapping) with the current term: extend it from its
      // expiry. After a gap, the paid period starts a new term. Either way the
      // database trigger re-checks that this payment covers the new range.
      const extendsCurrentTerm =
        record.proStartedAt !== null &&
        record.proExpiresAt !== null &&
        payment.periodStart.getTime() >= record.proStartedAt.getTime() &&
        payment.periodStart.getTime() <= record.proExpiresAt.getTime();
      const next = {
        status: SubscriptionStatus.PRO,
        billingInterval: payment.billingInterval,
        proStartedAt: extendsCurrentTerm
          ? (record.proStartedAt as Date)
          : payment.periodStart,
        proExpiresAt: payment.periodEnd,
        // A collected renewal (including a recovered one) ends past due.
        pastDueSince: null,
      };
      await tx.userSubscription.update({
        where: { id: record.id },
        data: next,
      });
      await tx.subscriptionEvent.create({ data: renewedEvent });
      await this.audit(tx, record, next, metadata);
      return 'RENEWED';
    });
  }

  // -------------------------------------------------------------------------
  // First payment confirmed by its invoice
  // -------------------------------------------------------------------------

  /**
   * `invoice.paid` for the first invoice. Usually the checkout events record
   * it; this also confirms a first payment collected after it had failed (or
   * when the invoice event arrives first). Both paths record the same invoice
   * once, so the term and its CREATED event are never duplicated.
   */
  private async confirmFirstInvoice(
    ref: Stripe.Invoice,
    metadata: ActivityLogMetadata,
    now: Date,
  ): Promise<WebhookOutcome> {
    const subscriptionId = idOf(ref.parent?.subscription_details?.subscription);
    if (!subscriptionId || !ref.id) return 'IGNORED';
    if (await this.findPayment(this.prisma, ref.id)) return 'ALREADY_PROCESSED';

    const origin = await this.findOrigin(subscriptionId, ref);
    if (!origin) return this.unknownSubscription(subscriptionId, ref.id);
    const verification = await this.verifyInvoice(
      ref.id,
      subscriptionId,
      origin,
    );
    if (
      verification.outcome !== 'PAID' ||
      verification.invoice.kind !== 'INITIAL'
    ) {
      return this.rejectInvoice(ref.id, verification);
    }
    const invoice = verification.invoice;
    return this.applyEarlierRefunds(
      invoice.providerInvoiceId,
      await this.recordFirstPayment(
        origin,
        {
          providerSessionId: origin.providerSessionId,
          providerPaymentId: invoice.providerInvoiceId,
          providerSubscriptionId: invoice.providerSubscriptionId,
          amountCents: invoice.amountCents,
          currency: invoice.currency,
          billingInterval: invoice.billingInterval,
          periodStart: invoice.periodStart,
          periodEnd: invoice.periodEnd,
          paidAt: invoice.paidAt,
        },
        metadata,
        now,
      ),
      metadata,
      now,
    );
  }

  // -------------------------------------------------------------------------
  // Failed payments
  // -------------------------------------------------------------------------

  /**
   * `invoice.payment_failed`: one collection attempt of the first invoice or
   * of a renewal failed. Records it as a FAILED attempt and a PAYMENT_FAILED
   * event; a renewal of the linked subscription that is still unpaid marks it
   * past due. The paid term is never touched: users keep access until
   * proExpiresAt, and a failed attempt never grants or extends it.
   */
  private async recordPaymentFailure(
    eventId: string,
    failedAt: Date,
    ref: Stripe.Invoice,
    metadata: ActivityLogMetadata,
  ): Promise<WebhookOutcome> {
    if (
      ref.billing_reason !== 'subscription_create' &&
      ref.billing_reason !== 'subscription_cycle'
    ) {
      return 'IGNORED';
    }
    const subscriptionId = idOf(ref.parent?.subscription_details?.subscription);
    if (!subscriptionId || !ref.id) return 'IGNORED';
    const attemptId = failedAttemptId(ref.id, eventId);
    if (await this.findPayment(this.prisma, attemptId)) {
      return 'ALREADY_PROCESSED';
    }

    const origin = await this.findOrigin(subscriptionId, ref);
    if (!origin) return this.unknownSubscription(subscriptionId, ref.id);
    const verification = await this.verifyInvoice(
      ref.id,
      subscriptionId,
      origin,
    );
    if (verification.outcome === 'REJECTED') {
      return this.rejectInvoice(ref.id, verification);
    }
    // Only ask why while the invoice is still unpaid; best effort.
    const details =
      verification.outcome === 'UNPAID'
        ? await this.stripe.retrievePaymentFailure(ref.id)
        : null;
    return this.recordFailedAttempt(
      origin.subscriptionId,
      verification.invoice,
      verification.outcome === 'UNPAID',
      { attemptId, failedAt, details },
      metadata,
    );
  }

  private recordFailedAttempt(
    subscriptionRecordId: string,
    invoice: VerifiedStripeInvoice,
    stillUnpaid: boolean,
    attempt: {
      attemptId: string;
      failedAt: Date;
      details: PaymentFailureDetails | null;
    },
    metadata: ActivityLogMetadata,
  ): Promise<WebhookOutcome> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockSubscription(tx, subscriptionRecordId);
      if (await this.findPayment(tx, attempt.attemptId)) {
        return 'ALREADY_PROCESSED';
      }
      const record = await tx.userSubscription.findUniqueOrThrow({
        where: { id: subscriptionRecordId },
      });

      const saved = await tx.paymentTransaction.create({
        data: {
          subscriptionId: record.id,
          provider: STRIPE_PROVIDER,
          providerPaymentId: attempt.attemptId,
          providerInvoiceId: invoice.providerInvoiceId,
          status: PaymentStatus.FAILED,
          amountCents: invoice.amountCents,
          currency: invoice.currency,
          billingInterval: invoice.billingInterval,
          periodStart: invoice.periodStart,
          periodEnd: invoice.periodEnd,
          failedAt: attempt.failedAt,
          failureCode: truncate(attempt.details?.code ?? 'payment_failed', 100),
          failureMessage: truncate(attempt.details?.message, 500),
        },
      });
      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: record.id,
          type: SubscriptionEventType.PAYMENT_FAILED,
          occurredAt: attempt.failedAt,
        },
      });

      // A failed renewal of the subscription that backs the paid term is past
      // due while Stripe keeps retrying. A failure reported after the invoice
      // was collected (a delayed event) changes nothing.
      const pastDue =
        invoice.kind === 'RENEWAL' &&
        stillUnpaid &&
        record.paymentProvider === STRIPE_PROVIDER &&
        record.providerSubscriptionId === invoice.providerSubscriptionId &&
        record.pastDueSince === null;
      if (pastDue) {
        const next = { pastDueSince: attempt.failedAt };
        await tx.userSubscription.update({
          where: { id: record.id },
          data: next,
        });
        await this.audit(tx, record, next, metadata);
      }

      this.logger.logWithMetadata('warn', 'Stripe payment attempt failed', {
        context: LOG_CONTEXT,
        subscriptionId: record.id,
        paymentId: saved.id,
        providerInvoiceId: invoice.providerInvoiceId,
        kind: invoice.kind,
        attemptCount: invoice.attemptCount,
        nextRetryAt: iso(invoice.nextRetryAt),
        failureCode: saved.failureCode,
      });
      return 'PAYMENT_FAILED';
    });
  }

  /**
   * `customer.subscription.deleted` for the subscription that backs the paid
   * term (e.g. Stripe gave up after its last retry): no further renewal, so
   * the term is marked canceled and past due ends. Access still runs until
   * proExpiresAt.
   */
  private async endSubscription(
    ref: Stripe.Subscription,
    metadata: ActivityLogMetadata,
    now: Date,
  ): Promise<WebhookOutcome> {
    const linked = await this.prisma.userSubscription.findFirst({
      where: {
        paymentProvider: STRIPE_PROVIDER,
        providerSubscriptionId: ref.id,
      },
      select: { id: true },
    });
    if (!linked) {
      // Ended before its first payment was recorded (a delayed checkout
      // event): retry rather than lose the cancellation.
      await this.retryIfFirstPaymentPending(ref);
      return 'IGNORED';
    }
    // The subscription state comes from the Stripe API, not the payload.
    const subscription = await this.stripe.retrieveSubscription(ref.id);
    if (
      subscription.status !== 'canceled' &&
      subscription.status !== 'incomplete_expired'
    ) {
      return 'IGNORED';
    }
    // The cancellation time is when renewal was turned off (Stripe
    // `canceled_at`), as for user and `customer.subscription.updated`
    // cancellations; `ended_at` only when Stripe has no cancellation time.
    const canceledSeconds = subscription.canceled_at ?? subscription.ended_at;
    const canceledAt = canceledSeconds ? new Date(canceledSeconds * 1000) : now;

    return this.prisma.$transaction(async (tx) => {
      await this.lockSubscription(tx, linked.id);
      const record = await tx.userSubscription.findUniqueOrThrow({
        where: { id: linked.id },
      });
      if (record.providerSubscriptionId !== ref.id) return 'IGNORED';
      const cancel =
        record.proStartedAt !== null && record.proCanceledAt === null;
      if (!cancel && record.pastDueSince === null) return 'ALREADY_PROCESSED';

      const next = {
        pastDueSince: null,
        ...(cancel ? { proCanceledAt: canceledAt } : {}),
      };
      await tx.userSubscription.update({
        where: { id: record.id },
        data: next,
      });
      if (cancel) {
        await tx.subscriptionEvent.create({
          data: {
            subscriptionId: record.id,
            type: SubscriptionEventType.CANCELED,
            occurredAt: canceledAt,
          },
        });
      }
      await this.audit(tx, record, next, metadata);
      return 'SUBSCRIPTION_ENDED';
    });
  }

  /**
   * `customer.subscription.updated`: if the subscription that backs the paid
   * term is scheduled to cancel at period end (confirmed by reading it from
   * Stripe), record the cancellation once. Updates that do not schedule a
   * cancellation (or arrive after it was recorded) change nothing.
   */
  private async syncCancellation(
    ref: Stripe.Subscription,
    metadata: ActivityLogMetadata,
    now: Date,
  ): Promise<WebhookOutcome> {
    const linked = await this.prisma.userSubscription.findFirst({
      where: {
        paymentProvider: STRIPE_PROVIDER,
        providerSubscriptionId: ref.id,
      },
      select: { id: true, proCanceledAt: true },
    });
    if (!linked) return this.cancellationBeforeFirstPayment(ref);
    if (linked.proCanceledAt) return 'ALREADY_PROCESSED';
    if (!ref.cancel_at_period_end) return 'IGNORED';

    // The current state comes from the Stripe API: an older event that
    // scheduled a cancellation later undone in Stripe records nothing.
    const current = toProviderCancellation(
      await this.stripe.retrieveSubscription(ref.id),
    );
    if (!current.cancelAtPeriodEnd) return 'IGNORED';
    const result = await this.cancellation.recordCancellation(
      linked.id,
      ref.id,
      current.canceledAt ?? now,
      { ...metadata, actionedBy: null },
    );
    return result.outcome === 'CANCELED'
      ? 'CANCELED'
      : result.outcome === 'ALREADY_CANCELED'
        ? 'ALREADY_PROCESSED'
        : 'IGNORED';
  }

  /**
   * A cancellation of a subscription whose first payment is not recorded yet
   * (its checkout event is delayed): retried rather than lost. Anything else
   * (e.g. an abandoned checkout's subscription) is ignored.
   */
  private async cancellationBeforeFirstPayment(
    ref: Stripe.Subscription,
  ): Promise<WebhookOutcome> {
    if (!ref.cancel_at_period_end) return 'IGNORED';
    await this.retryIfFirstPaymentPending(ref);
    return 'IGNORED';
  }

  /**
   * Fails with a retryable 503 when `ref` is a MuseCue subscription whose
   * first payment Stripe collected but MuseCue has not recorded yet (the
   * checkout session, read from Stripe, is paid for this subscription). An
   * event about it must then wait for the payment instead of being lost.
   */
  private async retryIfFirstPaymentPending(ref: Stripe.Subscription) {
    const checkoutId = ref.metadata?.[CHECKOUT_METADATA.CHECKOUT_ID];
    if (!checkoutId) return;
    // Also matches a checkout linked to this subscription by a first payment
    // recorded concurrently (after the caller found it unlinked).
    const origin = await this.prisma.checkoutSession.findFirst({
      where: {
        id: checkoutId,
        provider: STRIPE_PROVIDER,
        OR: [
          { providerSubscriptionId: null },
          { providerSubscriptionId: ref.id },
        ],
      },
    });
    if (!origin?.providerSessionId) return;
    const session = await this.stripe.retrieveCheckoutForVerification(
      origin.providerSessionId,
    );
    if (
      session.payment_status !== 'paid' ||
      idOf(session.subscription) !== ref.id ||
      session.metadata?.[CHECKOUT_METADATA.CHECKOUT_ID] !== origin.id
    ) {
      return;
    }
    this.logger.logWithMetadata(
      'warn',
      'Stripe subscription event before the first payment was recorded; retry later',
      { context: LOG_CONTEXT, providerSubscriptionId: ref.id },
    );
    throw AppError.serviceUnavailable(
      'The first payment of this subscription is not recorded yet; retry later',
    );
  }

  /**
   * The checkout that created a Stripe subscription. Its customer, price and
   * interval are what every invoice of the subscription must match. Before the
   * first payment is recorded the checkout is not linked yet; it is then found
   * through the checkout id in the invoice's subscription metadata, which
   * verification re-checks against the subscription read from Stripe.
   */
  private async findOrigin(
    subscriptionId: string,
    ref: Stripe.Invoice | null,
  ): Promise<CheckoutSession | null> {
    const linked = await this.prisma.checkoutSession.findFirst({
      where: {
        provider: STRIPE_PROVIDER,
        providerSubscriptionId: subscriptionId,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (linked) return linked;
    const checkoutId =
      ref?.parent?.subscription_details?.metadata?.[
        CHECKOUT_METADATA.CHECKOUT_ID
      ];
    if (!checkoutId) return null;
    // A first payment recorded between the two queries links the checkout to
    // this subscription; it must still be found (never "unknown"). A checkout
    // linked to another subscription is not this subscription's origin.
    return this.prisma.checkoutSession.findFirst({
      where: {
        id: checkoutId,
        provider: STRIPE_PROVIDER,
        OR: [
          { providerSubscriptionId: null },
          { providerSubscriptionId: subscriptionId },
        ],
      },
    });
  }

  /** Reads the invoice and subscription from Stripe and checks them. */
  private async verifyInvoice(
    invoiceId: string,
    subscriptionId: string,
    origin: CheckoutSession,
  ): Promise<InvoiceVerification> {
    const invoice = await this.stripe.retrieveInvoice(invoiceId);
    const subscription = await this.stripe.retrieveSubscription(subscriptionId);
    return verifyStripeInvoice(invoice, subscription, {
      providerSubscriptionId: subscriptionId,
      providerCustomerId: origin.providerCustomerId,
      billingInterval: origin.billingInterval,
      amountCents: origin.amountCents,
      currency: origin.currency,
      checkoutId: origin.id,
    });
  }

  private rejectInvoice(
    invoiceId: string,
    verification: InvoiceVerification,
  ): WebhookOutcome {
    this.logger.logWithMetadata(
      'error',
      'Stripe invoice failed verification; nothing recorded',
      {
        context: LOG_CONTEXT,
        providerInvoiceId: invoiceId,
        reason:
          verification.outcome === 'REJECTED'
            ? verification.reason
            : verification.outcome === 'UNPAID'
              ? 'INVOICE_NOT_PAID'
              : 'UNEXPECTED_INVOICE_KIND',
      },
    );
    return 'REJECTED';
  }

  private unknownSubscription(
    subscriptionId: string,
    invoiceId: string,
  ): WebhookOutcome {
    this.logger.logWithMetadata(
      'warn',
      'Stripe invoice for an unknown subscription',
      {
        context: LOG_CONTEXT,
        providerSubscriptionId: subscriptionId,
        providerPaymentId: invoiceId,
      },
    );
    return 'UNKNOWN_SUBSCRIPTION';
  }

  // -------------------------------------------------------------------------
  // Shared
  // -------------------------------------------------------------------------

  private async lockSubscription(
    tx: Prisma.TransactionClient,
    subscriptionRecordId: string,
  ) {
    await tx.$queryRaw`
      SELECT "id" FROM "UserSubscription" WHERE "id" = ${subscriptionRecordId} FOR UPDATE
    `;
  }

  private findPayment(
    client: Prisma.TransactionClient,
    providerPaymentId: string,
  ) {
    return client.paymentTransaction.findUnique({
      where: {
        provider_providerPaymentId: {
          provider: STRIPE_PROVIDER,
          providerPaymentId,
        },
      },
    });
  }

  private createPayment(
    tx: Prisma.TransactionClient,
    subscriptionRecordId: string,
    payment: VerifiedStripePayment | VerifiedStripeRenewal,
    paidAt: Date,
  ) {
    return tx.paymentTransaction.create({
      data: {
        subscriptionId: subscriptionRecordId,
        provider: STRIPE_PROVIDER,
        providerPaymentId: payment.providerPaymentId,
        providerInvoiceId: payment.providerPaymentId,
        status: PaymentStatus.SUCCEEDED,
        amountCents: payment.amountCents,
        currency: payment.currency,
        billingInterval: payment.billingInterval,
        periodStart: payment.periodStart,
        periodEnd: payment.periodEnd,
        paidAt,
      },
    });
  }

  /** Audit record of the changed paid-term fields. */
  private async audit(
    tx: Prisma.TransactionClient,
    before: UserSubscription,
    after: Partial<UserSubscription>,
    metadata: ActivityLogMetadata,
  ) {
    const fields: (keyof UserSubscription)[] = [
      'status',
      'billingInterval',
      'proStartedAt',
      'proExpiresAt',
      'proCanceledAt',
      'providerSubscriptionId',
      'pastDueSince',
    ];
    const text = (value: unknown) =>
      value instanceof Date ? iso(value) : ((value as string | null) ?? null);
    const changes: FieldChange[] = fields
      .filter((field) => field in after)
      .map((field) => ({
        fieldName: field,
        oldValue: text(before[field]),
        newValue: text(after[field]),
      }))
      .filter((change) => change.oldValue !== change.newValue);
    await this.activityLog.logActivity(
      {
        tableName: 'UserSubscription',
        recordId: before.id,
        action: 'update',
        changes,
        metadata: { ...metadata, actionedBy: null },
      },
      tx,
    );
  }

  private async close(
    ref: SessionRef,
    status: 'EXPIRED' | 'FAILED',
    reason: string,
    from: CheckoutSessionStatus[],
    now: Date,
  ): Promise<WebhookOutcome> {
    const checkout = await this.findCheckout(ref);
    if (!checkout) return this.unknownCheckout(ref);
    await this.prisma.checkoutSession.updateMany({
      where: { id: checkout.id, status: { in: from } },
      data: {
        status,
        closedAt: now,
        closedReason: reason,
        providerSessionId: ref.id,
      },
    });
    return 'CLOSED';
  }

  /**
   * By the stored Stripe session id, or, for a checkout whose session id was
   * never stored, by the checkout id written into the session metadata.
   */
  private async findCheckout(ref: SessionRef): Promise<CheckoutSession | null> {
    const bySession = await this.prisma.checkoutSession.findUnique({
      where: {
        provider_providerSessionId: {
          provider: STRIPE_PROVIDER,
          providerSessionId: ref.id,
        },
      },
    });
    if (bySession) return bySession;

    const checkoutId = ref.metadata?.[CHECKOUT_METADATA.CHECKOUT_ID];
    if (!checkoutId) return null;
    // The session id may have been stored between the two queries; a
    // checkout stored with another session is not this session's checkout.
    return this.prisma.checkoutSession.findFirst({
      where: {
        id: checkoutId,
        provider: STRIPE_PROVIDER,
        OR: [{ providerSessionId: null }, { providerSessionId: ref.id }],
      },
    });
  }

  private unknownCheckout(ref: SessionRef): WebhookOutcome {
    this.logger.logWithMetadata(
      'warn',
      'Stripe event for an unknown checkout',
      {
        context: LOG_CONTEXT,
        providerSessionId: ref.id,
      },
    );
    return 'UNKNOWN_CHECKOUT';
  }
}

/** A short, non-sensitive class or code of an error (never its message). */
function errorCodeOf(error: unknown): string {
  let code: string;
  if (error instanceof Stripe.errors.StripeError) {
    code = `stripe:${error.rawType ?? error.type}`;
  } else if (error instanceof HttpException) {
    code = `http:${error.getStatus()}`;
  } else if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    code = `db:${error.code}`;
  } else if (error instanceof Error) {
    code = error.name;
  } else {
    code = 'unknown';
  }
  return code.slice(0, 100);
}
