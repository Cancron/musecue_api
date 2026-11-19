import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { CreditWalletService } from './credit-wallet.service';

export const DEFAULT_CREDIT_EXPIRATION_SWEEP_INTERVAL_MS = 60_000;
export const MIN_CREDIT_EXPIRATION_SWEEP_INTERVAL_MS = 10_000;
/** Wallets per batch, and batches per sweep (the rest waits for the next). */
export const CREDIT_EXPIRATION_SWEEP_BATCH_SIZE = 100;
export const CREDIT_EXPIRATION_SWEEP_MAX_BATCHES = 50;

/** CREDIT_EXPIRATION_SWEEP_INTERVAL_MS, or the default if unset or invalid. */
export function readCreditExpirationSweepIntervalMs(
  env: NodeJS.ProcessEnv,
): number {
  const value = Number(env.CREDIT_EXPIRATION_SWEEP_INTERVAL_MS);
  return Number.isInteger(value) &&
    value >= MIN_CREDIT_EXPIRATION_SWEEP_INTERVAL_MS
    ? value
    : DEFAULT_CREDIT_EXPIRATION_SWEEP_INTERVAL_MS;
}

export interface CreditExpirationSweepResult {
  wallets: number;
  expirations: number;
  failed: number;
}

/**
 * Records credit expirations in the transaction history for every wallet,
 * including wallets nobody uses any more, so expired credits are traceable.
 * Runs at startup (catching up after downtime) and then every
 * CREDIT_EXPIRATION_SWEEP_INTERVAL_MS; not started when NODE_ENV=test.
 *
 * Needs PostgreSQL only. Safe on several instances at once: each expiration
 * is written under its wallet's lock and exactly once (unique idempotency
 * key). Balances never wait for it: expired credits stop counting at their
 * expiry anyway.
 */
@Injectable()
export class CreditExpirationSweepService
  implements OnModuleInit, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly wallet: CreditWalletService,
    private readonly logger: CustomLoggerService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, readCreditExpirationSweepIntervalMs(process.env));
    this.timer.unref();
    void this.sweep();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Runs one sweep. Returns null if one is already running here. */
  async sweep(): Promise<CreditExpirationSweepResult | null> {
    if (this.running) return null;
    this.running = true;
    const total: CreditExpirationSweepResult = {
      wallets: 0,
      expirations: 0,
      failed: 0,
    };
    try {
      for (
        let batch = 0;
        batch < CREDIT_EXPIRATION_SWEEP_MAX_BATCHES;
        batch += 1
      ) {
        const result = await this.wallet.expireDueCredits({
          limit: CREDIT_EXPIRATION_SWEEP_BATCH_SIZE,
        });
        total.wallets += result.wallets;
        total.expirations += result.expirations;
        total.failed += result.failed;
        // Done, or only failing wallets are left (retried next sweep).
        if (
          result.wallets < CREDIT_EXPIRATION_SWEEP_BATCH_SIZE ||
          result.failed === result.wallets
        ) {
          break;
        }
      }
      if (total.expirations > 0 || total.failed > 0) {
        this.logger.log(
          `Credit expiration sweep: ${total.expirations} expirations in ${total.wallets} wallets, ${total.failed} failed`,
          CreditExpirationSweepService.name,
        );
      }
      return total;
    } catch (error) {
      this.logger.error(
        `Credit expiration sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        CreditExpirationSweepService.name,
      );
      return total;
    } finally {
      this.running = false;
    }
  }
}
