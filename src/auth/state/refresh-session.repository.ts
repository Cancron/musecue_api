import { Injectable } from '@nestjs/common';
import type { Prisma, RefreshSessionRevocation } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';

/** Another login of the same user holds the login lock. */
export class LoginInProgressError extends Error {
  constructor() {
    super('Another login is in progress');
    this.name = 'LoginInProgressError';
  }
}

export interface NewRefreshSession {
  authId: string;
  /** The refresh token's JWT ID. */
  tokenId: string;
  /** SHA-256 (hex) of the refresh token. */
  tokenHash: string;
  ipAddress?: string;
  userAgent?: string;
  device?: string;
  expiresAt: Date;
  /**
   * The sign-in session (access tokens' `sid`). Set at sign-in; a rotation
   * always keeps the presented session's value.
   */
  familyId?: string;
  /** The sign-in proved MFA (MFA challenge), and how. */
  mfaVerifiedAt?: Date;
  mfaVerifiedWith?: 'totp' | 'recovery_code';
}

/** An active sign-in session (never its tokens or their hashes). */
export interface ActiveSession {
  /** The session ID (RefreshSession.familyId, the access tokens' `sid`). */
  id: string;
  signedInAt: Date;
  /** The last sign-in or token refresh. */
  lastActiveAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  device: string | null;
  mfaVerifiedAt: Date | null;
}

