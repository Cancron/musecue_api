import { Injectable } from '@nestjs/common';
import type { mfaMethod, Prisma, userStatus } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { MFA_ENROLLMENT } from './mfa.constants';

/** The account data MFA decisions need. */
export interface MfaAccount {
  authId: string;
  email: string;
  status: userStatus;
  mfaEnabled: boolean;
  mfaMethod: mfaMethod | null;
  mfaEnabledAt: Date | null;
}

/**
 * A user's enrollment row: the pending secret (encrypted) and the failed-code
 * counter. A user without a row has EMPTY_ENROLLMENT.
 */
export interface MfaEnrollmentState {
  /** Encrypted pending secret (slot `enrollment`), or null. */
  secret: string | null;
  expiresAt: Date | null;
  failedAttempts: number;
  failureWindowStartedAt: Date | null;
  blockedUntil: Date | null;
}

export const EMPTY_ENROLLMENT: Readonly<MfaEnrollmentState> = Object.freeze({
  secret: null,
  expiresAt: null,
  failedAttempts: 0,
  failureWindowStartedAt: null,
  blockedUntil: null,
});

export interface MfaActivation {
  /** Encrypted secret (slot `active`). */
  encryptedSecret: string;
  method: mfaMethod;
  /** The time step of the code that confirmed it (never accepted again). */
  lastUsedStep: number;
  enabledAt: Date;
}

/** A user's MFA state, read and written under the user's row lock. */
export interface LockedMfaAccount {
  readonly account: MfaAccount;
  readonly enrollment: MfaEnrollmentState;
  /** The transaction, for writes that must commit together (audit log). */
  readonly tx: Prisma.TransactionClient;
  saveEnrollment(state: MfaEnrollmentState): Promise<void>;
  /** Stores the confirmed secret, enables MFA and removes the enrollment. */
  activate(activation: MfaActivation): Promise<void>;
}

interface LockedUserRow {
  id: string;
  email: string;
  status: userStatus;
}

const ENROLLMENT_SELECT = {
  secret: true,
  expiresAt: true,
  failedAttempts: true,
  failureWindowStartedAt: true,
  blockedUntil: true,
} as const;

const SECURITY_SELECT = {
  mfaEnabled: true,
  mfaMethod: true,
  mfaEnabledAt: true,
} as const;

/**
 * MFA enrollment state in PostgreSQL (both infrastructure modes). Every
 * change runs in one transaction holding the user's row lock, so concurrent
 * confirmations and wrong guesses of one user are serialized: a code confirms
 * at most once and no guess escapes the failure counter.
 */
@Injectable()
export class MfaEnrollmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Current state without locking (for status reads); null for an unknown user. */
  async read(
    authId: string,
  ): Promise<{ account: MfaAccount; enrollment: MfaEnrollmentState } | null> {
    const user = await this.prisma.authUser.findUnique({
      where: { id: authId },
      select: {
        id: true,
        email: true,
        status: true,
        authSecurity: { select: SECURITY_SELECT },
        mfaEnrollment: { select: ENROLLMENT_SELECT },
      },
    });
    if (!user) return null;
    return {
      account: toAccount(user, user.authSecurity),
      enrollment: user.mfaEnrollment ?? { ...EMPTY_ENROLLMENT },
    };
  }

  /**
   * Runs `work` with the user's MFA state under a row lock on the user (FOR
   * NO KEY UPDATE: serializes MFA changes of that user without blocking rows
   * that merely reference it). Everything `work` writes commits together;
   * returns null when the user does not exist.
   */
  async withLockedAccount<T>(
    authId: string,
    work: (locked: LockedMfaAccount) => Promise<T>,
  ): Promise<{ result: T } | null> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedUserRow[]>`
        SELECT "id", "email", "status" FROM "authUser"
        WHERE "id" = ${authId}
        FOR NO KEY UPDATE
      `;
      const user = rows[0];
      if (!user) return null;
      const security = await tx.authSecurity.findUnique({
        where: { authId },
        select: SECURITY_SELECT,
      });
      const enrollment = await tx.mfaEnrollment.findUnique({
        where: { authId },
        select: ENROLLMENT_SELECT,
      });
      const locked: LockedMfaAccount = {
        account: toAccount(user, security),
        enrollment: enrollment ?? { ...EMPTY_ENROLLMENT },
        tx,
        saveEnrollment: async (state) => {
          await tx.mfaEnrollment.upsert({
            where: { authId },
            create: { authId, ...state },
            update: state,
          });
        },
        activate: async (activation) => {
          const data = {
            mfaEnabled: true,
            mfaMethod: activation.method,
            mfaSecret: activation.encryptedSecret,
            mfaEnabledAt: activation.enabledAt,
            mfaLastUsedStep: activation.lastUsedStep,
          };
          // Accounts created before authSecurity existed have no row yet.
          await tx.authSecurity.upsert({
            where: { authId },
            create: { authId, ...data },
            update: data,
          });
          await tx.mfaEnrollment.deleteMany({ where: { authId } });
        },
      };
      return { result: await work(locked) };
    });
  }

  /**
   * Removes enrollment rows that no longer matter: no pending secret left
   * (or it expired before `now`), no active block and no failure window
   * still counting.
   */
  async deleteStale(now: Date): Promise<number> {
    const windowStart = new Date(
      now.getTime() - MFA_ENROLLMENT.FAILURE_WINDOW_MS,
    );
    const { count } = await this.prisma.mfaEnrollment.deleteMany({
      where: {
        OR: [{ expiresAt: null }, { expiresAt: { lt: now } }],
        AND: [
          { OR: [{ blockedUntil: null }, { blockedUntil: { lt: now } }] },
          {
            OR: [
              { failureWindowStartedAt: null },
              { failureWindowStartedAt: { lt: windowStart } },
            ],
          },
        ],
      },
    });
    return count;
  }
}

function toAccount(
  user: LockedUserRow,
  security: {
    mfaEnabled: boolean;
    mfaMethod: mfaMethod | null;
    mfaEnabledAt: Date | null;
  } | null,
): MfaAccount {
  return {
    authId: user.id,
    email: user.email,
    status: user.status,
    mfaEnabled: security?.mfaEnabled ?? false,
    mfaMethod: security?.mfaMethod ?? null,
    mfaEnabledAt: security?.mfaEnabledAt ?? null,
  };
}
