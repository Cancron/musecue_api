import { Injectable } from '@nestjs/common';
import {
  CreditSource,
  PaymentStatus,
  type Prisma,
  ReferralStatus,
} from '@prisma/client';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { CreditWalletService } from '../../credits/credit-wallet.service';
import { DISCOUNT_SETTINGS_ID } from '../../discounts/discount-settings.constants';
import { referralRewardReference } from '../../referrals/referral.policy';

const LOG_CONTEXT = 'ReferralRewardService';

export type ReferralRewardOutcome =
  /** Not a paying purchase, or the payer was not referred. */
  | 'NONE'
  | 'REWARDED'
  /** Qualified, but no reward was due (switched off, referrer deleted). */
  | 'QUALIFIED'
  /** The referral was already rewarded or qualified by an earlier payment. */
  | 'ALREADY_QUALIFIED';

/**
 * Referral rewards: when a referred user's first verified paying purchase is
 * recorded (a SUCCEEDED Stripe payment above $0, first payment or renewal),
 * the referrer receives `referrerRewardCredits` non-expiring REFERRAL
 * credits, in the same transaction as the payment.
 *
 * Only the webhook's verified payment path calls this, so signup, email
 * verification, trial activation, and failed, pending, canceled or
 * abandoned purchases never reward. A $0 purchase (100% discount) does not
 * qualify; the first paying payment after it does. Each referral is
 * rewarded at most once: the payment transaction holds the referred user's
 * lock, the referral moves PENDING -> REWARDED in a conditional update, the
 * credits carry a unique reference (`referral-reward:<referral id>`), and
 * database triggers refuse any second status change or unmatched reward, so
 * repeated or concurrent webhook deliveries cannot grant twice.
 */
@Injectable()
export class ReferralRewardService {
  constructor(
    private readonly wallet: CreditWalletService,
    private readonly logger: CustomLoggerService,
  ) {}

  async onVerifiedPayment(
    tx: Prisma.TransactionClient,
    authId: string,
    payment: { id: string; amountCents: number; status: PaymentStatus },
    now: Date,
  ): Promise<ReferralRewardOutcome> {
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
    const rewarded = referral.referrerAuthId !== null && credits > 0;
    const qualified = {
      qualifyingPaymentId: payment.id,
      qualifiedAt: now,
    };
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
    if (!rewarded) return 'QUALIFIED';

    await this.wallet.grant(
      {
        authId: referral.referrerAuthId as string,
        source: CreditSource.REFERRAL,
        sourceReference: referralRewardReference(referral.id),
        amount: String(credits),
        description: 'Referral reward',
      },
      { tx, at: now },
    );
    this.logger.logWithMetadata('info', 'Referral rewarded', {
      context: LOG_CONTEXT,
      referralId: referral.id,
      paymentId: payment.id,
      credits,
    });
    return 'REWARDED';
  }
}
