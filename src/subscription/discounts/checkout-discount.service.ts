import { Injectable } from '@nestjs/common';
import {
  type BillingInterval,
  type CheckoutSession,
  CheckoutSessionStatus,
  DiscountAudience,
  DiscountOfferKind,
  DiscountRedemptionStatus,
  DiscountSource,
  Prisma,
} from '@prisma/client';
import type Stripe from 'stripe';
import AppError from '../../common/errors/app.error';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { DISCOUNT_MESSAGES } from '../../discounts/discount-offer.constants';
import {
  applyCheckoutDiscount,
  lateRedemptionFits,
  normalizeDiscountCode,
  proProduct,
  redemptionRejection,
} from '../../discounts/discount-offer.policy';
import { rejectionError } from '../../discounts/discount-rejections';
import {
  type DiscountCandidate,
  selectBestDiscount,
} from '../../discounts/discount-selection.policy';
import { DISCOUNT_SETTINGS_ID } from '../../discounts/discount-settings.constants';
import { hasPaidPurchase } from '../../discounts/paid-purchase';
import { CHECKOUT_METADATA, StripeGateway } from '../stripe/stripe.gateway';

const LOG_CONTEXT = 'CheckoutDiscountService';

/** RESERVED and REDEEMED redemptions count towards limits and budgets. */
const ACTIVE_STATUSES = [
  DiscountRedemptionStatus.RESERVED,
  DiscountRedemptionStatus.REDEEMED,
];

/** The discount chosen for a new checkout. */
export interface SelectedCheckoutDiscount {
  source: DiscountSource;
  /** CODE and CAMPAIGN only. */
  offerId: string | null;
  code: string | null;
  name: string;
  percent: number;
  /** Off the first payment, in cents; the first charge is never below $0.50. */
  discountCents: number;
}

export type RedeemOutcome =
  | 'NONE'
  | 'REDEEMED'
  | 'ALREADY_REDEEMED'
  /** A late payment of a released reservation that no longer fits. */
  | 'NOT_COUNTED';

/**
 * Discounts of Pro checkouts.
 *
 * - select: when a checkout is created, the best available discount (the
 *   highest percentage of the first-purchase discount, the referral
 *   discount, an entered code and running campaigns; selectBestDiscount).
 *   The first-purchase and referral discounts are available until the user's
 *   first successful paid purchase; trials and failed, canceled or abandoned
 *   checkouts do not use them up. An entered code that cannot be used is
 *   refused with its reason; campaigns that do not apply are skipped.
 * - reserve: the chosen discount is RESERVED for the checkout in the same
 *   transaction that creates it, under the user's lock and the offers' row
 *   locks, so concurrent checkouts can never exceed an offer's limits or
 *   budget, or use a one-time discount twice (the database trigger and the
 *   partial unique index enforce the same).
 * - redeem: when the checkout's payment is recorded (whichever webhook
 *   arrives first, once), RESERVED becomes REDEEMED. A late payment of a
 *   RELEASED reservation is counted again only if the limits and budget
 *   still allow it; otherwise it is left uncounted and reported, never
 *   overspending or redeeming twice.
 * - release: only when the checkout can no longer be paid (Stripe confirms
 *   its session expired without a payable subscription, or the subscription
 *   created by a failed attempt ended unpaid): RESERVED becomes RELEASED and
 *   the limits and budget are given back.
 */
