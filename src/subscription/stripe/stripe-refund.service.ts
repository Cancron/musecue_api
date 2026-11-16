import { Injectable } from '@nestjs/common';
import {
  type PaymentRefund,
  PaymentStatus,
  type PaymentTransaction,
  Prisma,
  RefundStatus,
  SubscriptionEventType,
  type UserSubscription,
} from '@prisma/client';
import type Stripe from 'stripe';
import AppError from '../../common/errors/app.error';
import {
  ActivityLogService,
  type ActivityLogMetadata,
} from '../../common/services/activity-log.service';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { resolveSubscriptionAccess } from '../subscription-access.policy';
import { STRIPE_PROVIDER, StripeGateway } from './stripe.gateway';

const LOG_CONTEXT = 'StripeRefundService';

/** Payments whose money was collected and can therefore be refunded. */
const COLLECTED: PaymentStatus[] = [
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
];

const REFUND_STATUSES: Record<string, RefundStatus> = {
  pending: RefundStatus.PENDING,
  requires_action: RefundStatus.REQUIRES_ACTION,
  succeeded: RefundStatus.SUCCEEDED,
  failed: RefundStatus.FAILED,
  canceled: RefundStatus.CANCELED,
};

/** A refund status that can still change. */
const OPEN_REFUND: RefundStatus[] = [
  RefundStatus.PENDING,
  RefundStatus.REQUIRES_ACTION,
];

export type RefundOutcome =
  /** At least one refund newly succeeded: payment updated, access revoked. */
  | 'REFUNDED'
  /** Refunds were recorded or updated, but none newly succeeded. */
  | 'REFUND_RECORDED'
  | 'ALREADY_PROCESSED'
  /** The charge did not pay a subscription invoice MuseCue knows. */
  | 'UNKNOWN_PAYMENT'
  | 'REJECTED';

const idOf = (value: string | { id: string } | null | undefined) =>
  typeof value === 'string' ? value : (value?.id ?? null);

const fromSeconds = (seconds: number) => new Date(seconds * 1000);

/**
 * Records refunds made in Stripe (full or partial; MuseCue has no refund
 * endpoint) and revokes the access they paid for.
 *
 * Every refund event only names a charge; the charge and all of its refunds
 * are read from the Stripe API, and the charge is matched to the recorded
 * payment through the invoice it paid. In one transaction under the user's
 * UserSubscription row lock:
 *
 * - each Stripe refund is stored once (PaymentRefund, keyed by its Stripe id)
 *   with its amount, status, reason, charge and time; a pending refund is
 *   stored but changes nothing until Stripe reports it succeeded;
 * - the payment's refundedAmountCents is the sum of its succeeded refunds,
 *   with status PARTIALLY_REFUNDED or REFUNDED (amounts only ever grow);
 * - each newly succeeded refund appends one PAYMENT_REFUNDED event;
 * - access that the refunded payment granted ends now, even if its period has
 *   not ended. Only that payment's access is revoked: a payment whose period
 *   is already over, or one that never granted access (a duplicate), leaves
 *   the access of newer payments untouched. The term is only ever shortened,
 *   so repeated or delayed events never restore access.
 */
