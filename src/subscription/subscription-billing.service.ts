import { Injectable } from '@nestjs/common';
import {
  type PaymentRefund,
  PaymentStatus,
  type PaymentTransaction,
  SubscriptionEventType,
} from '@prisma/client';
import { PrismaService } from '../common/services/prisma.service';
import { PAYMENT_HISTORY_LIMITS } from './dto/payment-history-query.dto';
import type {
  BillingInfoView,
  PaymentHistoryEntry,
  PaymentHistoryView,
  PaymentPurpose,
  SubscriptionState,
} from './interfaces/billing.interface';
import {
  isProActive,
  resolveSubscriptionAccess,
} from './subscription-access.policy';
import { SUBSCRIPTION_PLAN_CURRENCY } from './subscription-plan.constants';

/** Payments whose money was collected (possibly refunded later). */
const COLLECTED: PaymentStatus[] = [
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
];

/**
 * Decline codes that may be shown to the customer. Stripe advises showing
 * codes that could help fraud (e.g. `stolen_card`, `lost_card`, `fraudulent`,
 * `pickup_card`) only as a generic decline, so anything not listed here is
 * reported as `card_declined`.
 */
const SHOWN_FAILURE_REASONS = new Set([
  'payment_failed',
  'card_declined',
  'insufficient_funds',
  'expired_card',
  'incorrect_cvc',
  'incorrect_number',
  'invalid_cvc',
  'invalid_expiry_month',
  'invalid_expiry_year',
  'authentication_required',
  'processing_error',
  'try_again_later',
]);

const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;

/**
 * Read-only billing information and payment history of the caller.
 *
 * Everything comes from PostgreSQL, where only verified Stripe events write
 * (checkout, invoices, failures, refunds, cancellation); nothing here calls
 * Stripe or keeps state in memory, so the same data gives the same answer
 * after a restart. The user comes from the access token; only their own
 * UserSubscription, payments and refunds are read. Provider identifiers
 * (Stripe customer, subscription, invoice, charge and refund ids), failure
 * messages and credentials are never returned.
 */
@Injectable()
export class SubscriptionBillingService {
  constructor(private readonly prisma: PrismaService) {}

