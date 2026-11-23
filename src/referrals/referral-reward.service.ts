import { Injectable } from '@nestjs/common';
import {
  CreditSource,
  PaymentStatus,
  type Prisma,
  ReferralStatus,
} from '@prisma/client';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { CreditWalletService } from '../credits/credit-wallet.service';
import { DISCOUNT_SETTINGS_ID } from '../discounts/discount-settings.constants';
import { notificationContent } from '../notifications/notification.policy';
import { NotificationService } from '../notifications/notification.service';
import { ReferralMilestoneService } from './referral-milestone.service';
import {
  type ReferralHoldReason,
  referralRewardReference,
} from './referral.policy';

const LOG_CONTEXT = 'ReferralRewardService';
/** Advisory lock namespace of payment method checks. */
const PAYMENT_METHOD_LOCK = 'payment-method:';

/** What is known about the payment method of a verified payment. */
export interface PaymentMethodCheck {
  /** Keyed hash of the payment method fingerprint (null: none). */
  hash: string | null;
  /** Stripe could not be asked: sharing cannot be ruled out. */
  unavailable: boolean;
}

/**
 * A verified payment: a Pro payment (PaymentTransaction) or a credit package
 * order's payment (`kind: 'CREDIT_PACKAGE'`, the order's id).
 */
export interface VerifiedPurchase {
  id: string;
  amountCents: number;
  status: PaymentStatus;
  kind?: 'SUBSCRIPTION' | 'CREDIT_PACKAGE';
}

export type ReferralRewardOutcome =
  /** Not a paying purchase, or the payer was not referred. */
  | 'NONE'
  | 'REWARDED'
  /** Qualified, but no reward was due (switched off, referrer deleted). */
  | 'QUALIFIED'
  /** Suspicious: the reward waits for an administrator. */
  | 'HELD'
  /** The referral was already rewarded, qualified or held. */
  | 'ALREADY_QUALIFIED';

/**
 * Referral rewards, called in the transaction that records each verified
 * Stripe payment (the webhook holds the payer's UserSubscription lock).
 *
 * 1. The payment method is recorded for the payer as a keyed hash
 *    (PaymentFingerprint), never as payment data, under a transaction lock
 *    on that hash, so concurrent payments with the same payment method are
 *    checked one after the other.
 * 2. On the referred user's first verified paying purchase (a SUCCEEDED
 *    Pro payment or a paid credit package order, above $0) the referral
 *    qualifies, once (PENDING -> ... in a
 *    conditional update; database triggers refuse any second change):
 *    - HELD when the referred user paid with a payment method the referrer
 *      or another user they referred also paid with: no credits, no
 *      notification, not counted for milestones, until an administrator
 *      approves it (ReferralReviewService);
 *    - otherwise REWARDED with `referrerRewardCredits` non-expiring REFERRAL
 *      credits (unique reference) and a notification, or QUALIFIED when no
 *      reward is due; then the referrer's milestones are evaluated.
 * Signup, verification, trials and unsuccessful or free purchases never
 * reach step 2; repeated or concurrent webhook deliveries record the
 * payment once, so nothing is granted or notified twice.
 */
@Injectable()
export class ReferralRewardService {
  constructor(
    private readonly wallet: CreditWalletService,
    private readonly notifications: NotificationService,
    private readonly milestones: ReferralMilestoneService,
    private readonly logger: CustomLoggerService,
  ) {}

