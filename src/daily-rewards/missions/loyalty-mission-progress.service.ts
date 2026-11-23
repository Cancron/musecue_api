import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { CreditSource, type Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { CreditWalletService } from '../../credits/credit-wallet.service';
import {
  countingWindow,
  missionPeriod,
  missionRewardReference,
} from './loyalty-mission.policy';

const LOG_CONTEXT = 'LoyaltyMissionProgressService';
const MISSION_LOCK = 'loyalty-missions:';
const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 1_000;
const BATCH = 100;

/**
 * Records a verified makeup completion in the transaction that completes
 * the session: the session's guide was finished with every step COMPLETED
 * (none skipped). Sessions with skipped steps, and unfinished sessions, are
 * not recorded and never count for missions. One completion per session
 * (repeated or concurrent completion requests record it once); PostgreSQL
 * checks the session independently. Returns whether it was recorded now.
 */
export async function recordVerifiedCompletion(
  tx: Prisma.TransactionClient,
  completion: { sessionId: string; authId: string; completedAt: Date },
): Promise<boolean> {
  const where = { guide: { sessionId: completion.sessionId } };
  const [steps, unfinished] = await Promise.all([
    tx.guideStep.count({ where }),
    tx.guideStep.count({ where: { ...where, status: { not: 'COMPLETED' } } }),
  ]);
  if (!(steps > 0) || unfinished !== 0) return false;
  const { count } = await tx.makeupCompletion.createMany({
    data: [completion],
    skipDuplicates: true,
  });
  return count === 1;
}

/**
 * Loyalty mission rewards. Every verified completion is evaluated once
 * against the active missions: each mission whose required completions are
 * reached in the completion's period (once ever, or its UTC week or month;
 * completions before the mission started do not count) is awarded once per
 * user and period, with MISSION_REWARD credits (never expiring; separate
 * from daily rewards and their monthly cap).
 *
 * A completion is evaluated right after the session completes, in a
 * transaction under a lock of the user's missions; it is marked processed in
 * the same transaction. If that is interrupted (error, crash, restart),
 * `processPending` evaluates it at startup and every
 * LOYALTY_MISSION_SWEEP_INTERVAL_MS. Awards are unique per mission, user and
 * period and their credits have a unique reference, so repeated,
 * concurrent or resumed processing never grants twice.
 */
@Injectable()
export class LoyaltyMissionProgressService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: CreditWalletService,
    private readonly logger: CustomLoggerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const enabled =
      process.env.NODE_ENV !== 'test' ||
      process.env.LOYALTY_MISSION_SWEEP_ENABLED === 'true';
    if (!enabled) return;
    await this.sweep();
    const configured = Number(process.env.LOYALTY_MISSION_SWEEP_INTERVAL_MS);
    const interval =
      Number.isFinite(configured) && configured >= MIN_INTERVAL_MS
        ? configured
        : DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => void this.sweep(), interval);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Evaluates the missions for one completion, once. Returns the ids of the
   * awards made now.
   */
  async processCompletion(sessionId: string): Promise<string[]> {
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.makeupCompletion.findUnique({
        where: { sessionId },
      });
      if (!found || found.processedAt) return [];
      await tx.$queryRaw`
        SELECT 1 AS locked
        FROM (SELECT pg_advisory_xact_lock(
          hashtextextended(${MISSION_LOCK + found.authId}, 0)
        )) AS lock
      `;
      const [locked] = await tx.$queryRaw<{ processedAt: Date | null }[]>`
        SELECT "processedAt" FROM "MakeupCompletion"
        WHERE "sessionId" = ${sessionId} FOR UPDATE
      `;
      if (!locked || locked.processedAt) return [];
      const now = new Date();
      const { authId, completedAt } = found;

      // Missions stay as read (no deactivation in between) until commit.
      const ids = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "LoyaltyMission"
        WHERE "active" AND "startsAt" <= ${completedAt}
        ORDER BY "id" FOR SHARE
      `;
      const missions = await tx.loyaltyMission.findMany({
        where: { id: { in: ids.map((row) => row.id) } },
        orderBy: { createdAt: 'asc' },
      });
      const awarded: string[] = [];
      for (const mission of missions) {
        const period = missionPeriod(
          mission.recurrence,
          completedAt,
          mission.startsAt,
        );
        const window = countingWindow(period, mission.startsAt);
        const completions = await tx.makeupCompletion.count({
          where: {
            authId,
            completedAt: {
              gte: window.from,
              ...(window.to ? { lt: window.to } : {}),
            },
          },
        });
        if (completions < mission.requiredCompletions) continue;
        const id = randomUUID();
        const { count } = await tx.loyaltyMissionAward.createMany({
          data: [
            {
              id,
              missionId: mission.id,
              authId,
              periodKey: period.key,
              periodStart: period.start,
              periodEnd: period.end,
              requiredCompletions: mission.requiredCompletions,
              rewardCredits: mission.rewardCredits,
              awardedAt: now,
            },
          ],
          skipDuplicates: true,
        });
        if (count === 0) continue;
        await this.wallet.grant(
          {
            authId,
            source: CreditSource.MISSION_REWARD,
            sourceReference: missionRewardReference(id),
            amount: String(mission.rewardCredits),
            description: `Loyalty mission: ${mission.title}`,
          },
          { tx, at: now },
        );
        awarded.push(id);
      }
      await tx.makeupCompletion.update({
        where: { sessionId },
        data: { processedAt: now },
      });
      return awarded;
    });
  }

  /**
   * Called right after a verified completion commits. Never fails the
   * completion: if the evaluation fails, the completion stays unprocessed
   * and the sweep evaluates it later.
   */
  async afterCompletion(sessionId: string): Promise<void> {
    try {
      await this.processCompletion(sessionId);
    } catch (error) {
      this.logger.logWithMetadata(
        'warn',
        'Loyalty mission evaluation failed; the sweep retries it',
        {
          context: LOG_CONTEXT,
          sessionId,
          error: error instanceof Error ? error.name : 'unknown',
        },
      );
    }
  }

  /**
   * Evaluates every completion not processed yet (interrupted processing);
   * returns how many were processed.
   */
  processPending(): Promise<number> {
    this.running ??= this.runPending().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runPending(): Promise<number> {
    let processed = 0;
    for (;;) {
      const pending = await this.prisma.makeupCompletion.findMany({
        where: { processedAt: null },
        orderBy: { completedAt: 'asc' },
        take: BATCH,
        select: { sessionId: true },
      });
      let progressed = false;
      for (const { sessionId } of pending) {
        try {
          await this.processCompletion(sessionId);
          processed += 1;
          progressed = true;
        } catch (error) {
          this.logger.logWithMetadata(
            'warn',
            'Loyalty mission evaluation failed; it is retried',
            {
              context: LOG_CONTEXT,
              sessionId,
              error: error instanceof Error ? error.name : 'unknown',
            },
          );
        }
      }
      if (pending.length < BATCH || !progressed) return processed;
    }
  }

  private async sweep(): Promise<void> {
    try {
      await this.processPending();
    } catch (error) {
      this.logger.logWithMetadata('warn', 'Loyalty mission sweep failed', {
        context: LOG_CONTEXT,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}
