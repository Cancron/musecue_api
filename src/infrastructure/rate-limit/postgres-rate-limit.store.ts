import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import { PrismaService } from '../../common/services/prisma.service';
import {
  keyedHash,
  SECRET_PURPOSES,
} from '../../common/security/derived-secrets';
import {
  RateLimitStore,
  type RateLimitPolicy,
  type RateLimitResult,
} from './rate-limit.store';

/** Expired buckets are removed this often. */
export const RATE_LIMIT_CLEANUP_INTERVAL_MS = 5 * 60_000;
const CLEANUP_BATCH_SIZE = 5_000;

interface BucketRow {
  hits: number;
  windowExpiresAt: Date;
  blockExpiresAt: Date | null;
}

/**
 * PostgreSQL rate-limit counters (REDIS_ENABLED=false).
 *
 * Each hit is one atomic upsert of a fixed-window bucket: the row lock of
 * `INSERT ... ON CONFLICT DO UPDATE` serializes concurrent hits for a key, and
 * every SET expression reads the previous row, so counting, window reset and
 * blocking happen together. A hit exceeding the limit blocks the key for the
 * block duration. Keys are stored as an HMAC (key derived from
 * JWT_REFRESH_SECRET), never as raw IP addresses or emails.
 */
@Injectable()
export class PostgresRateLimitStore
  extends RateLimitStore
  implements OnModuleInit, OnModuleDestroy
{
  /** Clock used for windows (replaceable in tests). */
  clock: () => Date = () => new Date();
  private timer?: ReturnType<typeof setInterval>;
  private cleaning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {
    super();
  }

  onModuleInit(): void {
    if (this.config.get<string>('NODE_ENV') === 'test') return;
    this.timer = setInterval(() => {
      void this.cleanupExpired();
    }, RATE_LIMIT_CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async hit(key: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
    const now = this.clock();
    const keyHash = this.hashKey(key);
    const windowEnd = new Date(now.getTime() + Math.max(1, policy.windowMs));
    const blockEnd = new Date(now.getTime() + Math.max(1, policy.blockMs));
    const firstHitBlock = 1 > policy.limit ? blockEnd : null;
    const rows = await this.prisma.$queryRaw<BucketRow[]>`
      INSERT INTO "RateLimitBucket" AS b
        ("keyHash", "hits", "windowExpiresAt", "blockExpiresAt", "updatedAt")
      VALUES (${keyHash}, 1, ${windowEnd}, ${firstHitBlock}, ${now})
      ON CONFLICT ("keyHash") DO UPDATE SET
        "hits" = CASE
          WHEN b."windowExpiresAt" <= ${now} THEN 1
          ELSE b."hits" + 1
        END,
        "windowExpiresAt" = CASE
          WHEN b."windowExpiresAt" <= ${now} THEN ${windowEnd}
          ELSE b."windowExpiresAt"
        END,
        "blockExpiresAt" = CASE
          WHEN b."blockExpiresAt" > ${now} THEN b."blockExpiresAt"
          WHEN (CASE WHEN b."windowExpiresAt" <= ${now} THEN 1 ELSE b."hits" + 1 END)
            > ${policy.limit} THEN ${blockEnd}
          ELSE NULL
        END,
        "updatedAt" = ${now}
      RETURNING "hits", "windowExpiresAt", "blockExpiresAt"
    `;
    const row = rows[0];
    if (!row) throw new Error('The rate-limit bucket was not written');
    const blockRemaining = row.blockExpiresAt
      ? row.blockExpiresAt.getTime() - now.getTime()
      : 0;
    const blocked = blockRemaining > 0;
    return {
      totalHits: Number(row.hits),
      windowExpiresInMs: Math.max(
        0,
        row.windowExpiresAt.getTime() - now.getTime(),
      ),
      blocked,
      blockExpiresInMs: blocked ? blockRemaining : 0,
    };
  }

  async reset(key: string): Promise<void> {
    await this.prisma.rateLimitBucket.deleteMany({
      where: { keyHash: this.hashKey(key) },
    });
  }

  /** Deletes buckets whose window and block have both ended. */
  async cleanupExpired(now: Date = this.clock()): Promise<number> {
    if (this.cleaning) return 0;
    this.cleaning = true;
    try {
      let removed = 0;
      for (;;) {
        const deleted = await this.prisma.$executeRaw`
          DELETE FROM "RateLimitBucket"
          WHERE "keyHash" IN (
            SELECT "keyHash" FROM "RateLimitBucket"
            WHERE "windowExpiresAt" <= ${now}
              AND ("blockExpiresAt" IS NULL OR "blockExpiresAt" <= ${now})
            LIMIT ${CLEANUP_BATCH_SIZE}
          )
        `;
        removed += deleted;
        if (deleted < CLEANUP_BATCH_SIZE) return removed;
      }
    } catch (error) {
      this.logger.warn('Expired rate-limit buckets could not be removed', {
        context: 'PostgresRateLimitStore',
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return 0;
    } finally {
      this.cleaning = false;
    }
  }

  private hashKey(key: string): string {
    return keyedHash(SECRET_PURPOSES.RATE_LIMIT_KEY, key);
  }
}
