import { HttpException, Injectable } from '@nestjs/common';
import {
  CreditPackageCode,
  CreditPackageOrderStatus,
  Prisma,
  type CreditPackageOrder,
} from '@prisma/client';
import Stripe from 'stripe';
import AppError from '../../common/errors/app.error';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';
import {
  normalizeDiscountCode,
  packageProduct,
} from '../../discounts/discount-offer.policy';
import { CheckoutDiscountService } from '../../subscription/discounts/checkout-discount.service';
import { StripeCheckoutService } from '../../subscription/stripe/stripe-checkout.service';
import {
  STRIPE_PROVIDER,
  StripeGateway,
} from '../../subscription/stripe/stripe.gateway';
import {
  isPurchaseAccountEligible,
  TRIAL_ACCOUNT_SELECT,
} from '../../subscription/subscription-access.policy';
import {
  CREDIT_PACKAGE_DEFAULTS,
  formatUsdCents,
} from '../credit-package-settings.constants';
import type {
  CreditPackageOrderView,
  PurchasableCreditPackageView,
} from './credit-package-order.interface';
import { CREDIT_PACKAGE_ORDER_MESSAGES as MESSAGES } from './credit-package-order.policy';
import {
  CreditPackagePaymentService,
  NO_PAYMENT_METHOD,
} from './credit-package-payment.service';

const LOG_CONTEXT = 'CreditPackageCheckoutService';
const ORDER_LOCK = 'credit-package-orders:';
const IDEMPOTENCY_KEY_MAX = 200;
const DEFAULT_PAGE = 20;

/**
 * Buying credit packages: one order per purchase, paid through a Stripe
 * Checkout Session in payment mode.
 *
 * Creating an order (POST /v1/credit-packages/:code/checkout with an
 * Idempotency-Key) runs one transaction under a lock of the user's orders
 * that locks the package row, takes the package's current credits and list
 * price (the database checks they are the current terms of an available
 * package; they never change afterwards), selects the best discount (the
 * first-purchase and referral discounts until the first paid purchase, an
 * entered code, running campaigns; as for Pro) and reserves it with the
 * order. The charge is the list price less the discount ($0, or at least
 * Stripe's $0.50). Stripe is called outside the transaction with an
 * idempotency key derived from the order, so retries and concurrent
 * requests reach the same Stripe session; a repeated request with the same
 * Idempotency-Key returns the same order (`replayed: true`).
 *
 * Nothing here grants credits, except for a fully discounted order (nothing
 * to charge), which is fulfilled in its creating transaction. Paid orders
 * are fulfilled by the verified webhook (CreditPackagePaymentService).
 */
