import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  BillingInterval,
  PaymentStatus,
  SubscriptionEventType,
} from '@prisma/client';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { PrismaService } from '../common/services/prisma.service';
import {
  type CreditMonth,
  creditMonths,
} from '../credit/credit-subscription.policy';
import { CreditWalletService } from '../credit/credit-wallet.service';
import { isProActive } from './subscription-access.policy';

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 10_000;
/** Payments read per query while scanning. */
export const CREDIT_GRANT_BATCH_SIZE = 100;
/** Interactive transactions queue on the subscription and wallet locks. */
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

/** Payments that granted or extended Pro access (not duplicate payments). */
const GRANTING_EVENTS = [
  SubscriptionEventType.CREATED,
  SubscriptionEventType.RENEWED,
];

/** Months allocated for one payment by one grant. */
export interface MonthlyGrantOutcome {
  /** The current month, granted and usable. */
  granted: number;
  /** Months that ended before they were granted: recorded and expired. */
  historical: number;
}

export interface MonthlyGrantRunResult {
  /** Yearly payments whose paid months are not all recorded yet. */
  checked: number;
  /** Current months newly allocated in this run. */
  granted: number;
  /** Ended (missed) months newly recorded as granted and expired. */
  historical: number;
  /** Payments whose started months all have their allocation. */
  alreadyGranted: number;
  /** Payments no longer eligible under the lock (refunded, ...). */
  skipped: number;
  /** Payments whose grant failed; retried by the next run. */
  failed: number;
}

/**
 * The months of a payment that are due and missing at `now`, in order:
 * started months without an allocation.
 */
function missingMonths(
  payment: {
    billingInterval: BillingInterval;
    periodStart: Date;
    periodEnd: Date;
  },
  granted: readonly (number | null)[],
  now: Date,
): CreditMonth[] {
  return creditMonths(payment).filter(
    (month) =>
      month.start.getTime() <= now.getTime() && !granted.includes(month.index),
  );
}

/**
 * Monthly Pro credits for yearly subscriptions. A yearly payment pays for
 * twelve months of credits; the Stripe webhook allocates the month that is
 * due when the payment is recorded, and this scheduler allocates each later
 * month when it begins (credit-subscription.policy), so the year's credits
 * are never granted at once. Each month's credits expire at the month's end
 * (EXPIRATION transactions, see CreditExpirySweepService).
 *
 * A month is granted only while the yearly payment SUCCEEDED (not refunded),
 * granted Pro access (CREATED/RENEWED event; never a duplicate payment), its
 * paid year contains the month, and the subscription's paid term is active.
 *
 * Runs at startup, which catches up on months missed while the application
 * or this worker was stopped (the month that is due now), and then every
 * CREDIT_ALLOCATION_INTERVAL_MS (default 60 s, minimum 10 s), except under
 * NODE_ENV=test. Repeated runs, restarts, concurrent runs and several
 * instances never duplicate a month: each grant is one transaction that
 * locks the subscription row, re-checks eligibility and allocates through
 * the idempotent CreditWalletService (unique per payment and month in the
 * database). A failed or interrupted grant rolls back completely and is
 * retried by the next run.
 */
