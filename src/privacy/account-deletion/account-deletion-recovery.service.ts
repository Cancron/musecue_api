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
import { AccountErasureService } from './account-erasure.service';

const SWEEP_INTERVAL_MS = 30_000;
const BATCH_SIZE = 100;
/**
 * Token version cached for an account whose record no longer exists. Access
 * tokens always carry a version of at least 1, so none matches.
 */
const NO_VALID_TOKEN_VERSION = 0;

export interface DeletionSweepResult {
  /** Requests whose pending session revocation succeeded. */
  sessionsRevoked: number;
  /** Requests fully erased and completed in this pass. */
  completed: number;
  /** Requests that still have a pending step (retried next pass). */
  pending: number;
}

/**
 * Drives accepted account deletions to completion, independent of any user
 * request (the account is signed out). Runs at startup, to resume work
 * interrupted by a crash or restart, and every 30 seconds:
 * 1. completes session revocation that failed when a request was accepted;
 * 2. erases every open request whose processing lease is free or expired
 *    (AccountErasureService), resuming from its last completed step.
 * Every step is idempotent and recorded in the database.
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
    private readonly erasure: AccountErasureService,
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

  async resume(now: Date = new Date()): Promise<DeletionSweepResult> {
    const result: DeletionSweepResult = {
      sessionsRevoked: 0,
      completed: 0,
      pending: 0,
    };
    if (this.running) return result;
    this.running = true;
    try {
      result.sessionsRevoked = await this.resumeRevocations();
      await this.eraseDueRequests(now, result);
    } finally {
      this.running = false;
    }
    return result;
  }

  private async eraseDueRequests(
    now: Date,
    result: DeletionSweepResult,
  ): Promise<void> {
    try {
      let after: string | undefined;
      for (;;) {
        const due = await this.prisma.accountDeletionRequest.findMany({
          where: {
            status: { in: ['PENDING', 'PROCESSING'] },
            OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
            ...(after ? { id: { gt: after } } : {}),
          },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: BATCH_SIZE,
        });
        for (const request of due) {
          const outcome = await this.erasure.process(request.id, now);
          if (outcome === 'COMPLETED') result.completed += 1;
          if (outcome === 'PENDING') result.pending += 1;
        }
        if (due.length < BATCH_SIZE) break;
        after = due[due.length - 1].id;
      }
    } catch {
      this.logger.warn(
        'Account erasure could not complete this pass; it will retry',
        { context: 'AccountDeletionRecovery' },
      );
    }
  }

  /** Returns how many requests had their sessions revoked. */
  private async resumeRevocations(): Promise<number> {
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
    }
    return revoked;
  }
}
