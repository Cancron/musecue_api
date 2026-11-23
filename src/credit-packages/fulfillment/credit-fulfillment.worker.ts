import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { CreditPackageOrderStatus } from '@prisma/client';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { CreditGiftService } from '../gifts/credit-gift.service';
import { CreditPackagePaymentService } from '../purchases/credit-package-payment.service';
import {
  CreditFulfillmentService,
  type FulfillmentOutcome,
} from './credit-fulfillment.service';

const LOG_CONTEXT = 'CreditFulfillmentWorker';
const DEFAULT_INTERVAL_MS = 15_000;
const MIN_INTERVAL_MS = 1_000;
/** Unsettled orders older than this are checked with Stripe. */
export const RECONCILE_AFTER_MS = 10 * 60_000;
const RECONCILE_BATCH = 20;

export interface FulfillmentRunResult {
  expiredGifts: number;
  reconciledOrders: number;
  fulfillments: FulfillmentOutcome[];
}

/**
 * Recovery of credit package orders and gifts. Each run:
 * 1. expires gift invitations not accepted and paid in time;
 * 2. reconciles orders whose payment outcome never arrived (OPEN or
 *    PROCESSING for RECONCILE_AFTER_MS): their Stripe checkout is read again
 *    and a verified payment is recorded, an expired one closed (lost or
 *    failed webhooks, or a crash before the payment was recorded);
 * 3. grants every due fulfillment (scheduled gifts, retries, and paid orders
 *    whose credits were not granted because of a crash or failure).
 * Runs at startup and every CREDIT_FULFILLMENT_INTERVAL_MS (default 15000),
 * unless NODE_ENV=test (CREDIT_FULFILLMENT_WORKER_ENABLED=true runs it there
 * too). Several instances may run it at once: each order and fulfillment is
 * processed under a row lock and completed once.
 */
@Injectable()
export class CreditFulfillmentWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<FulfillmentRunResult> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfillments: CreditFulfillmentService,
    private readonly payments: CreditPackagePaymentService,
    private readonly gifts: CreditGiftService,
    private readonly logger: CustomLoggerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const enabled =
      process.env.NODE_ENV !== 'test' ||
      process.env.CREDIT_FULFILLMENT_WORKER_ENABLED === 'true';
    if (!enabled) return;
    await this.tick();
    const configured = Number(process.env.CREDIT_FULFILLMENT_INTERVAL_MS);
    const interval =
      Number.isFinite(configured) && configured >= MIN_INTERVAL_MS
        ? configured
        : DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One run (one at a time per instance). */
  runOnce(now: Date = new Date()): Promise<FulfillmentRunResult> {
    this.running ??= this.run(now).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(now: Date): Promise<FulfillmentRunResult> {
    const expiredGifts = await this.gifts.expireDue(now);
    const stale = await this.prisma.creditPackageOrder.findMany({
      where: {
        status: {
          in: [
            CreditPackageOrderStatus.OPEN,
            CreditPackageOrderStatus.PROCESSING,
          ],
        },
        providerSessionId: { not: null },
        updatedAt: { lte: new Date(now.getTime() - RECONCILE_AFTER_MS) },
      },
      orderBy: { updatedAt: 'asc' },
      take: RECONCILE_BATCH,
      select: { id: true },
    });
    let reconciledOrders = 0;
    for (const { id } of stale) {
      try {
        const outcome = await this.payments.reconcile(id, now);
        if (outcome !== 'IGNORED') reconciledOrders += 1;
      } catch (error) {
        this.logger.logWithMetadata(
          'warn',
          'Could not reconcile a credit package order; retried on the next run',
          {
            context: LOG_CONTEXT,
            orderId: id,
            error: error instanceof Error ? error.name : 'unknown',
          },
        );
      }
    }
    const fulfillments = await this.fulfillments.processDue(now);
    return { expiredGifts, reconciledOrders, fulfillments };
  }

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.logWithMetadata('warn', 'Credit fulfillment run failed', {
        context: LOG_CONTEXT,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}
