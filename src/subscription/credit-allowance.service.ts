import { Injectable } from '@nestjs/common';
import {
  CreditSource,
  PaymentStatus,
  Prisma,
  SubscriptionEventType,
} from '@prisma/client';
import { PrismaService } from '../common/services/prisma.service';
import { CreditSettingsService } from '../credits/credit-settings.service';
import { CreditWalletService } from '../credits/credit-wallet.service';
import type { GrantCreditsResult } from '../credits/interfaces/credit-wallet.interface';
import {
  paidAllowancePeriod,
  paidAllowanceReference,
  trialAllowanceReference,
  type PaidPeriodSource,
} from './credit-allowance.policy';
import { isProActive } from './subscription-access.policy';

export const TRIAL_CREDITS_DESCRIPTION = 'Free trial credits';
export const TRIAL_CREDITS_ENDED_BY_UPGRADE =
  'TRIAL credits expired: upgraded to Pro';
export const PRO_CREDITS_DESCRIPTION = 'Monthly Pro credits';

/**
 * GRANTED: new credits. ALREADY_GRANTED: this period already has its credits
 * (a repeated event, retry or second payment for the period). PERIOD_OVER:
 * the paid period has ended, nothing to grant. NOT_PAID: no successful
 * payment that granted or extended Pro covers the moment.
 */
export type PaidPeriodGrantOutcome =
  | 'GRANTED'
  | 'ALREADY_GRANTED'
  | 'PERIOD_OVER'
  | 'NOT_PAID';

/** Payments that paid for Pro (a refunded one no longer grants credits). */
const PAID_STATUSES = [
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
];

/**
 * Credit changes caused by subscription events, written in the same
 * database transaction as the event itself:
 *
 * - trial activation grants the trial allowance (the administrator's
 *   `trialCredits`, default 50), expiring with the trial: a trial is never
 *   started without its credits, and a failed grant rolls the activation
 *   back;
 * - buying paid Pro ends any unused trial credits at once (EXPIRATION,
 *   effective at the purchase), leaving purchased and referral credits
 *   untouched.
 *
 * - a successful Pro payment (first payment or renewal) grants the
 *   administrator's `proMonthlyCredits` (default 1000) for its billing
 *   period, expiring at the period's end (the billing boundary), linked to
 *   the user, subscription, payment and period.
 *
 * All are idempotent: a trial's credits are granted once (one TRIAL
 * allocation per user), a billing period's credits once (one allocation per
 * user and period start), and an allocation is expired once; the database
 * enforces the same.
 */
@Injectable()
export class CreditAllowanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: CreditWalletService,
    private readonly settings: CreditSettingsService,
  ) {}

  /**
   * Grants the monthly Pro credits `payment` paid for: its allowance period
   * at `at` (see paidAllowancePeriod). Call only for a successful payment
   * that created or renewed the paid term, in the transaction that recorded
   * it and holds the subscription row lock, so that concurrent grants for
   * the subscription are applied one at a time.
   */
  async grantPaidPeriod(
    tx: Prisma.TransactionClient,
    input: {
      authId: string;
      subscriptionId: string;
      payment: PaidPeriodSource & { id: string };
      at: Date;
    },
  ): Promise<PaidPeriodGrantOutcome> {
    const period = paidAllowancePeriod(input.payment, input.at);
    if (!period) return 'PERIOD_OVER';

    const granted = await tx.creditAllocation.findFirst({
      where: {
        authId: input.authId,
        source: CreditSource.SUBSCRIPTION,
        OR: [
          { periodStart: period.start },
          // Monthly credits granted before payments were linked, for a
          // month overlapping this period.
          {
            paymentId: null,
            expiresAt: { gt: period.start },
            grantedAt: { lt: period.end },
          },
        ],
      },
      select: { id: true },
    });
    if (granted) return 'ALREADY_GRANTED';

    const settings = await this.settings.getSettings(tx);
    await this.wallet.grant(
      {
        authId: input.authId,
        source: CreditSource.SUBSCRIPTION,
        sourceReference: paidAllowanceReference(input.payment.id, period.start),
        amount: settings.proMonthlyCredits,
        expiresAt: period.end,
        description: PRO_CREDITS_DESCRIPTION,
        paidPeriod: {
          subscriptionId: input.subscriptionId,
          paymentId: input.payment.id,
          periodStart: period.start,
          periodEnd: period.end,
        },
      },
      { tx, at: input.at },
    );
    return 'GRANTED';
  }

  /**
   * Grants the current period's monthly Pro credits if they are missing:
   * for example a later month of a yearly payment, or a payment recorded
   * before credits were granted with payments. Only a successful payment
   * that created or renewed the paid term and covers `at` counts; duplicate
   * charges (kept for refunds) never grant credits.
   */
  grantCurrentPaidPeriod(
    authId: string,
    at: Date = new Date(),
  ): Promise<PaidPeriodGrantOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.userSubscription.findUnique({
        where: { authId },
        select: { id: true },
      });
      if (!found) return 'NOT_PAID';
      // Same lock as the Stripe webhooks: one grant at a time.
      await tx.$queryRaw`
        SELECT "id" FROM "UserSubscription" WHERE "id" = ${found.id} FOR UPDATE
      `;
      const record = await tx.userSubscription.findUniqueOrThrow({
        where: { id: found.id },
      });
      if (!isProActive(record, at)) return 'NOT_PAID';

      const payment = await tx.paymentTransaction.findFirst({
        where: {
          subscriptionId: record.id,
          status: { in: PAID_STATUSES },
          periodStart: { lte: at },
          periodEnd: { gt: at },
          event: {
            type: {
              in: [
                SubscriptionEventType.CREATED,
                SubscriptionEventType.RENEWED,
              ],
            },
          },
        },
        orderBy: { periodStart: 'desc' },
      });
      if (!payment) return 'NOT_PAID';
      return this.grantPaidPeriod(tx, {
        authId,
        subscriptionId: record.id,
        payment,
        at,
      });
    });
  }

  async grantTrialCredits(
    tx: Prisma.TransactionClient,
    authId: string,
    trial: { startedAt: Date; expiresAt: Date },
  ): Promise<GrantCreditsResult> {
    const settings = await this.settings.getSettings(tx);
    return this.wallet.grant(
      {
        authId,
        source: CreditSource.TRIAL,
        sourceReference: trialAllowanceReference(trial.startedAt),
        amount: settings.trialCredits,
        expiresAt: trial.expiresAt,
        description: TRIAL_CREDITS_DESCRIPTION,
      },
      // Granted at the moment the trial starts.
      { tx, at: trial.startedAt },
    );
  }

  /**
   * Ends unused trial credits, effective `at` (when paid Pro was
   * activated). Returns how many trial allocations were ended.
   */
  expireTrialCreditsOnUpgrade(
    tx: Prisma.TransactionClient,
    authId: string,
    at: Date,
  ): Promise<number> {
    return this.wallet.expireSourceNow(
      authId,
      CreditSource.TRIAL,
      TRIAL_CREDITS_ENDED_BY_UPGRADE,
      { tx, at },
    );
  }
}
