import { Injectable } from '@nestjs/common';
import {
  DiscountAudience,
  DiscountOfferKind,
  Prisma,
  type CreditPackageCode,
  type DiscountOffer,
  type DiscountRedemption,
} from '@prisma/client';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import { formatUsdCents } from '../credit-packages/credit-package-settings.constants';
import { CreditPackageSettingsService } from '../credit-packages/credit-package-settings.service';
import {
  DISCOUNT_MESSAGES,
  DISCOUNT_OFFER_LIMITS,
} from './discount-offer.constants';
import {
  applyDiscount,
  normalizeDiscountCode,
  redemptionRejection,
  type RedemptionRejection,
} from './discount-offer.policy';
import type {
  AvailableCampaignView,
  DiscountRedemptionView,
} from './interfaces/discount-offer.interface';

const REJECTIONS: Record<RedemptionRejection, () => AppError> = {
  INACTIVE: () => AppError.conflict(DISCOUNT_MESSAGES.INACTIVE),
  NOT_STARTED: () => AppError.conflict(DISCOUNT_MESSAGES.NOT_STARTED),
  EXPIRED: () => AppError.conflict(DISCOUNT_MESSAGES.EXPIRED),
  NOT_ELIGIBLE: () => AppError.forbidden(DISCOUNT_MESSAGES.NOT_ELIGIBLE),
  USER_LIMIT_REACHED: () =>
    AppError.conflict(DISCOUNT_MESSAGES.USER_LIMIT_REACHED),
  DEPLETED: () => AppError.conflict(DISCOUNT_MESSAGES.DEPLETED),
};

/**
 * Redemption of discount codes and campaigns by signed-in users, for one of
 * the configured credit packages (CreditPackageSettingsService): the
 * redemption records the package and the price terms at that moment.
 *
 * A redemption runs in one transaction that locks the offer row first, so
 * the redemptions of one offer are checked and counted one at a time: no
 * number of concurrent requests can exceed the per-user or total limit. The
 * database trigger on DiscountRedemption repeats every check under the same
 * lock and maintains the offer's redemptionCount. Each request carries an
 * Idempotency-Key (unique per user): repeating it returns the original
 * redemption (`replayed: true`) and counts nothing, even when the repeats
 * arrive concurrently.
 */
