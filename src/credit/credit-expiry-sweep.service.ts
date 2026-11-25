import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { CreditUsageService } from './credit-usage.service';
import { CreditWalletService } from './credit-wallet.service';

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const MIN_SWEEP_INTERVAL_MS = 10_000;
/** Wallets per transaction batch. */
export const CREDIT_EXPIRY_BATCH_SIZE = 100;
/** Upper bound per sweep, so one run cannot monopolise the database. */
export const CREDIT_EXPIRY_MAX_BATCHES = 50;

export interface CreditExpirySweepResult {
  wallets: number;
  expiredAllocations: number;
  failedWallets: number;
  /** AI usages left pending by interrupted runs, closed as not charged. */
  reconciledUsages: number;
}

/**
 * Records the expiry of unused trial and subscription credits in the ledger
 * for every wallet, including wallets nobody uses any more, so expired
 * credits are always traceable as EXPIRATION transactions dated at their
 * expiry time. (Balances never count expired credits either way; wallet
 * operations also expire due credits first.)
 *
 * Runs at startup (catching up after downtime) and then every
 * CREDIT_EXPIRY_SWEEP_INTERVAL_MS (default 60 s, minimum 10 s), except under
 * NODE_ENV=test. Safe to run on several instances at once: each wallet is
 * expired in its own transaction holding the wallet lock, and an allocation
 * can only be expired once (database constraint).
 */
@Injectable()
export class CreditExpirySweepService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopping = false;
  private current?: Promise<unknown>;

  /**
   * Settings are read from the process environment (ConfigModule loads the
   * env files into it), so the module needs no ConfigService.
   */
  constructor(
    private readonly wallets: CreditWalletService,
    private readonly logger: CustomLoggerService,
    private readonly usage: CreditUsageService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.sweepIntervalMs());
    this.timer.unref();
    void this.sweep();
  }

  /**
   * Graceful shutdown: no new sweeps, the current sweep stops after its
   * current batch, and shutdown waits for it before the database
   * connections close. The next startup's sweep continues.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await this.current;
  }

  sweepIntervalMs(): number {
    const value = Number(process.env.CREDIT_EXPIRY_SWEEP_INTERVAL_MS);
    return Number.isInteger(value) && value >= MIN_SWEEP_INTERVAL_MS
      ? value
      : DEFAULT_SWEEP_INTERVAL_MS;
  }

  /**
   * Expires every due allocation, batch by batch. Returns null when a sweep
   * is already running in this process. Never throws.
   */
  async sweep(now: Date = new Date()): Promise<CreditExpirySweepResult | null> {
    if (this.running || this.stopping) return null;
    this.running = true;
    const sweep = this.sweepBatches(now);
    this.current = sweep;
    try {
      return await sweep;
    } finally {
      this.running = false;
      this.current = undefined;
    }
  }

  private async sweepBatches(now: Date): Promise<CreditExpirySweepResult> {
    const total: CreditExpirySweepResult = {
      wallets: 0,
      expiredAllocations: 0,
      failedWallets: 0,
      reconciledUsages: 0,
    };
    try {
      total.reconciledUsages = await this.usage.reconcileStaleUsage();
      for (let batch = 0; batch < CREDIT_EXPIRY_MAX_BATCHES; batch += 1) {
        if (this.stopping) break;
        const result = await this.wallets.expireAllDueCredits({
          now,
          batchSize: CREDIT_EXPIRY_BATCH_SIZE,
        });
        total.wallets += result.wallets;
        total.expiredAllocations += result.expiredAllocations;
        total.failedWallets += result.failedWallets;
        // Stop when the backlog is drained, or when a batch made no progress
        // (only failing wallets are left; the next sweep retries them).
        if (
          result.wallets < CREDIT_EXPIRY_BATCH_SIZE ||
          result.expiredAllocations === 0
        ) {
          break;
        }
      }
    } catch (error) {
      this.logger.warn(
        `Credit expiry sweep failed (${error instanceof Error ? error.name : typeof error}); it will retry`,
        CreditExpirySweepService.name,
      );
    }
    if (
      total.expiredAllocations > 0 ||
      total.failedWallets > 0 ||
      total.reconciledUsages > 0
    ) {
      this.logger.log(
        `Credit expiry sweep: ${total.expiredAllocations} allocation(s) expired in ${total.wallets} wallet(s), ${total.failedWallets} wallet(s) failed, ${total.reconciledUsages} interrupted AI usage(s) reconciled`,
        CreditExpirySweepService.name,
      );
    }
    return total;
  }
}