export interface StoredRefreshSession {
  id: string;
  authId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** 64-bit advisory lock keys, namespaced by purpose and user. */
const LOGIN_LOCK = 'musecue:login:';
const SESSIONS_LOCK = 'musecue:refresh-sessions:';

/**
 * Refresh sessions in PostgreSQL (both infrastructure modes).
 *
 * Writes that change a user's set of sessions (login, rotation, revocation of
 * all sessions) hold a per-user transaction-level advisory lock, so the device
 * limit is enforced exactly even when logins and refreshes race. Logins also
 * take a non-blocking per-user login lock: a concurrent login of the same
 * user fails fast instead of waiting (LoginInProgressError).
 */
@Injectable()
export class RefreshSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stores a new login's session and revokes the oldest active sessions
   * beyond `maxDevices`, in one transaction. With `client` (an open
   * transaction, e.g. the MFA step of sign-in) everything happens inside
   * it, so the session commits or rolls back together with the caller's
   * writes.
   */
  async createForLogin(
    session: NewRefreshSession,
    maxDevices: number,
    now: Date = new Date(),
    client?: Prisma.TransactionClient,
    /**
     * Runs under the sessions lock before the session is stored (for
     * example to confirm the sign-in's MFA decision still holds); throwing
     * stores nothing.
     */
    confirm?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    const work = async (tx: Prisma.TransactionClient) => {
      const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(
          hashtextextended(${LOGIN_LOCK + session.authId}, 0)
        ) AS acquired
      `;
      if (!lock?.acquired) throw new LoginInProgressError();
      await this.lockSessions(tx, session.authId);
      await confirm?.(tx);
      await tx.refreshSession.create({
        data: { ...session, createdAt: now },
      });
      await this.enforceDeviceLimit(tx, session.authId, maxDevices, now);
    };
    if (client) await work(client);
    else await this.prisma.$transaction(work);
  }

  find(tokenId: string): Promise<StoredRefreshSession | null> {
    return this.prisma.refreshSession.findUnique({
      where: { tokenId },
      select: {
        id: true,
        authId: true,
        familyId: true,
        tokenHash: true,
        expiresAt: true,
        revokedAt: true,
      },
    });
  }

  /**
   * Whether the sign-in session `familyId` of the user is still active: one
   * of its tokens is neither revoked nor expired (logout, logout-all and
   * security events end it).
   */
  async isSessionActive(
    authId: string,
    familyId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const active = await this.prisma.refreshSession.count({
      where: { authId, familyId, revokedAt: null, expiresAt: { gt: now } },
    });
    return active > 0;
  }

  /**
   * Rotates a refresh token: revokes the presented session (ROTATED) and
   * stores its replacement, in one transaction. Only an active session whose
   * hash matches can rotate, and only once: of concurrent requests presenting
   * the same token exactly one succeeds. Returns false otherwise.
   */
  async rotate(
    current: { authId: string; tokenId: string; tokenHash: string },
    next: NewRefreshSession,
    now: Date = new Date(),
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockSessions(tx, current.authId);
      const session = await tx.refreshSession.findUnique({
        where: { tokenId: current.tokenId },
        select: {
          id: true,
          authId: true,
          tokenHash: true,
          familyId: true,
          mfaVerifiedAt: true,
          mfaVerifiedWith: true,
        },
      });
      if (
        !session ||
        session.authId !== current.authId ||
        session.tokenHash !== current.tokenHash
      ) {
        return false;
      }
      // Conditional on the row still being active: a concurrent rotation
      // that committed first makes this match nothing.
      const revoked = await tx.refreshSession.updateMany({
        where: { id: session.id, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now, revokedReason: 'ROTATED' },
      });
      if (revoked.count !== 1) return false;
      await tx.refreshSession.create({
        data: {
          ...next,
          // Same sign-in session (and its MFA proof), whatever the caller
          // passed.
          familyId: session.familyId,
          mfaVerifiedAt: session.mfaVerifiedAt,
          mfaVerifiedWith: session.mfaVerifiedWith,
          rotatedFromId: session.id,
          createdAt: now,
        },
      });
      return true;
    });
  }

  /** Revokes one session of a user (logout). */
  async revoke(
    authId: string,
    tokenId: string,
    reason: RefreshSessionRevocation,
    now: Date = new Date(),
  ): Promise<void> {
    await this.prisma.refreshSession.updateMany({
      where: { authId, tokenId, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason },
    });
  }

  /** Revokes every session of a user. Throws when the database is unavailable. */
  async revokeAll(
    authId: string,
    reason: RefreshSessionRevocation,
    now: Date = new Date(),
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockSessions(tx, authId);
      const { count } = await tx.refreshSession.updateMany({
        where: { authId, revokedAt: null },
        data: { revokedAt: now, revokedReason: reason },
      });
      return count;
    });
  }

  /**
   * Removes step-up approvals that expired before `before` (cleanup sweep;
   * they never authorize anything once expired).
   */
  async deleteExpiredStepUpApprovals(before: Date): Promise<number> {
    const { count } = await this.prisma.stepUpApproval.deleteMany({
      where: { expiresAt: { lt: before } },
    });
    return count;
  }

  /** The user's active sign-in sessions, most recently active first. */
  async listActive(
    authId: string,
    now: Date = new Date(),
  ): Promise<ActiveSession[]> {
    // A session has exactly one active token row: its latest.
    const active = await this.prisma.refreshSession.findMany({
      where: { authId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        familyId: true,
        createdAt: true,
        expiresAt: true,
        ipAddress: true,
        userAgent: true,
        device: true,
        mfaVerifiedAt: true,
      },
    });
    if (active.length === 0) return [];
    const starts = await this.prisma.refreshSession.groupBy({
      by: ['familyId'],
      where: { authId, familyId: { in: active.map((a) => a.familyId) } },
      _min: { createdAt: true },
    });
    const signedIn = new Map(
      starts.map((s) => [s.familyId, s._min.createdAt as Date]),
    );
    return active.map((row) => ({
      id: row.familyId,
      signedInAt: signedIn.get(row.familyId) ?? row.createdAt,
      lastActiveAt: row.createdAt,
      expiresAt: row.expiresAt,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      device: row.device,
      mfaVerifiedAt: row.mfaVerifiedAt,
    }));
  }

  /**
   * Ends sessions of the user: one (`only`), all but one (`except`) or all.
   * Every active token of those sessions is revoked under the user's
   * sessions lock, so a concurrent refresh cannot keep one alive. Returns
   * the IDs of the sessions that were active. With `client` it runs inside
   * that transaction.
   */
  async revokeSessions(
    authId: string,
    scope: { only?: string; except?: string },
    reason: RefreshSessionRevocation,
    now: Date = new Date(),
    client?: Prisma.TransactionClient,
  ): Promise<string[]> {
    const work = async (tx: Prisma.TransactionClient) => {
      await this.lockSessions(tx, authId);
      const familyFilter =
        scope.only !== undefined
          ? { familyId: scope.only }
          : scope.except !== undefined
            ? { familyId: { not: scope.except } }
            : {};
      const active = await tx.refreshSession.findMany({
        where: {
          authId,
          ...familyFilter,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: { familyId: true },
      });
      await tx.refreshSession.updateMany({
        where: { authId, ...familyFilter, revokedAt: null },
        data: { revokedAt: now, revokedReason: reason },
      });
      return [...new Set(active.map((a) => a.familyId))];
    };
    return client ? work(client) : this.prisma.$transaction(work);
  }

  /** Removes sessions that expired before `before` (cleanup sweep). */
  async deleteExpired(before: Date): Promise<number> {
    const { count } = await this.prisma.refreshSession.deleteMany({
      where: { expiresAt: { lt: before } },
    });
    return count;
  }

  private async lockSessions(
    tx: Prisma.TransactionClient,
    authId: string,
  ): Promise<void> {
    await tx.$queryRaw`
      SELECT 1 AS locked
      FROM (SELECT pg_advisory_xact_lock(
        hashtextextended(${SESSIONS_LOCK + authId}, 0)
      )) AS lock
    `;
  }

  private async enforceDeviceLimit(
    tx: Prisma.TransactionClient,
    authId: string,
    maxDevices: number,
    now: Date,
  ): Promise<void> {
    const surplus = await tx.refreshSession.findMany({
      where: { authId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: Math.max(0, maxDevices),
      select: { id: true },
    });
    if (!surplus.length) return;
    await tx.refreshSession.updateMany({
      where: { id: { in: surplus.map(({ id }) => id) }, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'DEVICE_LIMIT' },
    });
  }
}
