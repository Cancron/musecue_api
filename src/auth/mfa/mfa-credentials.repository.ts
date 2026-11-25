import { Injectable } from '@nestjs/common';
import type { mfaMethod, Prisma, userStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/services/prisma.service';
import type { FailureCounter } from './mfa-enrollment.policy';

/** What verifying MFA for an account needs (the secret stays encrypted). */
export interface MfaCredentials {
  authId: string;
  status: userStatus;
  mfaEnabled: boolean;
  mfaMethod: mfaMethod | null;
  /** Encrypted authenticator secret (slot `active`). */
  encryptedSecret: string | null;
  /** Last accepted TOTP time step. */
  lastUsedStep: number | null;
  /** Failed verification counter. */
  counter: FailureCounter;
}

export interface RecoveryCodeSummary {
  /** Codes of the current set that were not used yet. */
  remaining: number;
  /** When the current set was issued (null: none). */
  generatedAt: Date | null;
}

/** An account's MFA credentials, read and changed under the user's row lock. */
export interface LockedMfaCredentials {
  readonly credentials: MfaCredentials;
  readonly tx: Prisma.TransactionClient;
  /** Records `step` as used; false if it (or a later step) already was. */
  acceptTotpStep(step: number): Promise<boolean>;
  /** Marks the unused, current code with this hash as used; false if there is none. */
  consumeRecoveryCode(codeHash: string, now: Date): Promise<boolean>;
  saveCounter(counter: FailureCounter): Promise<void>;
  /** Invalidates every earlier code and stores a new set. */
  replaceRecoveryCodes(codeHashes: string[], now: Date): Promise<void>;
  recoverySummary(): Promise<RecoveryCodeSummary>;
}

interface LockedUserRow {
  id: string;
  status: userStatus;
}

/**
 * Locks the user's row for the rest of the transaction (FOR NO KEY UPDATE:
 * serializes the MFA changes of one user - enrollment, verification,
 * recovery codes - without blocking rows that merely reference the user).
 */
export async function lockMfaUser(
  tx: Prisma.TransactionClient,
  authId: string,
): Promise<LockedUserRow | null> {
  const rows = await tx.$queryRaw<LockedUserRow[]>`
    SELECT "id", "status" FROM "authUser"
    WHERE "id" = ${authId}
    FOR NO KEY UPDATE
  `;
  return rows[0] ?? null;
}

/** Stores a new set of recovery-code hashes (one batch), created at `now`. */
export async function insertRecoveryCodes(
  tx: Prisma.TransactionClient,
  authId: string,
  codeHashes: string[],
  now: Date,
): Promise<void> {
  const batchId = randomUUID();
  await tx.mfaRecoveryCode.createMany({
    data: codeHashes.map((codeHash) => ({
      authId,
      batchId,
      codeHash,
      createdAt: now,
    })),
  });
}

const usable = (authId: string) => ({
  authId,
  usedAt: null,
  invalidatedAt: null,
});

async function recoverySummary(
  client: Prisma.TransactionClient | PrismaService,
  authId: string,
): Promise<RecoveryCodeSummary> {
  const remaining = await client.mfaRecoveryCode.count({
    where: usable(authId),
  });
  const current = await client.mfaRecoveryCode.findFirst({
    where: { authId, invalidatedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return { remaining, generatedAt: current?.createdAt ?? null };
}

const SECURITY_SELECT = {
  mfaEnabled: true,
  mfaMethod: true,
  mfaSecret: true,
  mfaLastUsedStep: true,
  mfaFailedAttempts: true,
  mfaFailureWindowStartedAt: true,
  mfaBlockedUntil: true,
} as const;

/**
 * Confirmed MFA credentials in PostgreSQL: the encrypted authenticator
 * secret, recovery-code hashes and the failed-verification counter. A
 * recovery code is consumed by one conditional UPDATE (`usedAt IS NULL AND
 * invalidatedAt IS NULL`), under the user's row lock, so of concurrent
 * requests presenting the same code exactly one succeeds.
 */
@Injectable()
export class MfaCredentialsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The counter and recovery-code summary without locking (status reads). */
  async summary(
    authId: string,
  ): Promise<{ counter: FailureCounter; recovery: RecoveryCodeSummary }> {
    const security = await this.prisma.authSecurity.findUnique({
      where: { authId },
      select: SECURITY_SELECT,
    });
    return {
      counter: toCounter(security),
      recovery: await recoverySummary(this.prisma, authId),
    };
  }

  /**
   * Runs `work` with the account's credentials under the user's row lock;
   * everything it writes commits together. Null when the user does not exist.
   */
  async withLockedCredentials<T>(
    authId: string,
    work: (locked: LockedMfaCredentials) => Promise<T>,
  ): Promise<{ result: T } | null> {
    return this.prisma.$transaction(async (tx) => {
      const user = await lockMfaUser(tx, authId);
      if (!user) return null;
      const security = await tx.authSecurity.findUnique({
        where: { authId },
        select: SECURITY_SELECT,
      });
      const locked: LockedMfaCredentials = {
        credentials: {
          authId,
          status: user.status,
          mfaEnabled: security?.mfaEnabled ?? false,
          mfaMethod: security?.mfaMethod ?? null,
          encryptedSecret: security?.mfaSecret ?? null,
          lastUsedStep: security?.mfaLastUsedStep ?? null,
          counter: toCounter(security),
        },
        tx,
        acceptTotpStep: async (step) => {
          const { count } = await tx.authSecurity.updateMany({
            where: {
              authId,
              OR: [
                { mfaLastUsedStep: null },
                { mfaLastUsedStep: { lt: step } },
              ],
            },
            data: { mfaLastUsedStep: step },
          });
          return count === 1;
        },
        consumeRecoveryCode: async (codeHash, now) => {
          const { count } = await tx.mfaRecoveryCode.updateMany({
            where: { ...usable(authId), codeHash },
            data: { usedAt: now },
          });
          return count === 1;
        },
        saveCounter: async (counter) => {
          await tx.authSecurity.update({
            where: { authId },
            data: {
              mfaFailedAttempts: counter.failedAttempts,
              mfaFailureWindowStartedAt: counter.failureWindowStartedAt,
              mfaBlockedUntil: counter.blockedUntil,
            },
          });
        },
        replaceRecoveryCodes: async (codeHashes, now) => {
          await tx.mfaRecoveryCode.updateMany({
            where: { authId, invalidatedAt: null },
            data: { invalidatedAt: now },
          });
          await insertRecoveryCodes(tx, authId, codeHashes, now);
        },
        recoverySummary: () => recoverySummary(tx, authId),
      };
      return { result: await work(locked) };
    });
  }

  /** Removes codes that were replaced before `before`. */
  async deleteInvalidatedBefore(before: Date): Promise<number> {
    const { count } = await this.prisma.mfaRecoveryCode.deleteMany({
      where: { invalidatedAt: { lt: before } },
    });
    return count;
  }
}

function toCounter(
  security: {
    mfaFailedAttempts: number;
    mfaFailureWindowStartedAt: Date | null;
    mfaBlockedUntil: Date | null;
  } | null,
): FailureCounter {
  return {
    failedAttempts: security?.mfaFailedAttempts ?? 0,
    failureWindowStartedAt: security?.mfaFailureWindowStartedAt ?? null,
    blockedUntil: security?.mfaBlockedUntil ?? null,
  };
}