@Injectable()
export class CheckoutDiscountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeGateway,
    private readonly logger: CustomLoggerService,
  ) {}

  /**
   * The best discount for a new checkout, inside the checkout's transaction
   * (the user's UserSubscription row is locked). Locks the offers it
   * considers, in id order. Throws for an entered code that cannot be used.
   */
  async select(
    tx: Prisma.TransactionClient,
    input: {
      authId: string;
      billingInterval: BillingInterval;
      listPriceCents: number;
      code: string | null;
      now: Date;
      /**
       * A pending checkout about to be reused or replaced: its own
       * reservation does not count against the user (a repeated request
       * for the same code must not be refused because of it).
       */
      ignoreCheckoutId?: string | null;
    },
  ): Promise<SelectedCheckoutDiscount | null> {
    const { authId, now } = input;
    const otherCheckouts: Prisma.DiscountRedemptionWhereInput =
      input.ignoreCheckoutId
        ? {
            OR: [
              { checkoutSessionId: null },
              { checkoutSessionId: { not: input.ignoreCheckoutId } },
            ],
          }
        : {};
    const product = proProduct(input.billingInterval);
    const paid = await hasPaidPurchase(tx, authId);
    const candidates: DiscountCandidate[] = [];

    if (!paid) {
      // Stored by migration and at startup (DiscountSettingsService); a
      // missing row means both discounts are off.
      const stored = await tx.discountSettings.findUnique({
        where: { id: DISCOUNT_SETTINGS_ID },
      });
      const settings = {
        firstPurchaseDiscountPercent: stored?.firstPurchaseDiscountPercent ?? 0,
        referralDiscountPercent: stored?.referralDiscountPercent ?? 0,
      };
      const used = new Set(
        (
          await tx.discountRedemption.findMany({
            where: {
              authId,
              source: {
                in: [DiscountSource.FIRST_PURCHASE, DiscountSource.REFERRAL],
              },
              status: { in: ACTIVE_STATUSES },
              ...otherCheckouts,
            },
            select: { source: true },
          })
        ).map((redemption) => redemption.source),
      );
      if (
        settings.firstPurchaseDiscountPercent > 0 &&
        !used.has(DiscountSource.FIRST_PURCHASE)
      ) {
        candidates.push({
          source: DiscountSource.FIRST_PURCHASE,
          percent: settings.firstPurchaseDiscountPercent,
          offerId: null,
          code: null,
          name: 'First purchase discount',
          endsAt: null,
        });
      }
      if (
        settings.referralDiscountPercent > 0 &&
        !used.has(DiscountSource.REFERRAL) &&
        (await tx.referral.findUnique({ where: { authId } }))
      ) {
        candidates.push({
          source: DiscountSource.REFERRAL,
          percent: settings.referralDiscountPercent,
          offerId: null,
          code: null,
          name: 'Referral discount',
          endsAt: null,
        });
      }
    }

    const code = input.code ? normalizeDiscountCode(input.code) : null;
    const codeOffer = code
      ? await tx.discountOffer.findFirst({
          where: { kind: DiscountOfferKind.CODE, code },
          select: { id: true },
        })
      : null;
    if (code && !codeOffer) {
      throw AppError.notFound(DISCOUNT_MESSAGES.CODE_NOT_FOUND);
    }
    const campaigns = await tx.discountOffer.findMany({
      where: {
        kind: DiscountOfferKind.CAMPAIGN,
        active: true,
        discountPercent: { gt: 0 },
        startsAt: { lte: now },
        endsAt: { gt: now },
        OR: [
          { audience: DiscountAudience.ALL_USERS },
          { targets: { some: { authId } } },
        ],
      },
      select: { id: true },
    });
    const ids = [
      ...new Set([
        ...(codeOffer ? [codeOffer.id] : []),
        ...campaigns.map((campaign) => campaign.id),
      ]),
    ].sort();
    if (ids.length > 0) {
      // One ordered lock acquisition: concurrent checkouts cannot deadlock.
      await tx.$queryRaw`
        SELECT "id" FROM "DiscountOffer" WHERE "id" = ANY(${ids}::text[])
        ORDER BY "id" FOR UPDATE
      `;
    }
    const offers = await tx.discountOffer.findMany({
      where: { id: { in: ids } },
    });
    for (const offer of offers) {
      const isCode = offer.id === codeOffer?.id;
      const price = applyCheckoutDiscount(
        input.listPriceCents,
        offer.discountPercent,
      );
      const rejection = redemptionRejection(offer, {
        now,
        isTargeted:
          offer.audience !== DiscountAudience.SELECTED_USERS ||
          (await tx.discountOfferTarget.count({
            where: { offerId: offer.id, authId },
          })) > 0,
        userRedemptions: await tx.discountRedemption.count({
          where: {
            offerId: offer.id,
            authId,
            status: { in: ACTIVE_STATUSES },
            ...otherCheckouts,
          },
        }),
        hasPaidPurchase: paid,
        product,
        listPriceCents: input.listPriceCents,
        discountCents: price.discountUsdCents,
      });
      if (rejection) {
        if (isCode) throw rejectionError(rejection, offer.customerEligibility);
        continue;
      }
      candidates.push({
        source: isCode ? DiscountSource.CODE : DiscountSource.CAMPAIGN,
        percent: offer.discountPercent,
        offerId: offer.id,
        code: offer.code,
        name: offer.name,
        endsAt: offer.endsAt,
      });
    }

    const best = selectBestDiscount(candidates);
    if (!best) return null;
    const { discountUsdCents } = applyCheckoutDiscount(
      input.listPriceCents,
      best.percent,
    );
    if (discountUsdCents === 0) return null;
    return {
      source: best.source,
      offerId: best.offerId,
      code: best.code,
      name: best.name,
      percent: best.percent,
      discountCents: discountUsdCents,
    };
  }

  /** Reserves the selected discount for the new checkout (same transaction). */
  async reserve(
    tx: Prisma.TransactionClient,
    checkout: CheckoutSession,
    authId: string,
    selected: SelectedCheckoutDiscount,
    now: Date,
  ): Promise<void> {
    await tx.discountRedemption.create({
      data: {
        offerId: selected.offerId,
        authId,
        source: selected.source,
        status: DiscountRedemptionStatus.RESERVED,
        idempotencyKey: `checkout:${checkout.id}`,
        product: proProduct(checkout.billingInterval),
        discountPercent: selected.percent,
        originalPriceUsdCents: checkout.amountCents,
        discountUsdCents: selected.discountCents,
        finalPriceUsdCents: checkout.amountCents - selected.discountCents,
        checkoutSessionId: checkout.id,
        reservedAt: now,
      },
    });
  }

  /**
   * Gives back the checkout's reservation. The caller has established that
   * the checkout can no longer be paid and holds the user's lock.
   */
  async release(
    tx: Prisma.TransactionClient,
    checkoutId: string,
    reason: string,
    now: Date,
  ): Promise<boolean> {
    const { count } = await tx.discountRedemption.updateMany({
      where: {
        checkoutSessionId: checkoutId,
        status: DiscountRedemptionStatus.RESERVED,
      },
      data: {
        status: DiscountRedemptionStatus.RELEASED,
        releasedAt: now,
        releaseReason: reason,
      },
    });
    return count > 0;
  }

  /**
   * The checkout's payment was recorded (in the caller's transaction, under
   * the user's lock): its discount is redeemed once.
   */
  async redeem(
    tx: Prisma.TransactionClient,
    checkoutId: string,
    paymentId: string,
    now: Date,
  ): Promise<RedeemOutcome> {
    const redemption = await tx.discountRedemption.findUnique({
      where: { checkoutSessionId: checkoutId },
    });
    if (!redemption) return 'NONE';
    if (redemption.status === DiscountRedemptionStatus.REDEEMED) {
      return 'ALREADY_REDEEMED';
    }
    const redeemed = {
      status: DiscountRedemptionStatus.REDEEMED,
      redeemedAt: now,
      paymentId,
    };
    if (redemption.status === DiscountRedemptionStatus.RESERVED) {
      await tx.discountRedemption.update({
        where: { id: redemption.id },
        data: redeemed,
      });
      return 'REDEEMED';
    }

    // RELEASED: the payment came after the reservation was given back.
    let fits: boolean;
    if (redemption.offerId) {
      await tx.$queryRaw`
        SELECT "id" FROM "DiscountOffer" WHERE "id" = ${redemption.offerId} FOR UPDATE
      `;
      const offer = await tx.discountOffer.findUniqueOrThrow({
        where: { id: redemption.offerId },
      });
      const userRedemptions = await tx.discountRedemption.count({
        where: {
          offerId: offer.id,
          authId: redemption.authId,
          status: { in: ACTIVE_STATUSES },
        },
      });
      fits = lateRedemptionFits(
        offer,
        userRedemptions,
        redemption.discountUsdCents,
      );
    } else {
      fits =
        (await tx.discountRedemption.count({
          where: {
            authId: redemption.authId,
            source: redemption.source,
            status: { in: ACTIVE_STATUSES },
          },
        })) === 0;
    }
    if (fits) {
      await tx.discountRedemption.update({
        where: { id: redemption.id },
        data: redeemed,
      });
      this.logger.logWithMetadata(
        'warn',
        'Late payment of a released checkout discount; redeemed within its limits',
        { context: LOG_CONTEXT, checkoutId, redemptionId: redemption.id },
      );
      return 'REDEEMED';
    }
    await tx.discountRedemption.update({
      where: { id: redemption.id },
      data: { paymentId },
    });
    this.logger.logWithMetadata(
      'error',
      'Late payment of a released checkout discount exceeds its limits or budget; not counted, review required',
      {
        context: LOG_CONTEXT,
        checkoutId,
        redemptionId: redemption.id,
        source: redemption.source,
      },
    );
    return 'NOT_COUNTED';
  }

  /** Whether the checkout holds a RESERVED discount. */
  async hasReservation(checkoutId: string): Promise<boolean> {
    return (
      (await this.prisma.discountRedemption.count({
        where: {
          checkoutSessionId: checkoutId,
          status: DiscountRedemptionStatus.RESERVED,
        },
      })) > 0
    );
  }

  /**
   * Whether nothing can be paid any more for the checkout, as Stripe reports
   * it now: no Stripe session, or an expired session whose subscription (if
   * a failed attempt created one) ended with its first invoice void. An
   * open, complete or still payable checkout is not. Calls Stripe; never
   * inside a transaction.
   */
  async isUnpayable(checkout: CheckoutSession): Promise<boolean> {
    if (!checkout.providerSessionId) return true;
    const session = await this.stripe.retrieveCheckoutForVerification(
      checkout.providerSessionId,
    );
    if (session.status !== 'expired') return false;
    return this.subscriptionUnpayable(session.subscription);
  }

  /**
   * A closed checkout (EXPIRED or FAILED) gives its reservation back once it
   * can no longer be paid; otherwise the reservation is held until it can't
   * (e.g. the first invoice of a failed attempt may still be paid).
   */
  async releaseIfUnpayable(
    checkoutId: string,
    reason: string,
    now: Date,
  ): Promise<'NONE' | 'RELEASED' | 'HELD'> {
    if (!(await this.hasReservation(checkoutId))) return 'NONE';
    const checkout = await this.prisma.checkoutSession.findUniqueOrThrow({
      where: { id: checkoutId },
    });
    if (!(await this.isUnpayable(checkout))) return 'HELD';
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "UserSubscription" WHERE "id" = ${checkout.subscriptionId} FOR UPDATE
      `;
      const current = await tx.checkoutSession.findUniqueOrThrow({
        where: { id: checkoutId },
      });
      if (
        current.status !== CheckoutSessionStatus.EXPIRED &&
        current.status !== CheckoutSessionStatus.FAILED
      ) {
        return 'HELD';
      }
      return (await this.release(tx, checkoutId, reason, now))
        ? 'RELEASED'
        : 'NONE';
    });
  }

  /**
   * A Stripe subscription without a recorded first payment ended (e.g. the
   * first invoice of a failed attempt expired unpaid): the reservation of
   * the checkout that created it is given back, if that checkout is closed
   * and nothing can be paid any more.
   */
  async releaseForEndedSubscription(
    ref: Pick<Stripe.Subscription, 'id' | 'metadata'>,
    now: Date,
  ): Promise<'NONE' | 'RELEASED' | 'HELD'> {
    const checkoutId = ref.metadata?.[CHECKOUT_METADATA.CHECKOUT_ID];
    if (!checkoutId) return 'NONE';
    const checkout = await this.prisma.checkoutSession.findUnique({
      where: { id: checkoutId },
    });
    if (!checkout) return 'NONE';
    return this.releaseIfUnpayable(checkout.id, 'SUBSCRIPTION_ENDED', now);
  }

  /**
   * An expired session's subscription (created by a failed payment attempt)
   * can no longer be paid once Stripe ended it and voided its first invoice.
   */
  private async subscriptionUnpayable(
    value: string | Stripe.Subscription | null,
  ): Promise<boolean> {
    if (!value) return true;
    const subscription =
      typeof value === 'string'
        ? await this.stripe.retrieveSubscription(value)
        : value;
    if (
      subscription.status !== 'incomplete_expired' &&
      subscription.status !== 'canceled'
    ) {
      return false;
    }
    const latest = subscription.latest_invoice;
    if (!latest) return true;
    const invoice =
      typeof latest === 'string'
        ? await this.stripe.retrieveInvoice(latest)
        : latest;
    return invoice.status === 'void';
  }
}