@Injectable()
export class StripeRefundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeGateway,
    private readonly activityLog: ActivityLogService,
    private readonly logger: CustomLoggerService,
  ) {}

  async syncCharge(
    chargeId: string,
    metadata: ActivityLogMetadata,
    now: Date = new Date(),
  ): Promise<RefundOutcome> {
    const charge = await this.stripe.retrieveCharge(chargeId);
    const intentId = idOf(charge.payment_intent);
    const invoiceId = intentId
      ? await this.stripe.findInvoiceForPaymentIntent(intentId)
      : null;
    if (!invoiceId) return this.unknown(chargeId);

    const payment = await this.prisma.paymentTransaction.findUnique({
      where: {
        provider_providerPaymentId: {
          provider: STRIPE_PROVIDER,
          providerPaymentId: invoiceId,
        },
      },
    });
    if (!payment || !COLLECTED.includes(payment.status)) {
      return this.paymentNotRecorded(chargeId, invoiceId, charge);
    }

    const rejection = await this.verifyCharge(charge, payment);
    if (rejection) return this.reject(chargeId, payment.id, rejection);
    const refunds = await this.stripe.listChargeRefunds(chargeId);
    const foreign = refunds.find(
      (refund) =>
        idOf(refund.charge) !== chargeId ||
        refund.currency !== charge.currency ||
        !(refund.amount > 0),
    );
    if (foreign) return this.reject(chargeId, payment.id, 'REFUND_MISMATCH');
    const succeeded = refunds
      .filter((refund) => refund.status === 'succeeded')
      .reduce((total, refund) => total + refund.amount, 0);
    if (succeeded > payment.amountCents) {
      return this.reject(chargeId, payment.id, 'REFUNDS_EXCEED_PAYMENT');
    }

    return this.apply(payment.id, chargeId, refunds, metadata, now);
  }

  /**
   * Refunds of an invoice's charge, for a payment that was just recorded.
   * A refund made in Stripe before its payment was recorded was answered
   * "retry later" (the payment was unknown); applying it as soon as the
   * payment is recorded ends the access it granted at once instead of at
   * Stripe's next retry of the refund event. Returns null when the charge has
   * no refunded money (the usual case: nothing to do).
   */
  async syncInvoiceRefunds(
    invoiceId: string,
    metadata: ActivityLogMetadata,
    now: Date = new Date(),
  ): Promise<RefundOutcome | null> {
    const chargeId = await this.stripe.findChargeForInvoice(invoiceId);
    if (!chargeId) return null;
    const charge = await this.stripe.retrieveCharge(chargeId);
    if (!(charge.amount_refunded > 0)) return null;
    return this.syncCharge(chargeId, metadata, now);
  }

  private apply(
    paymentId: string,
    chargeId: string,
    refunds: Stripe.Refund[],
    metadata: ActivityLogMetadata,
    now: Date,
  ): Promise<RefundOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const { subscriptionId } = await tx.paymentTransaction.findUniqueOrThrow({
        where: { id: paymentId },
        select: { subscriptionId: true },
      });
      if (subscriptionId !== null) {
        await tx.$queryRaw`
          SELECT "id" FROM "UserSubscription" WHERE "id" = ${subscriptionId} FOR UPDATE
        `;
      }
      // Detached payments survive account deletion and still receive refund
      // events. Serialize those events even when no subscription remains.
      await tx.$queryRaw`
        SELECT "id" FROM "PaymentTransaction" WHERE "id" = ${paymentId} FOR UPDATE
      `;
      const payment = await tx.paymentTransaction.findUniqueOrThrow({
        where: { id: paymentId },
      });
      const stored = await tx.paymentRefund.findMany({ where: { paymentId } });

      let changed = false;
      const newlySucceeded: PaymentRefund[] = [];
      for (const refund of refunds) {
        const status = REFUND_STATUSES[refund.status ?? ''] ?? 'PENDING';
        const existing = stored.find(
          (row) => row.providerRefundId === refund.id,
        );
        if (!existing) {
          const row = await tx.paymentRefund.create({
            data: {
              paymentId,
              provider: STRIPE_PROVIDER,
              providerRefundId: refund.id,
              providerChargeId: chargeId,
              status,
              amountCents: refund.amount,
              currency: refund.currency.toUpperCase(),
              reason: refund.reason?.slice(0, 100) ?? null,
              providerCreatedAt: fromSeconds(refund.created),
            },
          });
          changed = true;
          if (status === RefundStatus.SUCCEEDED) newlySucceeded.push(row);
          continue;
        }
        if (existing.status === status) continue;
        if (!OPEN_REFUND.includes(existing.status)) {
          // A final refund never changes here; in particular a refund that
          // succeeded keeps its effect (access is not restored).
          this.logger.logWithMetadata(
            'error',
            'Stripe reports a change to a final refund; kept as recorded',
            {
              context: LOG_CONTEXT,
              paymentId,
              providerRefundId: refund.id,
              recorded: existing.status,
              reported: status,
            },
          );
          continue;
        }
        const row = await tx.paymentRefund.update({
          where: { id: existing.id },
          data: { status },
        });
        changed = true;
        if (status === RefundStatus.SUCCEEDED) newlySucceeded.push(row);
      }

      if (newlySucceeded.length === 0) {
        return changed ? 'REFUND_RECORDED' : 'ALREADY_PROCESSED';
      }

      const all = await tx.paymentRefund.findMany({
        where: { paymentId, status: RefundStatus.SUCCEEDED },
      });
      const refundedAmountCents = all.reduce(
        (total, row) => total + row.amountCents,
        0,
      );
      if (refundedAmountCents > payment.refundedAmountCents) {
        const refundedAt = new Date(
          Math.max(...all.map((row) => row.providerCreatedAt.getTime())),
        );
        await tx.paymentTransaction.update({
          where: { id: paymentId },
          data: {
            refundedAmountCents,
            refundedAt,
            status:
              refundedAmountCents >= payment.amountCents
                ? PaymentStatus.REFUNDED
                : PaymentStatus.PARTIALLY_REFUNDED,
          },
        });
      }
      if (payment.subscriptionId !== null) {
        for (const row of newlySucceeded) {
          await tx.subscriptionEvent.create({
            data: {
              subscriptionId: payment.subscriptionId,
              type: SubscriptionEventType.PAYMENT_REFUNDED,
              occurredAt: row.providerCreatedAt,
            },
          });
        }
      }
      await this.revokeAccess(tx, payment, metadata, now);
      this.logger.logWithMetadata('warn', 'Stripe refund recorded', {
        context: LOG_CONTEXT,
        paymentId,
        refunds: newlySucceeded.map((row) => row.providerRefundId),
        refundedAmountCents,
        amountCents: payment.amountCents,
      });
      return 'REFUNDED';
    });
  }

  /**
   * Ends the access the refunded payment granted, now. A payment grants
   * access if it created or renewed the paid term (it has a CREATED or
   * RENEWED event); only the part of the term it paid for that is still to
   * come is removed. The term is only ever shortened.
   */
  private async revokeAccess(
    tx: Prisma.TransactionClient,
    payment: PaymentTransaction,
    metadata: ActivityLogMetadata,
    now: Date,
  ) {
    if (payment.subscriptionId === null) return;
    const granted = await tx.subscriptionEvent.findFirst({
      where: {
        paymentId: payment.id,
        type: {
          in: [SubscriptionEventType.CREATED, SubscriptionEventType.RENEWED],
        },
      },
    });
    if (!granted) return;
    // The refunded period is already over: the access it paid for has been
    // used, and any current access comes from newer payments.
    if (payment.periodEnd.getTime() <= now.getTime()) return;

    const record = await tx.userSubscription.findUniqueOrThrow({
      where: { id: payment.subscriptionId },
    });
    if (!record.proStartedAt || !record.proExpiresAt) return;
    // Access before a refunded future period was paid by earlier payments.
    const cut = Math.max(now.getTime(), payment.periodStart.getTime());
    // A term always ends after it starts (CHECK); revoking a term that has
    // not started yet (clock skew) leaves only its first millisecond.
    const end = new Date(
      Math.max(
        Math.min(record.proExpiresAt.getTime(), cut),
        record.proStartedAt.getTime() + 1,
      ),
    );
    if (end.getTime() >= record.proExpiresAt.getTime()) return;

    const next = {
      proExpiresAt: end,
      status: resolveSubscriptionAccess({ ...record, proExpiresAt: end }, now)
        .status,
    };
    await tx.userSubscription.update({ where: { id: record.id }, data: next });
    await this.audit(tx, record, next, metadata);
  }

  private async audit(
    tx: Prisma.TransactionClient,
    before: UserSubscription,
    after: { proExpiresAt: Date; status: UserSubscription['status'] },
    metadata: ActivityLogMetadata,
  ) {
    const changes = [
      {
        fieldName: 'proExpiresAt',
        oldValue: before.proExpiresAt?.toISOString() ?? null,
        newValue: after.proExpiresAt.toISOString(),
      },
      { fieldName: 'status', oldValue: before.status, newValue: after.status },
    ].filter((change) => change.oldValue !== change.newValue);
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

  /** The charge must be the user's own, in USD, for the recorded amount. */
  private async verifyCharge(
    charge: Stripe.Charge,
    payment: PaymentTransaction,
  ): Promise<string | null> {
    if (charge.currency !== payment.currency.toLowerCase()) {
      return 'CURRENCY_MISMATCH';
    }
    if (charge.amount !== payment.amountCents) return 'AMOUNT_MISMATCH';
    // syncCharge matched the Stripe-fetched charge to this immutable payment
    // through its invoice. Account deletion removes the customer/subscription
    // mapping, but must not prevent recording subsequent financial events.
    if (payment.subscriptionId === null) return null;
    const record = await this.prisma.userSubscription.findUniqueOrThrow({
      where: { id: payment.subscriptionId },
      select: { authId: true },
    });
    const customer = await this.prisma.paymentCustomer.findUnique({
      where: {
        authId_provider: { authId: record.authId, provider: STRIPE_PROVIDER },
      },
    });
    if (!customer || idOf(charge.customer) !== customer.providerCustomerId) {
      return 'CUSTOMER_MISMATCH';
    }
    return null;
  }

  /**
   * The charge paid an invoice whose payment is not recorded yet (its
   * `invoice.paid` or checkout event has not been processed). If it belongs
   * to a MuseCue customer, fail so Stripe retries the refund event later;
   * otherwise it is not a MuseCue payment.
   */
  private async paymentNotRecorded(
    chargeId: string,
    invoiceId: string,
    charge: Stripe.Charge,
  ): Promise<RefundOutcome> {
    const customerId = idOf(charge.customer);
    const known = customerId
      ? await this.prisma.paymentCustomer.findFirst({
          where: { provider: STRIPE_PROVIDER, providerCustomerId: customerId },
        })
      : null;
    if (!known) return this.unknown(chargeId);
    this.logger.logWithMetadata(
      'warn',
      'Stripe refund for a payment that is not recorded yet; retry later',
      { context: LOG_CONTEXT, providerChargeId: chargeId, invoiceId },
    );
    throw AppError.serviceUnavailable(
      'The refunded payment is not recorded yet; retry later',
    );
  }

  private unknown(chargeId: string): RefundOutcome {
    this.logger.logWithMetadata(
      'warn',
      'Stripe refund for a charge that paid no MuseCue invoice',
      { context: LOG_CONTEXT, providerChargeId: chargeId },
    );
    return 'UNKNOWN_PAYMENT';
  }

  private reject(
    chargeId: string,
    paymentId: string,
    reason: string,
  ): RefundOutcome {
    this.logger.logWithMetadata(
      'error',
      'Stripe refund failed verification; nothing recorded',
      { context: LOG_CONTEXT, providerChargeId: chargeId, paymentId, reason },
    );
    return 'REJECTED';
  }
}
