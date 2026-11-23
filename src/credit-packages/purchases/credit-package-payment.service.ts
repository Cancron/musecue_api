import { Injectable } from '@nestjs/common';
import {
  CreditPackageOrderStatus,
  PaymentStatus,
  type CreditPackageOrder,
  type Prisma,
} from '@prisma/client';
import type Stripe from 'stripe';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { hashPaymentFingerprint } from '../../referrals/payment-fingerprint';
import {
  type PaymentMethodCheck,
  ReferralRewardService,
} from '../../referrals/referral-reward.service';
import { CheckoutDiscountService } from '../../subscription/discounts/checkout-discount.service';
import {
  PACKAGE_CHECKOUT_METADATA,
  STRIPE_PROVIDER,
  StripeGateway,
} from '../../subscription/stripe/stripe.gateway';
import { notificationContent } from '../../notifications/notification.policy';
import { NotificationService } from '../../notifications/notification.service';
import { CreditFulfillmentService } from '../fulfillment/credit-fulfillment.service';
import { verifyPackageCheckout } from './credit-package-order.policy';

/** Payment and credit work can wait for row locks under load. */
const ORDER_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

const LOG_CONTEXT = 'CreditPackagePaymentService';

/** What a credit package webhook did (part of the webhook outcomes). */
export type PackageWebhookOutcome =
  | 'CREDITS_GRANTED'
  /** The payment was recorded; its credits are granted later (scheduled
   * gift, held for review, or a failed attempt being retried). */
  | 'PAYMENT_RECORDED'
  | 'ALREADY_PROCESSED'
  | 'AWAITING_PAYMENT'
  | 'REJECTED'
  | 'CLOSED'
  | 'IGNORED'
  | 'UNKNOWN_CHECKOUT';

type SessionRef = Pick<Stripe.Checkout.Session, 'id' | 'metadata'>;

/** Orders that can still be paid. */
const PAYABLE: CreditPackageOrderStatus[] = [
  CreditPackageOrderStatus.CREATING,
  CreditPackageOrderStatus.OPEN,
  CreditPackageOrderStatus.PROCESSING,
];

export const NO_PAYMENT_METHOD: PaymentMethodCheck = {
  hash: null,
  unavailable: false,
};

/**
 * Payments of credit package orders (Stripe Checkout in payment mode),
 * from the verified Stripe webhook (StripeWebhookService routes the
 * checkout events of package orders here):
 *
 * - `checkout.session.completed` / `async_payment_succeeded`: the session
 *   is read again from the Stripe API with its PaymentIntent and verified
 *   against the order (this order, its customer, exactly its amount in USD,
 *   collected). Only then, in one transaction under the order's row lock,
 *   the order becomes PAID and its PURCHASE credits (never expiring,
 *   reference `credit-package:<order id>`) are granted, its discount is
 *   redeemed and the purchase counts for referrals (the referrer's reward on
 *   the first paying purchase). Replayed or concurrent deliveries find the
 *   order PAID and grant nothing (the database also allows one allocation
 *   per reference and requires a PAID order for it).
 * - a completed session whose delayed payment has not settled: PROCESSING,
 *   nothing granted.
 * - `checkout.session.async_payment_failed` (FAILED) and
 *   `checkout.session.expired` (EXPIRED, abandoned): closed; the discount
 *   reservation is given back.
 * Failed, canceled, abandoned or unverified payments never grant credits.
 */