  async onVerifiedPayment(
    tx: Prisma.TransactionClient,
    authId: string,
    payment: VerifiedPurchase,
    paymentMethod: PaymentMethodCheck,
    now: Date,
  ): Promise<ReferralRewardOutcome> {
    const fingerprintHash = paymentMethod.hash;
    if (fingerprintHash) {
      await tx.$queryRaw`
        SELECT 1 AS locked
        FROM (SELECT pg_advisory_xact_lock(
          hashtextextended(${PAYMENT_METHOD_LOCK + fingerprintHash}, 0)
        )) AS lock
      `;
      await tx.paymentFingerprint.createMany({
        data: [{ authId, fingerprintHash }],
        skipDuplicates: true,
      });
    }
    if (
      payment.status !== PaymentStatus.SUCCEEDED ||
      payment.amountCents <= 0
    ) {
      return 'NONE';
    }
    const referral = await tx.referral.findUnique({ where: { authId } });
    if (!referral) return 'NONE';
    if (referral.status !== ReferralStatus.PENDING) return 'ALREADY_QUALIFIED';

    const settings = await tx.discountSettings.findUnique({
      where: { id: DISCOUNT_SETTINGS_ID },
    });
    const credits = settings?.referrerRewardCredits ?? 0;
    const referrerAuthId = referral.referrerAuthId;
    const qualified =
      payment.kind === 'CREDIT_PACKAGE'
        ? { qualifyingPackageOrderId: payment.id, qualifiedAt: now }
        : { qualifyingPaymentId: payment.id, qualifiedAt: now };

    const holdReason: ReferralHoldReason | null = !referrerAuthId
      ? null
      : paymentMethod.unavailable
        ? 'PAYMENT_METHOD_UNAVAILABLE'
        : await this.sharedPaymentMethod(tx, authId, referrerAuthId);
    if (holdReason) {
      const { count } = await tx.referral.updateMany({
        where: { id: referral.id, status: ReferralStatus.PENDING },
        data: {
          ...qualified,
          status: ReferralStatus.HELD,
          holdReason,
          heldAt: now,
          rewardCredits: credits > 0 ? credits : null,
        },
      });
      if (count === 0) return 'ALREADY_QUALIFIED';
      this.logger.logWithMetadata('warn', 'Referral reward held for review', {
        context: LOG_CONTEXT,
        referralId: referral.id,
        holdReason,
      });
      return 'HELD';
    }

    const rewarded = referrerAuthId !== null && credits > 0;
    const { count } = await tx.referral.updateMany({
      where: { id: referral.id, status: ReferralStatus.PENDING },
      data: rewarded
        ? {
            ...qualified,
            status: ReferralStatus.REWARDED,
            rewardCredits: credits,
            rewardedAt: now,
          }
        : { ...qualified, status: ReferralStatus.QUALIFIED },
    });
    if (count === 0) return 'ALREADY_QUALIFIED';
    if (rewarded) {
      await this.grantReward(tx, referral.id, referrerAuthId, credits, now);
    }
    if (referrerAuthId) {
      await this.milestones.evaluate(tx, referrerAuthId, now);
    }
    return rewarded ? 'REWARDED' : 'QUALIFIED';
  }

  /**
   * The referral reward credits and their notification (also used when an
   * administrator approves a held referral).
   */
  async grantReward(
    tx: Prisma.TransactionClient,
    referralId: string,
    referrerAuthId: string,
    credits: number,
    now: Date,
  ): Promise<void> {
    await this.wallet.grant(
      {
        authId: referrerAuthId,
        source: CreditSource.REFERRAL,
        sourceReference: referralRewardReference(referralId),
        amount: String(credits),
        description: 'Referral reward',
      },
      { tx, at: now },
    );
    await this.notifications.notify(
      tx,
      referrerAuthId,
      referralRewardReference(referralId),
      notificationContent.referralRewardEarned(referralId, credits),
    );
  }

  /**
   * Whether the referred user paid with a payment method that the referrer,
   * or another user the same referrer invited, also paid with (compared by
   * keyed hash only).
   */
  private async sharedPaymentMethod(
    tx: Prisma.TransactionClient,
    referredAuthId: string,
    referrerAuthId: string,
  ): Promise<ReferralHoldReason | null> {
    const own = await tx.paymentFingerprint.findMany({
      where: { authId: referredAuthId },
      select: { fingerprintHash: true },
    });
    if (own.length === 0) return null;
    const shared = await tx.paymentFingerprint.findFirst({
      where: {
        fingerprintHash: { in: own.map((f) => f.fingerprintHash) },
        authId: { not: referredAuthId },
        OR: [
          { authId: referrerAuthId },
          { authUser: { referral: { is: { referrerAuthId } } } },
        ],
      },
      orderBy: { firstSeenAt: 'asc' },
      select: { authId: true },
    });
    if (!shared) return null;
    return shared.authId === referrerAuthId
      ? 'SHARED_PAYMENT_METHOD_WITH_REFERRER'
      : 'SHARED_PAYMENT_METHOD_WITH_OTHER_REFERRAL';
  }
}
