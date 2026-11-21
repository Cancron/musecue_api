import { Injectable } from '@nestjs/common';
import {
  CreditScheduleStatus,
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
  paymentAllowancePeriods,
  paymentAllowanceReference,
  scheduledAllocationTime,
  trialAllowanceReference,
  type PaidPeriod,
} from './credit-allowance.policy';
import {
  isProActive,
  type SubscriptionRecord,
} from './subscription-access.policy';

export const TRIAL_CREDITS_DESCRIPTION = 'Free trial credits';
export const TRIAL_CREDITS_ENDED_BY_UPGRADE =
  'TRIAL credits expired: upgraded to Pro';
export const PRO_CREDITS_DESCRIPTION = 'Monthly Pro credits';
export const PRO_CREDITS_ENDED_BY_REFUND =
  'SUBSCRIPTION credits expired: payment refunded';

/** Why a scheduled month was not allocated. */
export const SKIP_PAYMENT_NOT_SUCCEEDED = 'PAYMENT_NOT_SUCCEEDED';
export const SKIP_OUTSIDE_PAID_TERM = 'OUTSIDE_PAID_TERM';

/** A successful payment that created or renewed the paid term. */
export interface TermPayment extends PaidPeriod {
  id: string;
  subscriptionId: string;
}

/** What happened to one scheduled month. */
export type ScheduledMonthOutcome =
  | 'ALLOCATED'
  | 'SKIPPED'
  /** Already processed, or being processed by another worker right now. */
  | 'NOT_PENDING';

export interface DueMonthsResult {
  allocated: number;
  skipped: number;
  notPending: number;
  failed: number;
}

const RECORD_SELECT = {
  trialUsed: true,
  trialStartedAt: true,
  trialExpiresAt: true,
  billingInterval: true,
  proStartedAt: true,
  proExpiresAt: true,
  proCanceledAt: true,
} as const;

/** Each month waits for other operations on the same wallet. */
const MONTH_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 255);

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
 *   untouched;
 * - every successful Stripe payment that creates or renews the paid term
 *   schedules `proMonthlyCredits` (default 1000) for each month it pays for
 *   (CreditAllocationSchedule: one month for monthly billing, twelve for
 *   yearly) and allocates the first month at once. Each later month is
 *   allocated when it begins (CreditAllocationScheduler), never all at once.
 *   Each month's credits expire at its end, the next billing boundary.
 *
 * All are idempotent: a trial's credits are granted once; each payment's
 * month is scheduled once, allocated at most once, and only while the
 * payment is SUCCEEDED and the paid term covers the month (also enforced by
 * the database); an allocation is expired once.
 */
