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
import { AccountDeletionService } from './account-deletion.service';

const SWEEP_INTERVAL_MS = 30_000;
const BATCH_SIZE = 100;
/**
 * Token version cached for an account whose record no longer exists. Access
 * tokens always carry a version of at least 1, so none matches.
 */
const NO_VALID_TOKEN_VERSION = 0;

/**
 * Resumes accepted account deletions whose processing was interrupted.
 * Currently this completes session revocation that failed when the request
 * was accepted (for example during a Redis outage). Runs at startup and every
 * 30 seconds; every step is idempotent.
 */
@Injectable()
export class AccountDeletionRecoveryService
  implements OnModuleInit, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly deletions: AccountDeletionService,
    private readonly config: ConfigService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('NODE_ENV') === 'test') return;
    this.timer = setInterval(() => {
      void this.resume();
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
    void this.resume();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Returns how many requests had their sessions revoked in this pass. */
  async resume(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let revoked = 0;
    try {
      let after: string | undefined;
      for (;;) {
        const pending = await this.prisma.accountDeletionRequest.findMany({
          where: {
            status: { in: ['PENDING', 'PROCESSING'] },
            sessionsRevokedAt: null,
            ...(after ? { id: { gt: after } } : {}),
          },
          orderBy: { id: 'asc' },
          take: BATCH_SIZE,
        });
        for (const request of pending) {
          const user = await this.prisma.authUser.findUnique({
            where: { id: request.authId },
            select: { status: true, tokenVersion: true },
          });
          if (user && user.status !== 'PENDING_DELETION') {
            // Never revoke an account that is not pending deletion.
            this.logger.warn(
              'Account deletion request without a blocked account',
              {
                context: 'AccountDeletionRecovery',
                requestId: request.id,
              },
            );
            continue;
          }
          const updated = await this.deletions.revokeSessions(
            request,
            user?.tokenVersion ?? NO_VALID_TOKEN_VERSION,
          );
          if (updated.sessionsRevokedAt) revoked += 1;
        }
        if (pending.length < BATCH_SIZE) break;
        after = pending[pending.length - 1].id;
      }
    } catch {
      this.logger.warn(
        'Account deletion recovery could not complete; it will retry',
        {
          context: 'AccountDeletionRecovery',
        },
      );
    } finally {
      this.running = false;
    }
    return revoked;
  }
}
