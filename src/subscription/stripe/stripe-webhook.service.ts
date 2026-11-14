import { Injectable } from '@nestjs/common';
import {
  type CheckoutSession,
  CheckoutSessionStatus,
  PaymentStatus,
  Prisma,
  SubscriptionEventType,
  SubscriptionStatus,
  type UserSubscription,
} from '@prisma/client';
import type Stripe from 'stripe';
import {
  ActivityLogService,
  type ActivityLogMetadata,
  type FieldChange,
} from '../../common/services/activity-log.service';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { isProActive } from '../subscription-access.policy';
import { PENDING_CHECKOUT_STATUSES } from './stripe-checkout.service';
import {
  type VerifiedStripePayment,
  type VerifiedStripeRenewal,
  verifyStripeCheckout,
  verifyStripeRenewal,
} from './stripe-payment.verification';
import {
  CHECKOUT_METADATA,
  STRIPE_PROVIDER,
  StripeGateway,
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
  | 'REJECTED'
  | 'CLOSED';

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
 *   (RENEWED event).
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
  ) {}

  verifyEvent(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Stripe.Event {
    return this.stripe.constructEvent(rawBody, signature);
  }

  async handleEvent(
    event: Stripe.Event,
    metadata: ActivityLogMetadata,
    now: Date = new Date(),
  ): Promise<WebhookOutcome> {
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
        return this.confirmRenewal(event.data.object, metadata, now);
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
    return this.recordFirstPayment(
      checkout,
      verification.payment,
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
        providerSessionId: payment.providerSessionId,
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
    const origin = await this.prisma.checkoutSession.findFirst({
      where: {
        provider: STRIPE_PROVIDER,
        providerSubscriptionId: subscriptionId,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!origin) {
      this.logger.logWithMetadata(
        'warn',
        'Stripe renewal for an unknown subscription',
        {
          context: LOG_CONTEXT,
          providerSubscriptionId: subscriptionId,
          providerPaymentId: ref.id,
        },
      );
      return 'UNKNOWN_SUBSCRIPTION';
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
    return this.recordRenewal(
      origin.subscriptionId,
      verification.payment,
      metadata,
      now,
    );
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
        // but never move the term backwards or overwrite it.
        await tx.subscriptionEvent.create({ data: renewedEvent });
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
      'providerSubscriptionId',
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
    return this.prisma.checkoutSession.findFirst({
      where: {
        id: checkoutId,
        provider: STRIPE_PROVIDER,
        providerSessionId: null,
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
