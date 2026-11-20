import { Inject, Injectable } from '@nestjs/common';
import type { RefreshSessionRevocation } from '@prisma/client';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import AppError from '../../common/errors/app.error';
import { PrismaService } from '../../common/services/prisma.service';
import { TokenVersionCache } from '../../infrastructure/token-version/token-version.cache';
import type { IAccessTokenPayload } from '../interfaces/auth.interface';
import {
  SecurityEventLog,
  type SecurityEventContext,
} from '../security-events/security-event.log';
import {
  RefreshSessionRepository,
  type ActiveSession,
} from '../state/refresh-session.repository';

type Principal = Pick<IAccessTokenPayload, 'userId' | 'sid'>;

export interface SessionView extends ActiveSession {
  /** The session making this request. */
  current: boolean;
}

export interface RevocationView {
  revoked: number;
  sessionIds: string[];
}

const CONTEXT = 'SessionsService';

/**
 * The signed-in user's own sign-in sessions: list them, end one, end all but
 * the current one, or end all. Ending a session revokes its refresh tokens
 * and (through AuthGuard's session check) its access tokens at once; a
 * revoked session can never be refreshed again. Only the token user's
 * sessions are ever visible or affected.
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: RefreshSessionRepository,
    private readonly events: SecurityEventLog,
    private readonly tokenVersions: TokenVersionCache,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async list(principal: Principal): Promise<SessionView[]> {
    const sessions = await this.sessions.listActive(principal.userId);
    return sessions.map((session) => ({
      ...session,
      current: session.id === principal.sid,
    }));
  }

  /** Ends one of the user's sessions (404 for any other or ended one). */
  async revokeOne(
    principal: Principal,
    sessionId: string,
    context: SecurityEventContext,
  ): Promise<RevocationView> {
    const view = await this.revoke(
      principal,
      { only: sessionId },
      'one',
      context,
    );
    if (view.revoked === 0) throw AppError.notFound('Session not found');
    return view;
  }

  /** Ends every session of the user except the one making the request. */
  async revokeOthers(
    principal: Principal,
    context: SecurityEventContext,
  ): Promise<RevocationView> {
    if (!principal.sid) {
      throw AppError.unauthorized(
        'This session cannot be identified. Please sign in again.',
      );
    }
    return this.revoke(principal, { except: principal.sid }, 'others', context);
  }

  /**
   * Ends every session, this one included, and every access token (also
   * tokens issued before sessions were identified: the token version
   * changes).
   */
  async revokeAll(
    principal: Principal,
    context: SecurityEventContext,
    reason: 'all' | 'logout_all' = 'all',
  ): Promise<RevocationView> {
    const view = await this.revoke(
      principal,
      {},
      reason,
      context,
      reason === 'logout_all' ? 'LOGOUT_ALL' : 'USER_REVOKED',
      true,
    );
    return view;
  }

  private async revoke(
    principal: Principal,
    scope: { only?: string; except?: string },
    label: 'one' | 'others' | 'all' | 'logout_all',
    context: SecurityEventContext,
    reason: RefreshSessionRevocation = 'USER_REVOKED',
    bumpTokenVersion = false,
  ): Promise<RevocationView> {
    const now = new Date();
    const { sessionIds, tokenVersion } = await this.prisma.$transaction(
      async (tx) => {
        const ids = await this.sessions.revokeSessions(
          principal.userId,
          scope,
          reason,
          now,
          tx,
        );
        let version: number | null = null;
        if (bumpTokenVersion) {
          ({ tokenVersion: version } = await tx.authUser.update({
            where: { id: principal.userId },
            data: { tokenVersion: { increment: 1 } },
            select: { tokenVersion: true },
          }));
        }
        if (ids.length > 0 || bumpTokenVersion) {
          await this.events.record(tx, {
            authId: principal.userId,
            type: 'SESSION_REVOKED',
            context: { ...context, sessionId: principal.sid ?? null },
            details: {
              scope: label,
              count: ids.length,
              sessionIds: ids,
              includesCurrentSession:
                !!principal.sid && ids.includes(principal.sid),
            },
            now,
          });
        }
        return { sessionIds: ids, tokenVersion: version };
      },
    );
    if (tokenVersion !== null) {
      // Rejects every older access token at once (also with Redis).
      await this.tokenVersions
        .publish(principal.userId, tokenVersion)
        .catch(() => this.tokenVersions.invalidate(principal.userId));
    }
    this.logger.info('Sessions revoked', {
      context: CONTEXT,
      authId: principal.userId,
      scope: label,
      count: sessionIds.length,
    });
    return { revoked: sessionIds.length, sessionIds };
  }
}