@Injectable()
export class CreditPackagePaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeGateway,
    private readonly discounts: CheckoutDiscountService,
    private readonly referralRewards: ReferralRewardService,
    private readonly fulfillments: CreditFulfillmentService,
    private readonly notifications: NotificationService,
    private readonly logger: CustomLoggerService,
  ) {}

  /** Whether a checkout session is a credit package checkout. */
  isPackageSession(ref: { metadata?: Stripe.Metadata | null }): boolean {
    return Boolean(ref.metadata?.[PACKAGE_CHECKOUT_METADATA.ORDER_ID]);
  }

  async confirm(
    ref: SessionRef,
    now: Date,
    options: { closeIfExpired?: boolean } = {},
  ): Promise<PackageWebhookOutcome> {
    const order = await this.findOrder(ref);
    if (!order) return this.unknown(ref);
    if (order.status === CreditPackageOrderStatus.PAID) {
      await this.resumeFulfillment(order.id, now);
      return 'ALREADY_PROCESSED';
    }

    // Payment facts come from the Stripe API, not from the event payload.
    const session = await this.stripe.retrievePackageCheckout(ref.id);
    const verification = verifyPackageCheckout(session, order);
    switch (verification.outcome) {
      case 'NOT_PAID':
        if (options.closeIfExpired && session.status === 'expired') {
          await this.close(
            order.id,
            CreditPackageOrderStatus.EXPIRED,
            'PROVIDER_EXPIRED',
            [CreditPackageOrderStatus.CREATING, CreditPackageOrderStatus.OPEN],
            now,
            session.id,
          );
          return 'CLOSED';
        }
        return 'IGNORED';
      case 'REJECTED':
        this.logger.logWithMetadata(
          'error',
          'Credit package payment failed verification; no credits granted',
          {
            context: LOG_CONTEXT,
            orderId: order.id,
            providerSessionId: session.id,
            reason: verification.reason,
          },
        );
        return 'REJECTED';
      case 'AWAITING_PAYMENT':
        await this.prisma.creditPackageOrder.updateMany({
          where: {
            id: order.id,
            status: {
              in: [
                CreditPackageOrderStatus.CREATING,
                CreditPackageOrderStatus.OPEN,
              ],
            },
          },
          data: {
            status: CreditPackageOrderStatus.PROCESSING,
            providerSessionId: verification.providerSessionId,
            url: null,
          },
        });
        return 'AWAITING_PAYMENT';
      case 'PAID':
        break;
    }
    const paymentMethod: PaymentMethodCheck = {
      hash: verification.paymentMethodFingerprint
        ? hashPaymentFingerprint(
            STRIPE_PROVIDER,
            verification.paymentMethodFingerprint,
          )
        : null,
      unavailable: false,
    };

    const recorded = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockOrder(tx, order.id);
      if (current.status === CreditPackageOrderStatus.PAID) {
        return null;
      }
      if (!current.authId) {
        this.logger.logWithMetadata(
          'error',
          'Credit package paid after the account was deleted; refund required',
          { context: LOG_CONTEXT, orderId: current.id },
        );
        return 'IGNORED';
      }
      if (!PAYABLE.includes(current.status)) {
        // Stripe collected it after the order was closed locally (e.g. a
        // session paid while it was being canceled): the customer paid, so
        // the credits are granted.
        this.logger.logWithMetadata(
          'warn',
          'Verified payment of a closed credit package order; credits granted',
          { context: LOG_CONTEXT, orderId: current.id, status: current.status },
        );
      }
      return this.recordPayment(
        tx,
        { ...current, authId: current.authId },
        {
          paymentIntentId: verification.paymentIntentId,
          providerSessionId: verification.providerSessionId,
        },
        paymentMethod,
        now,
      );
    }, ORDER_TRANSACTION_OPTIONS);
    if (recorded === null) {
      await this.resumeFulfillment(order.id, now);
      return 'ALREADY_PROCESSED';
    }
    if (typeof recorded === 'string') return recorded;
    // The credits are granted from the fulfillment recorded with the
    // payment; if this fails or the process stops here, the fulfillment
    // worker grants them.
    const outcome = await this.fulfillments.processOne(recorded.id, now);
    return outcome === 'SUCCEEDED' ? 'CREDITS_GRANTED' : 'PAYMENT_RECORDED';
  }

  /**
   * A repeated payment event of a paid order: if its credits were not
   * granted yet (the process stopped after recording the payment), one
   * attempt now (the fulfillment worker would do it too).
   */
  private async resumeFulfillment(orderId: string, now: Date) {
    const fulfillment = await this.prisma.creditFulfillment.findUnique({
      where: { orderId },
      select: { id: true, status: true },
    });
    if (fulfillment?.status === 'PENDING') {
      await this.fulfillments.processOne(fulfillment.id, now);
    }
  }

  /**
   * Recovery of an order whose payment events were lost or failed: its
   * checkout is read from Stripe; a verified payment is recorded like the
   * webhook would, an expired session closes the order.
   */
  async reconcile(orderId: string, now: Date): Promise<PackageWebhookOutcome> {
    const order = await this.prisma.creditPackageOrder.findUnique({
      where: { id: orderId },
    });
    if (
      !order?.providerSessionId ||
      (order.status !== CreditPackageOrderStatus.OPEN &&
        order.status !== CreditPackageOrderStatus.PROCESSING)
    ) {
      return 'IGNORED';
    }
    return this.confirm(
      {
        id: order.providerSessionId,
        metadata: { [PACKAGE_CHECKOUT_METADATA.ORDER_ID]: order.id },
      },
      now,
      { closeIfExpired: true },
    );
  }

  /**
   * `async_payment_failed` (FAILED) or `expired` (EXPIRED): the order is
   * closed and its discount reservation given back.
   */
  async closeFromWebhook(
    ref: SessionRef,
    status: 'FAILED' | 'EXPIRED',
    reason: string,
    now: Date,
  ): Promise<PackageWebhookOutcome> {
    const order = await this.findOrder(ref);
    if (!order) return this.unknown(ref);
    const from =
      status === CreditPackageOrderStatus.EXPIRED
        ? [CreditPackageOrderStatus.CREATING, CreditPackageOrderStatus.OPEN]
        : PAYABLE;
    await this.close(order.id, status, reason, from, now, ref.id);
    return 'CLOSED';
  }

  /**
   * Closes an order that can no longer be paid (if still in one of `from`)
   * and gives its discount reservation back. True if it was closed now.
   */
  async close(
    orderId: string,
    status: 'FAILED' | 'EXPIRED' | 'CANCELED',
    reason: string,
    from: CreditPackageOrderStatus[],
    now: Date,
    providerSessionId?: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.lockOrder(tx, orderId);
      if (!from.includes(current.status)) return false;
      await tx.creditPackageOrder.update({
        where: { id: orderId },
        data: {
          status,
          closedAt: now,
          closedReason: reason,
          url: null,
          ...(providerSessionId && !current.providerSessionId
            ? { providerSessionId }
            : {}),
        },
      });
      await this.discounts.releaseForPackageOrder(tx, orderId, reason, now);
      if (reason === 'ASYNC_PAYMENT_FAILED' && current.authId) {
        // The payer learns that the payment failed (nothing was charged).
        await this.notifications.notify(
          tx,
          current.authId,
          `purchase-failed:${orderId}`,
          notificationContent.creditPurchaseFailed(orderId, current.credits),
        );
      }
      return true;
    }, ORDER_TRANSACTION_OPTIONS);
  }

  /**
   * Makes the order PAID with its discount and referral effects and writes
   * the fulfillment that grants its credits, in the caller's transaction
   * (which holds the order's row lock). Used for verified Stripe payments
   * and for fully discounted orders (nothing to charge; not a paying
   * purchase for referral rewards). The credits are granted by
   * CreditFulfillmentService.processOne after the commit.
   */
  async recordPayment(
    tx: Prisma.TransactionClient,
    order: CreditPackageOrder & { authId: string },
    payment: { paymentIntentId: string | null; providerSessionId?: string },
    paymentMethod: PaymentMethodCheck,
    now: Date,
  ) {
    const paid = await tx.creditPackageOrder.update({
      where: { id: order.id },
      data: {
        status: CreditPackageOrderStatus.PAID,
        paidAt: now,
        providerPaymentIntentId: payment.paymentIntentId,
        url: null,
        ...(payment.providerSessionId && !order.providerSessionId
          ? { providerSessionId: payment.providerSessionId }
          : {}),
      },
    });
    await this.discounts.redeemForPackageOrder(tx, order.id, now);
    // A paid package purchase (also a gift, for its sender) is a paid
    // purchase for referrals: the referred user's first paying one rewards
    // the referrer, once.
    await this.referralRewards.onVerifiedPayment(
      tx,
      order.authId,
      {
        id: order.id,
        amountCents: order.amountUsdCents,
        status: PaymentStatus.SUCCEEDED,
        kind: 'CREDIT_PACKAGE',
      },
      paymentMethod,
      now,
    );
    return this.fulfillments.create(tx, paid, now);
  }

  private async lockOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<CreditPackageOrder> {
    await tx.$queryRaw`
      SELECT "id" FROM "CreditPackageOrder" WHERE "id" = ${orderId} FOR UPDATE
    `;
    return tx.creditPackageOrder.findUniqueOrThrow({ where: { id: orderId } });
  }

  /**
   * By the stored Stripe session id, or, for an order whose session id was
   * never stored, by the order id in the session metadata (an order stored
   * with another session is not this session's order).
   */
  private async findOrder(ref: SessionRef): Promise<CreditPackageOrder | null> {
    const bySession = await this.prisma.creditPackageOrder.findUnique({
      where: {
        provider_providerSessionId: {
          provider: STRIPE_PROVIDER,
          providerSessionId: ref.id,
        },
      },
    });
    if (bySession) return bySession;
    const orderId = ref.metadata?.[PACKAGE_CHECKOUT_METADATA.ORDER_ID];
    if (!orderId) return null;
    return this.prisma.creditPackageOrder.findFirst({
      where: {
        id: orderId,
        provider: STRIPE_PROVIDER,
        OR: [{ providerSessionId: null }, { providerSessionId: ref.id }],
      },
    });
  }

  private unknown(ref: SessionRef): PackageWebhookOutcome {
    this.logger.logWithMetadata(
      'warn',
      'Stripe event for an unknown credit package order',
      { context: LOG_CONTEXT, providerSessionId: ref.id },
    );
    return 'UNKNOWN_CHECKOUT';
  }
}