@Injectable()
export class CreditPackageCheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeGateway,
    private readonly checkout: StripeCheckoutService,
    private readonly discounts: CheckoutDiscountService,
    private readonly payments: CreditPackagePaymentService,
    private readonly logger: CustomLoggerService,
  ) {}

  /** The packages users can buy now (available ones). */
  async listAvailable(): Promise<PurchasableCreditPackageView[]> {
    const order = CREDIT_PACKAGE_DEFAULTS.map((pkg) => pkg.code as string);
    const packages = await this.prisma.creditPackage.findMany({
      where: { available: true },
    });
    return packages
      .sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code))
      .map((pkg) => ({
        code: pkg.code,
        credits: pkg.credits,
        priceUsdCents: pkg.priceUsdCents,
        priceUsd: formatUsdCents(pkg.priceUsdCents),
        currency: 'USD',
      }));
  }

  async createOrder(
    authId: string,
    rawCode: string,
    options: { discountCode?: string | null },
    rawKey: string | undefined,
    now: Date = new Date(),
  ): Promise<CreditPackageOrderView> {
    const idempotencyKey = this.requireKey(rawKey);
    const packageCode = this.requireCode(rawCode);
    const discountCode = options.discountCode
      ? normalizeDiscountCode(options.discountCode)
      : null;

    const previous = await this.findByKey(authId, idempotencyKey);
    if (previous) {
      return this.replay(previous, packageCode, discountCode, now);
    }

    const account = await this.prisma.authUser.findUnique({
      where: { id: authId },
      select: { ...TRIAL_ACCOUNT_SELECT, email: true },
    });
    if (!account || !isPurchaseAccountEligible(account)) {
      throw AppError.forbidden(MESSAGES.ACCOUNT_INACTIVE);
    }
    if (!this.stripe.checkoutConfigured) {
      throw AppError.serviceUnavailable('Payments are not configured');
    }
    const customerId = await this.checkout.ensureCustomer(
      authId,
      account.email,
    );

    let result: { order: CreditPackageOrder; created: boolean };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT 1 AS locked
          FROM (SELECT pg_advisory_xact_lock(
            hashtextextended(${ORDER_LOCK + authId}, 0)
          )) AS lock
        `;
        const again = await tx.creditPackageOrder.findUnique({
          where: { authId_idempotencyKey: { authId, idempotencyKey } },
        });
        if (again) return { order: again, created: false };

        // The package terms stay as read until the order is stored.
        await tx.$queryRaw`
          SELECT "code" FROM "CreditPackage"
          WHERE "code" = ${packageCode}::"CreditPackageCode" FOR SHARE
        `;
        const pkg = await tx.creditPackage.findUnique({
          where: { code: packageCode },
        });
        if (!pkg?.available) {
          throw AppError.conflict(MESSAGES.PACKAGE_UNAVAILABLE);
        }
        const selected = await this.discounts.select(tx, {
          authId,
          product: packageProduct(packageCode),
          listPriceCents: pkg.priceUsdCents,
          code: discountCode,
          now,
        });
        const discountCents = selected?.discountCents ?? 0;
        const amount = pkg.priceUsdCents - discountCents;
        const order = await tx.creditPackageOrder.create({
          data: {
            authId,
            idempotencyKey,
            packageCode,
            credits: pkg.credits,
            listPriceUsdCents: pkg.priceUsdCents,
            discountSource: selected?.source ?? null,
            discountOfferId: selected?.offerId ?? null,
            discountPercent: selected?.percent ?? 0,
            discountUsdCents: discountCents,
            amountUsdCents: amount,
            requestedDiscountCode: discountCode,
            provider: amount > 0 ? STRIPE_PROVIDER : null,
            providerCustomerId: amount > 0 ? customerId : null,
            expiresAt: new Date(
              now.getTime() + this.stripe.checkoutExpiresMinutes * 60_000,
            ),
          },
        });
        const owned = { ...order, authId };
        if (selected) {
          await this.discounts.reserveForPackageOrder(tx, owned, selected, now);
        }
        if (amount === 0) {
          // Fully discounted: nothing to charge, fulfilled at once.
          return {
            order: await this.payments.fulfill(
              tx,
              owned,
              { paymentIntentId: null },
              NO_PAYMENT_METHOD,
              now,
            ),
            created: true,
          };
        }
        return { order, created: true };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // The same key was used concurrently (its order committed first),
        // or a concurrent purchase took the same one-time discount.
        const winner = await this.findByKey(authId, idempotencyKey);
        if (winner) return this.replay(winner, packageCode, discountCode, now);
        throw AppError.conflict(MESSAGES.BUSY);
      }
      throw error;
    }
    return this.open(result.order, !result.created, now);
  }

  async listOrders(
    authId: string,
    query: { limit?: number },
  ): Promise<CreditPackageOrderView[]> {
    const orders = await this.prisma.creditPackageOrder.findMany({
      where: { authId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit ?? DEFAULT_PAGE,
      include: { discountOffer: { select: { code: true } } },
    });
    return orders.map((order) => this.toView(order, order.discountOffer));
  }

  async getOrder(
    authId: string,
    orderId: string,
  ): Promise<CreditPackageOrderView> {
    const order = await this.prisma.creditPackageOrder.findFirst({
      where: { id: orderId, authId },
      include: { discountOffer: { select: { code: true } } },
    });
    if (!order) throw AppError.notFound(MESSAGES.NOT_FOUND);
    return this.toView(order, order.discountOffer);
  }

  /**
   * Cancels an unpaid order: its Stripe session is expired first (once
   * Stripe confirms, nothing can be paid any more), then the order is
   * CANCELED and its discount reservation given back. Paid or processing
   * orders cannot be canceled (409); a closed order is returned as is.
   */
  async cancelOrder(
    authId: string,
    orderId: string,
    now: Date = new Date(),
  ): Promise<CreditPackageOrderView> {
    const order = await this.prisma.creditPackageOrder.findFirst({
      where: { id: orderId, authId },
    });
    if (!order) throw AppError.notFound(MESSAGES.NOT_FOUND);
    if (
      order.status === CreditPackageOrderStatus.PAID ||
      order.status === CreditPackageOrderStatus.PROCESSING
    ) {
      throw AppError.conflict(MESSAGES.PAYMENT_IN_PROGRESS);
    }
    if (
      order.status === CreditPackageOrderStatus.OPEN &&
      order.providerSessionId
    ) {
      try {
        await this.stripe.expireCheckoutSession(order.providerSessionId);
      } catch (error) {
        const session = await this.callStripe(order.id, () =>
          this.stripe.retrieveCheckoutSession(
            order.providerSessionId as string,
          ),
        ).catch(() => {
          throw this.providerError(order.id, error);
        });
        if (session.status !== 'expired') {
          // Completed meanwhile: the webhook settles the payment.
          throw AppError.conflict(MESSAGES.PAYMENT_IN_PROGRESS);
        }
      }
    }
    // A CREATING order has no payable session (if Stripe created one whose
    // response was lost and it is paid anyway, the verified payment still
    // fulfills the order).
    await this.payments.close(
      order.id,
      CreditPackageOrderStatus.CANCELED,
      'CANCELED_BY_USER',
      [CreditPackageOrderStatus.CREATING, CreditPackageOrderStatus.OPEN],
      now,
    );
    return this.getOrder(authId, order.id);
  }

  /** A repeated request: the same order, if the request is the same. */
  private replay(
    order: CreditPackageOrder,
    packageCode: CreditPackageCode,
    discountCode: string | null,
    now: Date,
  ): Promise<CreditPackageOrderView> {
    if (
      order.packageCode !== packageCode ||
      order.requestedDiscountCode !== discountCode
    ) {
      throw AppError.conflict(MESSAGES.IDEMPOTENCY_KEY_REUSED);
    }
    return this.open(order, true, now);
  }

  /**
   * Opens the Stripe checkout of a CREATING order (idempotent at Stripe),
   * then returns the order. A definitive refusal by Stripe fails the order
   * (its discount is given back); a transient failure leaves it CREATING
   * for a retry with the same Idempotency-Key.
   */
  private async open(
    order: CreditPackageOrder,
    replayed: boolean,
    now: Date,
  ): Promise<CreditPackageOrderView> {
    if (
      order.status === CreditPackageOrderStatus.CREATING &&
      order.provider &&
      order.providerCustomerId &&
      order.authId
    ) {
      try {
        const session = await this.stripe.createPackageCheckoutSession({
          orderId: order.id,
          authId: order.authId,
          customerId: order.providerCustomerId,
          packageCode: order.packageCode,
          credits: order.credits,
          listPriceCents: order.listPriceUsdCents,
          discount:
            order.discountUsdCents > 0
              ? {
                  amountOffCents: order.discountUsdCents,
                  name: `${order.discountPercent}% off`,
                }
              : null,
          expiresAt: order.expiresAt ?? new Date(now.getTime() + 3_600_000),
        });
        await this.prisma.creditPackageOrder.updateMany({
          where: { id: order.id, status: CreditPackageOrderStatus.CREATING },
          data: {
            status: CreditPackageOrderStatus.OPEN,
            providerSessionId: session.id,
            url: session.url,
          },
        });
      } catch (error) {
        if (StripeGateway.isDefinitiveRejection(error)) {
          await this.payments.close(
            order.id,
            CreditPackageOrderStatus.FAILED,
            'PROVIDER_REJECTED',
            [CreditPackageOrderStatus.CREATING],
            now,
          );
          this.logStripeError(order.id, error);
          throw AppError.serviceUnavailable(MESSAGES.PROVIDER_REJECTED);
        }
        throw this.providerError(order.id, error);
      }
    }
    const current = await this.prisma.creditPackageOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { discountOffer: { select: { code: true } } },
    });
    return { ...this.toView(current, current.discountOffer), replayed };
  }

  /** The package code of the route (case-insensitive); 404 if unknown. */
  private requireCode(raw: string): CreditPackageCode {
    const code = raw.trim().toUpperCase();
    if (!(Object.values(CreditPackageCode) as string[]).includes(code)) {
      throw AppError.notFound('Credit package not found');
    }
    return code as CreditPackageCode;
  }

  private findByKey(authId: string, idempotencyKey: string) {
    return this.prisma.creditPackageOrder.findUnique({
      where: { authId_idempotencyKey: { authId, idempotencyKey } },
    });
  }

  private requireKey(raw: string | undefined): string {
    const key = raw?.trim();
    if (!key || key.length > IDEMPOTENCY_KEY_MAX) {
      throw AppError.badRequest(MESSAGES.IDEMPOTENCY_KEY_REQUIRED);
    }
    return key;
  }

  private async callStripe<T>(
    orderId: string,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw this.providerError(orderId, error);
    }
  }

  private providerError(orderId: string, error: unknown) {
    if (error instanceof HttpException) return error;
    this.logStripeError(orderId, error);
    return AppError.serviceUnavailable(
      'The payment provider is temporarily unavailable',
    );
  }

  /** Allowlisted Stripe error fields only (messages can contain PII). */
  private logStripeError(orderId: string, error: unknown) {
    this.logger.logWithMetadata('warn', 'Stripe request failed', {
      context: LOG_CONTEXT,
      orderId,
      errorType:
        error instanceof Stripe.errors.StripeError
          ? error.type
          : error instanceof Error
            ? error.name
            : typeof error,
      code: error instanceof Stripe.errors.StripeError ? error.code : undefined,
    });
  }

  private toView(
    order: CreditPackageOrder,
    offer: { code: string | null } | null,
  ): CreditPackageOrderView {
    return {
      id: order.id,
      status: order.status,
      packageCode: order.packageCode,
      credits: order.credits,
      listPriceUsdCents: order.listPriceUsdCents,
      discount: order.discountSource
        ? {
            source: order.discountSource,
            percent: order.discountPercent,
            amountOffCents: order.discountUsdCents,
            code: offer?.code ?? null,
          }
        : null,
      amountDueUsdCents: order.amountUsdCents,
      amountDueUsd: formatUsdCents(order.amountUsdCents),
      currency: 'USD',
      checkoutUrl:
        order.status === CreditPackageOrderStatus.OPEN ? order.url : null,
      expiresAt: order.expiresAt?.toISOString() ?? null,
      paidAt: order.paidAt?.toISOString() ?? null,
      closedAt: order.closedAt?.toISOString() ?? null,
      closedReason: order.closedReason,
      createdAt: order.createdAt.toISOString(),
    };
  }
}