@Injectable()
export class CreditAllowanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: CreditWalletService,
    private readonly settings: CreditSettingsService,
  ) {}

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

  /**
   * In the transaction that applies a refund ending the access a payment
   * paid for: the unused credits of its months expire now (EXPIRATION,
   * effective at the refund) and its months not allocated yet are SKIPPED,
   * so the history shows when and why the credits ended. Credits of other
   * payments and sources are untouched. Idempotent. Returns how many
   * allocations were ended.
   */
  async endRefundedPaymentCredits(
    tx: Prisma.TransactionClient,
    authId: string,
    paymentId: string,
    now: Date,
  ): Promise<number> {
    await tx.creditAllocationSchedule.updateMany({
      where: { paymentId, status: CreditScheduleStatus.PENDING },
      data: {
        status: CreditScheduleStatus.SKIPPED,
        skipReason: SKIP_PAYMENT_NOT_SUCCEEDED,
        processedAt: now,
      },
    });
    return this.wallet.expirePaymentCreditsNow(
      authId,
      paymentId,
      PRO_CREDITS_ENDED_BY_REFUND,
      { tx, at: now },
    );
  }

  /**
   * In the transaction that records a successful payment creating or
   * renewing the paid term: schedules every month the payment pays for and
   * allocates the first one (an early renewal's first month counts from its
   * start), plus any later month that has already begun (a late webhook).
   * The remaining months of a yearly payment are allocated when they begin.
   * Returns how many months were allocated now.
   */
  async recordPaidPeriod(
    tx: Prisma.TransactionClient,
    authId: string,
    payment: TermPayment,
    now: Date,
  ): Promise<number> {
    const periods = paymentAllowancePeriods(payment);
    if (periods.length === 0) return 0;
    await tx.creditAllocationSchedule.createMany({
      data: periods.map((period) => ({
        authId,
        subscriptionId: payment.subscriptionId,
        paymentId: payment.id,
        periodStart: period.start,
        periodEnd: period.end,
      })),
      skipDuplicates: true,
    });
    const due = await tx.creditAllocationSchedule.findMany({
      where: {
        paymentId: payment.id,
        status: CreditScheduleStatus.PENDING,
        OR: [{ periodStart: periods[0].start }, { periodStart: { lte: now } }],
      },
      orderBy: { periodStart: 'asc' },
      select: { id: true },
    });
    let allocated = 0;
    for (const row of due) {
      if (
        (await this.allocateScheduledMonth(tx, row.id, now)) === 'ALLOCATED'
      ) {
        allocated += 1;
      }
    }
    return allocated;
  }

  /**
   * Allocates one scheduled month in the caller's transaction if it is still
   * PENDING; the row is locked first, so concurrent callers never process
   * the same month. Background workers pass `skipLocked` (FOR UPDATE SKIP
   * LOCKED: a month another worker holds is left to it); a user's request
   * waits for the other transaction instead and then finds the month
   * ALLOCATED, so its balance includes the credits. The month is SKIPPED
   * instead when its payment is no longer SUCCEEDED (refunded) or the paid
   * term does not cover its start.
   */
  async allocateScheduledMonth(
    tx: Prisma.TransactionClient,
    scheduleId: string,
    now: Date,
    lock: { skipLocked?: boolean } = {},
  ): Promise<ScheduledMonthOutcome> {
    const claimed = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "CreditAllocationSchedule"
      WHERE "id" = ${scheduleId} AND "status" = 'PENDING'
      FOR UPDATE ${lock.skipLocked ? Prisma.sql`SKIP LOCKED` : Prisma.empty}
    `;
    if (claimed.length === 0) return 'NOT_PENDING';
    const month = await tx.creditAllocationSchedule.findUniqueOrThrow({
      where: { id: scheduleId },
      include: { payment: { select: { status: true } } },
    });

    const record = await tx.userSubscription.findUnique({
      where: { id: month.subscriptionId },
      select: RECORD_SELECT,
    });
    const skipReason =
      month.payment.status !== PaymentStatus.SUCCEEDED
        ? SKIP_PAYMENT_NOT_SUCCEEDED
        : !isProActive(record, month.periodStart)
          ? SKIP_OUTSIDE_PAID_TERM
          : null;
    if (skipReason) {
      await tx.creditAllocationSchedule.update({
        where: { id: month.id },
        data: {
          status: CreditScheduleStatus.SKIPPED,
          skipReason,
          processedAt: now,
        },
      });
      return 'SKIPPED';
    }

    // Credits for this payment and month that already exist (e.g. granted
    // under another reference by an earlier release) are linked, never
    // granted twice: the database allows one allocation per payment and
    // month, so granting again would fail on every run.
    const existing = await tx.creditAllocation.findUnique({
      where: {
        paymentId_periodStart: {
          paymentId: month.paymentId,
          periodStart: month.periodStart,
        },
      },
      select: { id: true, authId: true },
    });
    if (existing && existing.authId === month.authId) {
      await tx.creditAllocationSchedule.update({
        where: { id: month.id },
        data: {
          status: CreditScheduleStatus.ALLOCATED,
          allocationId: existing.id,
          processedAt: now,
        },
      });
      return 'ALLOCATED';
    }

    // Amounts are the settings when the month is allocated.
    const settings = await this.settings.getSettings(tx);
    const grant = await this.wallet.grant(
      {
        authId: month.authId,
        source: CreditSource.SUBSCRIPTION,
        sourceReference: paymentAllowanceReference(
          month.paymentId,
          month.periodStart,
        ),
        amount: settings.proMonthlyCredits,
        expiresAt: month.periodEnd,
        description: PRO_CREDITS_DESCRIPTION,
        // A repeat keeps the first allocation, even if settings changed.
        keepExistingGrant: true,
        payment: {
          subscriptionId: month.subscriptionId,
          paymentId: month.paymentId,
          periodStart: month.periodStart,
        },
      },
      {
        tx,
        at: scheduledAllocationTime(
          { start: month.periodStart, end: month.periodEnd },
          now,
        ),
      },
    );
    await tx.creditAllocationSchedule.update({
      where: { id: month.id },
      data: {
        status: CreditScheduleStatus.ALLOCATED,
        allocationId: grant.allocation.id,
        processedAt: now,
      },
    });
    return 'ALLOCATED';
  }

  /**
   * Allocates every scheduled month that has begun by `now` and is still
   * PENDING (all users, or one), oldest first, each in its own transaction:
   * a failure rolls back only that month, which stays PENDING with its
   * attempt count and error, and is retried next time. Months that ended
   * while nothing ran are allocated as of their start and their expiry is
   * recorded right away. Safe to run concurrently and repeatedly. Workers
   * pass `skipLocked` (see allocateScheduledMonth).
   */
  async allocateDueMonths(
    options: {
      now?: Date;
      authId?: string;
      limit?: number;
      exclude?: string[];
      skipLocked?: boolean;
    } = {},
  ): Promise<DueMonthsResult & { processed: string[] }> {
    const now = options.now ?? new Date();
    const due = await this.prisma.creditAllocationSchedule.findMany({
      where: {
        status: CreditScheduleStatus.PENDING,
        periodStart: { lte: now },
        ...(options.authId ? { authId: options.authId } : {}),
        ...(options.exclude?.length ? { id: { notIn: options.exclude } } : {}),
      },
      orderBy: [{ periodStart: 'asc' }, { id: 'asc' }],
      take: options.limit ?? 100,
      select: { id: true, authId: true, periodEnd: true },
    });
    const result: DueMonthsResult = {
      allocated: 0,
      skipped: 0,
      notPending: 0,
      failed: 0,
    };
    const ended = new Set<string>();
    for (const month of due) {
      try {
        const outcome = await this.prisma.$transaction(
          (tx) =>
            this.allocateScheduledMonth(tx, month.id, now, {
              skipLocked: options.skipLocked,
            }),
          MONTH_TRANSACTION_OPTIONS,
        );
        if (outcome === 'ALLOCATED') {
          result.allocated += 1;
          if (month.periodEnd.getTime() <= now.getTime()) {
            ended.add(month.authId);
          }
        } else if (outcome === 'SKIPPED') {
          result.skipped += 1;
        } else {
          result.notPending += 1;
        }
      } catch (error) {
        result.failed += 1;
        await this.prisma.creditAllocationSchedule
          .updateMany({
            where: { id: month.id, status: CreditScheduleStatus.PENDING },
            data: { attempts: { increment: 1 }, lastError: errorText(error) },
          })
          .catch(() => undefined);
      }
    }
    for (const authId of ended) {
      await this.wallet.expireCredits(authId).catch(() => undefined);
    }
    return { ...result, processed: due.map((month) => month.id) };
  }

  /**
   * For payments recorded before months were scheduled with the payment:
   * schedules the months that have not ended of the successful payments
   * that created or renewed the current paid term and have no schedule yet,
   * then allocates the user's due months. New payments are scheduled when
   * recorded, so the first step finds nothing for them.
   */
  async catchUpPaidMonths(
    authId: string,
    record: SubscriptionRecord | null,
    now: Date,
  ): Promise<number> {
    if (record && isProActive(record, now)) {
      await this.scheduleLegacyPayments(authId, record, now);
    }
    return (await this.allocateDueMonths({ authId, now })).allocated;
  }

  private async scheduleLegacyPayments(
    authId: string,
    record: SubscriptionRecord,
    now: Date,
  ): Promise<void> {
    const payments = await this.prisma.paymentTransaction.findMany({
      where: {
        subscription: { authId },
        status: PaymentStatus.SUCCEEDED,
        event: {
          is: {
            type: {
              in: [
                SubscriptionEventType.CREATED,
                SubscriptionEventType.RENEWED,
              ],
            },
          },
        },
        periodStart: { gte: record.proStartedAt as Date },
        periodEnd: { lte: record.proExpiresAt as Date, gt: now },
        creditSchedule: { none: {} },
      },
      select: {
        id: true,
        subscriptionId: true,
        billingInterval: true,
        periodStart: true,
        periodEnd: true,
      },
    });
    for (const payment of payments) {
      if (payment.subscriptionId === null) continue;
      const periods = paymentAllowancePeriods(payment).filter(
        (period) => period.end.getTime() > now.getTime(),
      );
      await this.prisma.creditAllocationSchedule.createMany({
        data: periods.map((period) => ({
          authId,
          subscriptionId: payment.subscriptionId as string,
          paymentId: payment.id,
          periodStart: period.start,
          periodEnd: period.end,
        })),
        skipDuplicates: true,
      });
    }
  }
}
