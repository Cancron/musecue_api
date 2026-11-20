import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { CreditAllowanceService } from './credit-allowance.service';

export const DEFAULT_CREDIT_ALLOCATION_INTERVAL_MS = 60_000;
export const MIN_CREDIT_ALLOCATION_INTERVAL_MS = 10_000;
/** Months per batch, and batches per run (the rest waits for the next). */
export const CREDIT_ALLOCATION_BATCH_SIZE = 100;
export const CREDIT_ALLOCATION_MAX_BATCHES = 50;

/** CREDIT_ALLOCATION_INTERVAL_MS, or the default if unset or invalid. */
export function readCreditAllocationIntervalMs(env: NodeJS.ProcessEnv): number {
  const value = Number(env.CREDIT_ALLOCATION_INTERVAL_MS);
  return Number.isInteger(value) && value >= MIN_CREDIT_ALLOCATION_INTERVAL_MS
    ? value
    : DEFAULT_CREDIT_ALLOCATION_INTERVAL_MS;
}

export interface CreditAllocationRunResult {
  allocated: number;
  skipped: number;
  notPending: number;
  failed: number;
}

/**
 * Allocates the monthly Pro credits of yearly subscriptions (and any other
 * scheduled month) when each month begins, from CreditAllocationSchedule in
 * PostgreSQL. Runs at startup, which allocates every month missed while the
 * application was not running, and then every CREDIT_ALLOCATION_INTERVAL_MS
 * (default 60 s, minimum 10 s); not started when NODE_ENV=test.
 *
 * Needs PostgreSQL only, and is safe to run on several instances at once and
 * to interrupt at any point: each month is claimed with FOR UPDATE SKIP
 * LOCKED and allocated in its own transaction together with its status
 * change, so a run that stops half-way leaves the month PENDING for the next
 * run, and a month is never allocated twice (one allocation per payment and
 * month is also enforced by the database).
 */
@Injectable()
export class CreditAllocationScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly allowances: CreditAllowanceService,
    private readonly logger: CustomLoggerService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.run();
    }, readCreditAllocationIntervalMs(process.env));
    this.timer.unref();
    // Catch up at once, e.g. after downtime.
    void this.run();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Runs once. Returns null if a run is already in progress here. */
  async run(now: Date = new Date()): Promise<CreditAllocationRunResult | null> {
    if (this.running) return null;
    this.running = true;
    const total: CreditAllocationRunResult = {
      allocated: 0,
      skipped: 0,
      notPending: 0,
      failed: 0,
    };
    // Months seen in this run are not retried in it (failures and months
    // another worker holds wait for the next run).
    const seen: string[] = [];
    try {
      for (let batch = 0; batch < CREDIT_ALLOCATION_MAX_BATCHES; batch += 1) {
        const result = await this.allowances.allocateDueMonths({
          now,
          limit: CREDIT_ALLOCATION_BATCH_SIZE,
          exclude: [...seen],
          // Months another worker is allocating are left to it.
          skipLocked: true,
        });
        total.allocated += result.allocated;
        total.skipped += result.skipped;
        total.notPending += result.notPending;
        total.failed += result.failed;
        seen.push(...result.processed);
        if (result.processed.length < CREDIT_ALLOCATION_BATCH_SIZE) break;
      }
      if (total.allocated > 0 || total.skipped > 0 || total.failed > 0) {
        this.logger.log(
          `Monthly credit allocation: ${total.allocated} allocated, ${total.skipped} skipped, ${total.failed} failed`,
          CreditAllocationScheduler.name,
        );
      }
      return total;
    } catch (error) {
      this.logger.error(
        `Monthly credit allocation failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        CreditAllocationScheduler.name,
      );
      return total;
    } finally {
      this.running = false;
    }
  }
}
