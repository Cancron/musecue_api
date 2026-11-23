import { Injectable } from '@nestjs/common';
import {
  CreditPackageOrderStatus,
  CreditSource,
  PaymentStatus,
  type CreditPackageOrder,
  type Prisma,
} from '@prisma/client';
import type Stripe from 'stripe';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { CreditWalletService } from '../../credits/credit-wallet.service';
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
import {
  packageOrderCreditReference,
  verifyPackageCheckout,
} from './credit-package-order.policy';

const LOG_CONTEXT = 'CreditPackagePaymentService';

/** What a credit package webhook did (part of the webhook outcomes). */
export type PackageWebhookOutcome =
  | 'CREDITS_GRANTED'
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
    private readonly wallet: CreditWalletService,
    private readonly discounts: CheckoutDiscountService,
    private readonly referralRewards: ReferralRewardService,
    private readonly logger: CustomLoggerService,
  ) {}

  /** Whether a checkout session is a credit package checkout. */
  isPackageSession(ref: { metadata?: Stripe.Metadata | null }): boolean {
    return Boolean(ref.metadata?.[PACKAGE_CHECKOUT_METADATA.ORDER_ID]);
  }

  async confirm(ref: SessionRef, now: Date): Promise<PackageWebhookOutcome> {
    const order = await this.findOrder(ref);
    if (!order) return this.unknown(ref);
    if (order.status === CreditPackageOrderStatus.PAID) {
      return 'ALREADY_PROCESSED';
    }

    // Payment facts come from the Stripe API, not from the event payload.
    const session = await this.stripe.retrievePackageCheckout(ref.id);
    const verification = verifyPackageCheckout(session, order);
    switch (verification.outcome) {
      case 'NOT_PAID':
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

    return this.prisma.$transaction(async (tx) => {
      const current = await this.lockOrder(tx, order.id);
      if (current.status === CreditPackageOrderStatus.PAID) {
        return 'ALREADY_PROCESSED';
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
      await this.fulfill(
        tx,
        { ...current, authId: current.authId },
        {
          paymentIntentId: verification.paymentIntentId,
          providerSessionId: verification.providerSessionId,
        },
        paymentMethod,
        now,
      );
      return 'CREDITS_GRANTED';
    });
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
      return true;
    });
  }

  /**
   * Makes the order PAID with its credits, discount and referral effects,
   * in the caller's transaction (which holds the order's row lock). Used
   * for verified Stripe payments and for fully discounted orders (nothing
   * to charge; not a paying purchase for referral rewards).
   */
  async fulfill(
    tx: Prisma.TransactionClient,
    order: CreditPackageOrder & { authId: string },
    payment: { paymentIntentId: string | null; providerSessionId?: string },
    paymentMethod: PaymentMethodCheck,
    now: Date,
  ): Promise<CreditPackageOrder> {
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
    await this.wallet.grant(
      {
        authId: order.authId,
        source: CreditSource.PURCHASE,
        sourceReference: packageOrderCreditReference(order.id),
        amount: String(order.credits),
        description: `Credit package ${order.packageCode}: ${order.credits} credits`,
      },
      { tx, at: now },
    );
    await this.discounts.redeemForPackageOrder(tx, order.id, now);
    // A paid package purchase is a paid purchase for referrals: the
    // referred user's first paying one rewards the referrer, once.
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
    return paid;
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