  async getBilling(
    authId: string,
    now: Date = new Date(),
  ): Promise<BillingInfoView> {
    const record = await this.prisma.userSubscription.findUnique({
      where: { authId },
    });
    const access = resolveSubscriptionAccess(record, now);
    const base = {
      status: access.status,
      hasProAccess: access.hasProAccess,
      accessExpiresAt: iso(access.accessExpiresAt),
    };
    if (
      !record ||
      !record.proStartedAt ||
      !record.proExpiresAt ||
      !record.billingInterval
    ) {
      return {
        ...base,
        subscriptionState: 'NONE',
        plan: null,
        currentPeriod: null,
        autoRenew: false,
        nextRenewalAt: null,
        canceledAt: null,
        pastDueSince: null,
      };
    }

    // Newest period first; a total order so the answer never depends on
    // how the database returns rows.
    const payments = (
      await this.prisma.paymentTransaction.findMany({
        where: { subscriptionId: record.id, status: { in: COLLECTED } },
      })
    ).sort(
      (a, b) =>
        b.periodEnd.getTime() - a.periodEnd.getTime() ||
        b.createdAt.getTime() - a.createdAt.getTime() ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    // The subscription's price is the one it was bought at (renewals charge
    // it too), not the plan's current price.
    const origin = record.providerSubscriptionId
      ? await this.prisma.checkoutSession.findFirst({
          where: {
            subscriptionId: record.id,
            providerSubscriptionId: record.providerSubscriptionId,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : null;
    const latestPaid = payments.find(
      (payment) => payment.billingInterval === record.billingInterval,
    );

    const active = isProActive(record, now);
    const current = active
      ? payments.find(
          (payment) =>
            payment.status === PaymentStatus.SUCCEEDED &&
            payment.periodStart.getTime() <= now.getTime() &&
            now.getTime() < payment.periodEnd.getTime(),
        )
      : undefined;
    const canceled = record.proCanceledAt !== null;
    const pastDue = record.pastDueSince !== null;
    const linked =
      record.paymentProvider !== null && record.providerSubscriptionId !== null;
    const autoRenew = active && linked && !canceled && !pastDue;
    const subscriptionState: SubscriptionState = pastDue
      ? 'PAST_DUE'
      : active
        ? canceled
          ? 'CANCELED'
          : 'ACTIVE'
        : 'ENDED';

    return {
      ...base,
      subscriptionState,
      plan: {
        code: 'PRO',
        billingInterval: record.billingInterval,
        priceCents: origin?.amountCents ?? latestPaid?.amountCents ?? null,
        currency:
          origin?.currency ??
          latestPaid?.currency ??
          SUBSCRIPTION_PLAN_CURRENCY,
      },
      currentPeriod: active
        ? current
          ? {
              start: current.periodStart.toISOString(),
              end: current.periodEnd.toISOString(),
            }
          : {
              start: record.proStartedAt.toISOString(),
              end: record.proExpiresAt.toISOString(),
            }
        : null,
      autoRenew,
      nextRenewalAt: autoRenew ? record.proExpiresAt.toISOString() : null,
      canceledAt: iso(record.proCanceledAt),
      pastDueSince: iso(record.pastDueSince),
    };
  }

  async getPaymentHistory(
    authId: string,
    query: { page?: number; limit?: number } = {},
  ): Promise<PaymentHistoryView> {
    const page = query.page ?? 1;
    const limit = query.limit ?? PAYMENT_HISTORY_LIMITS.DEFAULT_LIMIT;
    const record = await this.prisma.userSubscription.findUnique({
      where: { authId },
      select: { id: true },
    });
    const entries = record ? await this.entriesOf(record.id) : [];

    const total = entries.length;
    const totalPages = Math.ceil(total / limit);
    return {
      items: entries.slice((page - 1) * limit, page * limit),
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasPreviousPage: page > 1,
        hasNextPage: page < totalPages,
      },
    };
  }

  /** Every payment attempt and refund of one subscription, newest first. */
  private async entriesOf(
    subscriptionId: string,
  ): Promise<PaymentHistoryEntry[]> {
    const payments = await this.prisma.paymentTransaction.findMany({
      where: { subscriptionId },
    });
    if (payments.length === 0) return [];
    const [refunds, events] = await Promise.all([
      this.prisma.paymentRefund.findMany({
        where: { paymentId: { in: payments.map((payment) => payment.id) } },
      }),
      this.prisma.subscriptionEvent.findMany({
        where: {
          subscriptionId,
          type: {
            in: [SubscriptionEventType.CREATED, SubscriptionEventType.RENEWED],
          },
        },
      }),
    ]);

    const purposeOf = this.purposes(payments, events);
    const byId = new Map(payments.map((payment) => [payment.id, payment]));
    const entries = [
      ...payments.map((payment) => ({
        sortDate: this.paymentDate(payment),
        createdAt: payment.createdAt,
        entry: this.paymentEntry(payment, purposeOf(payment)),
      })),
      ...refunds.map((refund) => {
        const payment = byId.get(refund.paymentId) as PaymentTransaction;
        return {
          sortDate: refund.providerCreatedAt,
          createdAt: refund.createdAt,
          entry: this.refundEntry(refund, payment, purposeOf(payment)),
        };
      }),
    ];
    // A total order (date, then record time, then id) keeps pages stable.
    entries.sort(
      (a, b) =>
        b.sortDate.getTime() - a.sortDate.getTime() ||
        b.createdAt.getTime() - a.createdAt.getTime() ||
        (a.entry.id < b.entry.id ? 1 : a.entry.id > b.entry.id ? -1 : 0),
    );
    return entries.map(({ entry }) => entry);
  }

  /**
   * Whether a payment started the subscription or renewed it. A payment that
   * granted access says so through its CREATED/RENEWED event; a failed
   * attempt shares its invoice with the eventual payment, or otherwise
   * renews when its period continues an earlier paid period.
   */
  private purposes(
    payments: PaymentTransaction[],
    events: { type: SubscriptionEventType; paymentId: string | null }[],
  ): (payment: PaymentTransaction) => PaymentPurpose {
    const eventPurpose = new Map<string, PaymentPurpose>();
    for (const event of events) {
      if (!event.paymentId) continue;
      eventPurpose.set(
        event.paymentId,
        event.type === SubscriptionEventType.RENEWED
          ? 'RENEWAL'
          : 'NEW_SUBSCRIPTION',
      );
    }
    const invoicePurpose = new Map<string, PaymentPurpose>();
    for (const payment of payments) {
      const purpose = eventPurpose.get(payment.id);
      if (purpose && payment.providerInvoiceId) {
        invoicePurpose.set(
          `${payment.provider}:${payment.providerInvoiceId}`,
          purpose,
        );
      }
    }
    const paidPeriodEnds = new Set(
      payments
        .filter((payment) => COLLECTED.includes(payment.status))
        .map((payment) => payment.periodEnd.getTime()),
    );
    return (payment) =>
      eventPurpose.get(payment.id) ??
      (payment.providerInvoiceId
        ? invoicePurpose.get(`${payment.provider}:${payment.providerInvoiceId}`)
        : undefined) ??
      (paidPeriodEnds.has(payment.periodStart.getTime())
        ? 'RENEWAL'
        : 'NEW_SUBSCRIPTION');
  }

  private paymentDate(payment: PaymentTransaction): Date {
    return payment.paidAt ?? payment.failedAt ?? payment.createdAt;
  }

  private paymentEntry(
    payment: PaymentTransaction,
    purpose: PaymentPurpose,
  ): PaymentHistoryEntry {
    return {
      id: payment.id,
      type: 'PAYMENT',
      purpose,
      status: payment.status,
      amountCents: payment.amountCents,
      currency: payment.currency,
      date: this.paymentDate(payment).toISOString(),
      billingInterval: payment.billingInterval,
      period: {
        start: payment.periodStart.toISOString(),
        end: payment.periodEnd.toISOString(),
      },
      refundedAmountCents: payment.refundedAmountCents,
      paymentId: null,
      failureReason:
        payment.status === PaymentStatus.FAILED
          ? this.failureReason(payment.failureCode)
          : null,
    };
  }

  private refundEntry(
    refund: PaymentRefund,
    payment: PaymentTransaction,
    purpose: PaymentPurpose,
  ): PaymentHistoryEntry {
    return {
      id: refund.id,
      type: 'REFUND',
      purpose,
      status: refund.status,
      amountCents: refund.amountCents,
      currency: refund.currency,
      date: refund.providerCreatedAt.toISOString(),
      billingInterval: payment.billingInterval,
      period: {
        start: payment.periodStart.toISOString(),
        end: payment.periodEnd.toISOString(),
      },
      refundedAmountCents: null,
      paymentId: payment.id,
      failureReason: null,
    };
  }

  private failureReason(code: string | null): string {
    return code && SHOWN_FAILURE_REASONS.has(code) ? code : 'card_declined';
  }
}
