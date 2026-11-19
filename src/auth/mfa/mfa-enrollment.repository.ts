import { Injectable } from '@nestjs/common';
import type { mfaMethod, Prisma, userStatus } from '@prisma/client';
import {
  ActivityLogService,
  type ActivityLogMetadata,
} from '../../common/services/activity-log.service';
import { PrismaService } from '../../common/services/prisma.service';
import { MFA_AUDIT_FIELDS, MFA_ENROLLMENT } from './mfa.constants';

/** The account fields MFA decisions depend on. */
export interface MfaAccountState {
  email: string;
  status: userStatus;
  mfaEnabled: boolean;
  mfaMethod: mfaMethod | null;
}

/** A stored enrollment; `secret` is the encrypted pending TOTP secret. */
export interface MfaEnrollmentState {
  secret: string | null;
  expiresAt: Date | null;
  failedAttemptsAt: Date[];
  blockedUntil: Date | null;
}

/** Reads and writes of one user's MFA state inside a locked transaction. */
export interface MfaUnitOfWork {
  account(): Promise<MfaAccountState | null>;
  enrollment(): Promise<MfaEnrollmentState | null>;
  /** Creates or replaces the user's enrollment row. */
  saveEnrollment(state: MfaEnrollmentState): Promise<void>;
  deleteEnrollment(): Promise<void>;
  /**
   * Turns MFA on with the confirmed (encrypted) secret, records the step of
   * the accepted code, and writes the audit entry.
   */
  enableMfa(input: {
    encryptedSecret: string;
    usedStep: number;
    metadata: ActivityLogMetadata;
  }): Promise<void>;
}

const LOCK_NAMESPACE = 'musecue:mfa-enrollment:';

/**
 * PostgreSQL persistence of MFA enrollment (both infrastructure modes).
 * Every change of a user's MFA state runs in one transaction holding a
 * per-user advisory lock, so concurrent starts and confirmations of the same
 * user are serialized: a code is accepted at most once, and every incorrect
 * code is counted.
 */
@Injectable()
export class MfaEnrollmentRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLog: ActivityLogService,
  ) {}

  /** Unlocked read for the status endpoint. */
  async read(authId: string): Promise<{
    account: MfaAccountState | null;
    enrollment: MfaEnrollmentState | null;
  }> {
    const [account, enrollment] = await Promise.all([
      this.readAccount(this.prisma, authId),
      this.readEnrollment(this.prisma, authId),
    ]);
    return { account, enrollment };
  }

  /**
   * Runs `work` in a transaction that holds the user's MFA lock. Everything
   * `work` writes commits together, including the failure count of an
   * incorrect code (so return, rather than throw, outcomes that must be
   * kept).
   */
  async withLock<T>(
    authId: string,
    work: (uow: MfaUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT 1 AS locked
        FROM (SELECT pg_advisory_xact_lock(
          hashtextextended(${LOCK_NAMESPACE + authId}, 0)
        )) AS lock
      `;
      return work(this.unitOfWork(tx, authId));
    });
  }

  /**
   * Cleanup sweep: forgets pending secrets whose enrollment expired, then
   * removes rows that no longer hold anything (no pending secret, no active
   * block, no failure inside the 15-minute window).
   */
  async deleteExpired(now: Date): Promise<number> {
    await this.prisma.mfaEnrollment.updateMany({
      where: { expiresAt: { lte: now } },
      data: { secret: null, expiresAt: null },
    });
    const windowStart = new Date(
      now.getTime() - MFA_ENROLLMENT.FAILURE_WINDOW_MS,
    );
    return this.prisma.$executeRaw`
      DELETE FROM "MfaEnrollment"
      WHERE "secret" IS NULL
        AND ("blockedUntil" IS NULL OR "blockedUntil" <= ${now})
        AND NOT EXISTS (
          SELECT 1 FROM unnest("failedAttemptsAt") AS failed("at")
          WHERE failed."at" > ${windowStart}
        )
    `;
  }

  private unitOfWork(
    tx: Prisma.TransactionClient,
    authId: string,
  ): MfaUnitOfWork {
    return {
      account: () => this.readAccount(tx, authId),
      enrollment: () => this.readEnrollment(tx, authId),
      saveEnrollment: async (state) => {
        await tx.mfaEnrollment.upsert({
          where: { authId },
          create: { authId, ...state },
          update: state,
        });
      },
      deleteEnrollment: async () => {
        await tx.mfaEnrollment.deleteMany({ where: { authId } });
      },
      enableMfa: async ({ encryptedSecret, usedStep, metadata }) => {
        const data = {
          mfaEnabled: true,
          mfaMethod: 'totp' as const,
          mfaSecret: encryptedSecret,
          mfaLastUsedStep: usedStep,
        };
        // Accounts created before authSecurity rows existed get one now.
        await tx.authSecurity.upsert({
          where: { authId },
          create: { authId, ...data },
          update: data,
        });
        // About the account itself, so account erasure removes it. Never
        // includes the secret.
        await this.activityLog.logActivity(
          {
            tableName: 'authUser',
            recordId: authId,
            action: 'update',
            eventType: 'update',
            changes: [
              {
                fieldName: MFA_AUDIT_FIELDS.ENABLED,
                oldValue: 'false',
                newValue: 'true',
              },
              {
                fieldName: MFA_AUDIT_FIELDS.METHOD,
                oldValue: null,
                newValue: 'totp',
              },
            ],
            metadata,
          },
          tx,
        );
      },
    };
  }

  private async readAccount(
    client: Prisma.TransactionClient | PrismaService,
    authId: string,
  ): Promise<MfaAccountState | null> {
    const user = await client.authUser.findUnique({
      where: { id: authId },
      select: {
        email: true,
        status: true,
        authSecurity: { select: { mfaEnabled: true, mfaMethod: true } },
      },
    });
    if (!user) return null;
    return {
      email: user.email,
      status: user.status,
      mfaEnabled: user.authSecurity?.mfaEnabled ?? false,
      mfaMethod: user.authSecurity?.mfaMethod ?? null,
    };
  }

  private readEnrollment(
    client: Prisma.TransactionClient | PrismaService,
    authId: string,
  ): Promise<MfaEnrollmentState | null> {
    return client.mfaEnrollment.findUnique({
      where: { authId },
      select: {
        secret: true,
        expiresAt: true,
        failedAttemptsAt: true,
        blockedUntil: true,
      },
    });
  }
}