@Injectable()
export class SubscriptionCreditSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopping = false;
  private current?: Promise<unknown>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallets: CreditWalletService,
    private readonly logger: CustomLoggerService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.run();
    }, this.intervalMs());
    this.timer.unref();
    // Catch up at once: months that began while the worker was stopped.
    void this.run();
  }

  /**
   * Graceful shutdown: no new runs, the current run stops after the grant
   * it is making (its transaction commits or rolls back), and shutdown waits
   * for it before the database connections close. Months not reached are
   * granted by the next startup's catch-up.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await this.current;
  }

  intervalMs(): number {
    const value = Number(process.env.CREDIT_ALLOCATION_INTERVAL_MS);
    return Number.isInteger(value) && value >= MIN_INTERVAL_MS
      ? value
      : DEFAULT_INTERVAL_MS;
  }

  /**
   * Grants the month that is due at `now` for every eligible yearly payment
   * that does not have it yet. Returns null when a run is already in
   * progress in this process. Never throws.
   */
  async run(now: Date = new Date()): Promise<MonthlyGrantRunResult | null> {
    if (this.running || this.stopping) return null;
    this.running = true;
    const run = this.runBatches(now);
    this.current = run;
    try {
      return await run;
    } finally {
      this.running = false;
      this.current = undefined;
    }
  }

  private async runBatches(now: Date): Promise<MonthlyGrantRunResult> {
    const result: MonthlyGrantRunResult = {
      checked: 0,
      granted: 0,
      historical: 0,
      alreadyGranted: 0,
      skipped: 0,
      failed: 0,
    };
    try {
      let cursor: string | undefined;
      for (;;) {
        const batch = await this.prisma.paymentTransaction.findMany({
          where: {
            status: PaymentStatus.SUCCEEDED,
            billingInterval: BillingInterval.YEARLY,
            periodStart: { lte: now },
            event: { type: { in: GRANTING_EVENTS } },
            subscription: { isNot: null },
            // Not every month recorded yet (months are recorded in order, so
            // a recorded last month means the whole year is done).
            creditAllocations: { none: { periodIndex: 11 } },
          },
          select: {
            id: true,
            billingInterval: true,
            periodStart: true,
            periodEnd: true,
            creditAllocations: { select: { periodIndex: true } },
          },
          orderBy: { id: 'asc' },
          take: CREDIT_GRANT_BATCH_SIZE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });

        for (const payment of batch) {
          if (this.stopping) return result;
          result.checked += 1;
          const missing = missingMonths(
            payment,
            payment.creditAllocations.map((a) => a.periodIndex),
            now,
          );
          if (missing.length === 0) {
            result.alreadyGranted += 1;
            continue;
          }
          try {
            const outcome = await this.grantDueMonths(payment.id, now);
            result.granted += outcome.granted;
            result.historical += outcome.historical;
            if (outcome.granted + outcome.historical === 0) {
              result.skipped += 1;
            }
          } catch (error) {
            result.failed += 1;
            this.logger.warn(
              `Monthly Pro credits for payment ${payment.id} could not be granted (${errorName(error)}); retried on the next run`,
              SubscriptionCreditSchedulerService.name,
            );
          }
        }
        if (batch.length < CREDIT_GRANT_BATCH_SIZE) break;
        cursor = batch[batch.length - 1].id;
      }
    } catch (error) {
      this.logger.warn(
        `Monthly Pro credit run failed (${errorName(error)}); it will retry`,
        SubscriptionCreditSchedulerService.name,
      );
    }
    if (result.granted > 0 || result.historical > 0 || result.failed > 0) {
      this.logger.log(
        `Monthly Pro credits: ${result.granted} month(s) granted, ${result.historical} missed month(s) recorded as expired, ${result.alreadyGranted} up to date, ${result.skipped} skipped, ${result.failed} failed`,
        SubscriptionCreditSchedulerService.name,
      );
    }
    return result;
  }

  /**
   * Grants the missing months of one yearly payment up to `now`, in one
   * transaction: locks the subscription row (the same lock the Stripe
   * webhook and refunds take), re-checks eligibility under the lock, then
   * allocates each month idempotently, oldest first. The current month is
   * granted while the subscription is active; months that already ended
   * (missed while the scheduler was stopped) are recorded as granted at the
   * month's start and expired at its end, if the paid term covered them.
   */
  async grantDueMonths(
    paymentId: string,
    now: Date = new Date(),
  ): Promise<MonthlyGrantOutcome> {
    const none: MonthlyGrantOutcome = { granted: 0, historical: 0 };
    return this.prisma.$transaction(async (tx) => {
      const link = await tx.paymentTransaction.findUnique({
        where: { id: paymentId },
        select: { subscriptionId: true },
      });
      if (!link?.subscriptionId) return none;
      await tx.$queryRaw`
        SELECT "id" FROM "UserSubscription" WHERE "id" = ${link.subscriptionId} FOR UPDATE`;

      const payment = await tx.paymentTransaction.findUnique({
        where: { id: paymentId },
        include: {
          subscription: true,
          event: true,
          creditAllocations: { select: { periodIndex: true } },
        },
      });
      const subscription = payment?.subscription;
      if (
        !payment ||
        !subscription ||
        payment.status !== PaymentStatus.SUCCEEDED ||
        payment.billingInterval !== BillingInterval.YEARLY ||
        !payment.event ||
        !GRANTING_EVENTS.some((type) => type === payment.event?.type)
      ) {
        return none;
      }

      const outcome: MonthlyGrantOutcome = { granted: 0, historical: 0 };
      const missing = missingMonths(
        payment,
        payment.creditAllocations.map((a) => a.periodIndex),
        now,
      );
      for (const month of missing) {
        const ended = month.end.getTime() <= now.getTime();
        // An ended month counts if the paid term covered its start; the
        // current month needs the term to be active now.
        const eligible = ended
          ? isProActive(subscription, month.start)
          : isProActive(subscription, now);
        if (!eligible) continue;
        const allocation =
          await this.wallets.allocateProMonthCreditsInTransaction(tx, {
            authId: subscription.authId,
            subscriptionId: subscription.id,
            payment,
            month,
            now,
          });
        if (!allocation?.created) continue;
        if (ended) outcome.historical += 1;
        else outcome.granted += 1;
      }
      return outcome;
    }, TX_OPTIONS);
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