@Injectable()
export class DiscountRedemptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly packages: CreditPackageSettingsService,
  ) {}

  redeemCode(
    authId: string,
    code: string,
    packageCode: CreditPackageCode,
    idempotencyKey: string | undefined,
  ): Promise<DiscountRedemptionView> {
    const normalized = normalizeDiscountCode(code);
    return this.redeem(
      authId,
      packageCode,
      idempotencyKey,
      DISCOUNT_MESSAGES.CODE_NOT_FOUND,
      (tx) =>
        tx.discountOffer.findFirst({
          where: { kind: DiscountOfferKind.CODE, code: normalized },
          select: { id: true },
        }),
    );
  }

  redeemCampaign(
    authId: string,
    campaignId: string,
    packageCode: CreditPackageCode,
    idempotencyKey: string | undefined,
  ): Promise<DiscountRedemptionView> {
    return this.redeem(
      authId,
      packageCode,
      idempotencyKey,
      DISCOUNT_MESSAGES.CAMPAIGN_NOT_FOUND,
      (tx) =>
        tx.discountOffer.findFirst({
          where: { kind: DiscountOfferKind.CAMPAIGN, id: campaignId },
          select: { id: true },
        }),
    );
  }

  /**
   * The campaigns the user can redeem now: active with a discount above 0%,
   * running, open to the user, with redemptions left for the user and in
   * total. Ending soonest first.
   */
  async listAvailableCampaigns(
    authId: string,
  ): Promise<AvailableCampaignView[]> {
    const now = new Date();
    const campaigns = await this.prisma.discountOffer.findMany({
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
      orderBy: [{ endsAt: 'asc' }, { id: 'asc' }],
      include: {
        _count: { select: { redemptions: { where: { authId } } } },
      },
    });
    return campaigns
      .filter(
        (campaign) =>
          redemptionRejection(campaign, {
            now,
            isTargeted: true,
            userRedemptions: campaign._count.redemptions,
          }) === null,
      )
      .map((campaign) => ({
        id: campaign.id,
        name: campaign.name,
        discountPercent: campaign.discountPercent,
        startsAt: campaign.startsAt.toISOString(),
        endsAt: campaign.endsAt.toISOString(),
        remainingRedemptionsForYou:
          campaign.maxRedemptionsPerUser - campaign._count.redemptions,
      }));
  }

  private async redeem(
    authId: string,
    packageCode: CreditPackageCode,
    rawKey: string | undefined,
    notFoundMessage: string,
    locate: (tx: Prisma.TransactionClient) => Promise<{ id: string } | null>,
  ): Promise<DiscountRedemptionView> {
    const idempotencyKey = this.requireKey(rawKey);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const found = await locate(tx);
        if (!found) throw AppError.notFound(notFoundMessage);
        // Serializes every redemption of this offer (and admin changes).
        await tx.$queryRaw`
          SELECT "id" FROM "DiscountOffer" WHERE "id" = ${found.id} FOR UPDATE
        `;
        const offer = await tx.discountOffer.findUniqueOrThrow({
          where: { id: found.id },
        });

        const previous = await tx.discountRedemption.findUnique({
          where: { authId_idempotencyKey: { authId, idempotencyKey } },
        });
        if (previous) {
          if (
            previous.offerId === offer.id &&
            previous.packageCode === packageCode
          ) {
            return this.toView(previous, offer, true);
          }
          throw AppError.conflict(DISCOUNT_MESSAGES.IDEMPOTENCY_KEY_REUSED);
        }

        const now = new Date();
        const isTargeted =
          offer.audience === DiscountAudience.SELECTED_USERS &&
          (await tx.discountOfferTarget.count({
            where: { offerId: offer.id, authId },
          })) > 0;
        const userRedemptions = await tx.discountRedemption.count({
          where: { offerId: offer.id, authId },
        });
        const rejection = redemptionRejection(offer, {
          now,
          isTargeted,
          userRedemptions,
        });
        if (rejection) throw REJECTIONS[rejection]();

        const pkg = await this.packages.getPackage(packageCode, tx);
        if (!pkg.available) {
          throw AppError.conflict(DISCOUNT_MESSAGES.PACKAGE_UNAVAILABLE);
        }
        const price = applyDiscount(pkg.priceUsdCents, offer.discountPercent);
        const redemption = await tx.discountRedemption.create({
          data: {
            offerId: offer.id,
            authId,
            idempotencyKey,
            packageCode,
            credits: pkg.credits,
            discountPercent: offer.discountPercent,
            ...price,
            redeemedAt: now,
          },
        });
        return this.toView(redemption, offer, false);
      });
    } catch (error) {
      // The same key was used concurrently for another offer, whose
      // redemption committed first.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw AppError.conflict(DISCOUNT_MESSAGES.IDEMPOTENCY_KEY_REUSED);
      }
      throw error;
    }
  }

  private requireKey(raw: string | undefined): string {
    const key = raw?.trim();
    if (!key || key.length > DISCOUNT_OFFER_LIMITS.IDEMPOTENCY_KEY_MAX_LENGTH) {
      throw AppError.badRequest(DISCOUNT_MESSAGES.IDEMPOTENCY_KEY_REQUIRED);
    }
    return key;
  }

  private toView(
    redemption: DiscountRedemption,
    offer: DiscountOffer,
    replayed: boolean,
  ): DiscountRedemptionView {
    return {
      id: redemption.id,
      offerId: offer.id,
      kind: offer.kind,
      ...(offer.code !== null ? { code: offer.code } : {}),
      name: offer.name,
      packageCode: redemption.packageCode,
      credits: redemption.credits,
      currency: 'USD',
      discountPercent: redemption.discountPercent,
      originalPriceUsdCents: redemption.originalPriceUsdCents,
      discountUsdCents: redemption.discountUsdCents,
      finalPriceUsdCents: redemption.finalPriceUsdCents,
      finalPriceUsd: formatUsdCents(redemption.finalPriceUsdCents),
      redeemedAt: redemption.redeemedAt.toISOString(),
      replayed,
    };
  }
}
