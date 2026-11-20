import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import { MfaRepository } from '../mfa/mfa.repository';
import { AuthChallengeRepository } from './auth-challenge.repository';
import { OAuthStateRepository } from './oauth-state.repository';
import { RefreshSessionRepository } from './refresh-session.repository';

export const AUTH_STATE_CLEANUP_INTERVAL_MS = 60 * 60_000;

/**
 * Removes expired authentication state (refresh sessions, one-time codes,
 * OAuth states, expired MFA enrollment secrets, step-up approvals) every
 * hour. Expired rows never authenticate anything; the
 * sweep only keeps the tables small.
 */
@Injectable()
export class AuthStateCleanupService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly sessions: RefreshSessionRepository,
    private readonly challenges: AuthChallengeRepository,
    private readonly oauthStates: OAuthStateRepository,
    private readonly mfaEnrollments: MfaRepository,
    private readonly config: ConfigService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('NODE_ENV') === 'test') return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, AUTH_STATE_CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async sweep(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sessions.deleteExpired(now);
      await this.sessions.deleteExpiredStepUpApprovals(now);
      await this.challenges.deleteExpired(now);
      await this.oauthStates.deleteExpired(now);
      await this.mfaEnrollments.deleteExpired(now);
    } catch (error) {
      this.logger.warn('Expired authentication state could not be removed', {
        context: 'AuthStateCleanup',
        errorName: error instanceof Error ? error.name : typeof error,
      });
    } finally {
      this.running = false;
    }
  }
}
