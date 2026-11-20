import { Injectable } from '@nestjs/common';
import type {
  mfaMethod,
  Prisma,
  SecurityEventType,
  userStatus,
} from '@prisma/client';
import {
  SecurityEventLog,
  type SecurityEventContext,
  type SecurityEventDetails,
} from '../security-events/security-event.log';
import { RefreshSessionRepository } from '../state/refresh-session.repository';
import {
  ActivityLogService,
  type ActivityLogMetadata,
  type FieldChange,
} from '../../common/services/activity-log.service';
import { PrismaService } from '../../common/services/prisma.service';
import { MFA_AUDIT_FIELDS, MFA_LOCKOUT } from './mfa.constants';
import { MfaSmsStore } from './sms/mfa-sms.store';

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

/** What verifying a second factor needs: the secret and the lockout. */
export interface MfaVerificationState {
  /** The confirmed TOTP secret, encrypted. */
  mfaSecret: string | null;
  mfaLastUsedStep: number | null;
  failedAttemptsAt: Date[];
  blockedUntil: Date | null;
}

export interface StoredRecoveryCode {
  id: string;
  codeHash: string;
}

export interface StoredLoginChallenge {
  id: string;
  authId: string;
  provider: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface TrustedDeviceInput {
  tokenHash: string;
  name: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface TrustedDeviceView {
  id: string;
  name: string;
  ipAddress: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
}

/** Reads and writes of one user's MFA state inside a locked transaction. */
export interface MfaUnitOfWork {
  /**
   * The transaction itself, for writes that must commit or roll back
   * together with the MFA state (e.g. the refresh session of a sign-in).
   */
  readonly tx: Prisma.TransactionClient;
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
  verificationState(): Promise<MfaVerificationState | null>;
  saveVerificationLockout(state: {
    failedAttemptsAt: Date[];
    blockedUntil: Date | null;
  }): Promise<void>;
  /**
   * Records an accepted authenticator code's step; false when that step (or
   * a later one) was already used.
   */
  recordTotpStep(step: number): Promise<boolean>;
  /** The user's unused recovery codes (hashes only). */
  unusedRecoveryCodes(): Promise<StoredRecoveryCode[]>;
  /**
   * Marks one of the user's codes as used; false when it is not (or no
   * longer) an unused code of this user.
   */
  markRecoveryCodeUsed(id: string, now: Date): Promise<boolean>;
  /** Replaces the confirmed secret (re-encryption with the current key). */
  updateMfaSecret(encryptedSecret: string): Promise<void>;
  /** The user's login challenge with this token hash, if any. */
  loginChallenge(tokenHash: string): Promise<StoredLoginChallenge | null>;
  /** Consumes an unexpired, unconsumed challenge; false otherwise. */
  consumeLoginChallenge(id: string, now: Date): Promise<boolean>;
  /**
   * Trusts a device for the user; the oldest active devices beyond
   * `maxActive` are revoked.
   */
  createTrustedDevice(
    input: TrustedDeviceInput,
    maxActive: number,
  ): Promise<{ id: string; revokedIds: string[] }>;
  /** Deletes every recovery code of the user and stores the new hashes. */
  replaceRecoveryCodes(codeHashes: string[]): Promise<void>;
  /** Unused recovery codes left. */
  countRecoveryCodes(): Promise<number>;
  /**
   * Turns MFA off: clears the secret, method, replay step and lockout, and
   * deletes the recovery codes, any pending enrollment or replacement and
   * open sign-in challenges; SMS numbers are revoked and their codes
   * invalidated.
   */
  disableMfa(): Promise<void>;
  /**
   * Replaces the confirmed secret with a newly confirmed one (the old
   * authenticator stops working) and records the new code's step.
   */
  replaceMfaSecret(input: {
    encryptedSecret: string;
    usedStep: number;
  }): Promise<void>;
  /** Revokes every trusted device of the user; returns how many. */
  revokeTrustedDevices(now: Date): Promise<number>;
  /**
   * Ends every sign-in session of the user except `keepSessionId` (all of
   * them without it), under the sessions lock; returns their IDs. Their
   * step-up approvals and open sign-in challenges are removed too.
   */
  revokeOtherSessions(
    keepSessionId: string | undefined,
    now: Date,
  ): Promise<string[]>;
  /** Records that the sign-in session just proved MFA (and how). */
  markSessionMfaVerified(
    sessionId: string,
    method: 'totp' | 'recovery_code',
    now: Date,
  ): Promise<void>;
  /** Adds an entry to the user's security activity history. */
  recordEvent(event: {
    type: SecurityEventType;
    context?: SecurityEventContext;
    details?: SecurityEventDetails;
    now: Date;
  }): Promise<void>;
  audit(changes: FieldChange[], metadata: ActivityLogMetadata): Promise<void>;
}

const LOCK_NAMESPACE = 'musecue:mfa:';

/**
 * PostgreSQL persistence of MFA (both infrastructure modes). Every change of
 * a user's MFA state runs in one transaction holding a per-user advisory
 * lock, so starts, confirmations and verifications of the same user are
 * serialized: a code is accepted at most once, and every incorrect code is
 * counted. Consumption is also atomic on its own (conditional UPDATE).
 */
@Injectable()
export class MfaRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLog: ActivityLogService,
    private readonly sessions: RefreshSessionRepository,
    private readonly events: SecurityEventLog,
  ) {}

  /** Unlocked read for the status endpoint. */
  async read(authId: string): Promise<{
    account: MfaAccountState | null;
    enrollment: MfaEnrollmentState | null;
    recoveryCodesRemaining: number;
  }> {
    const [account, enrollment, recoveryCodesRemaining] = await Promise.all([
      this.readAccount(this.prisma, authId),
      this.readEnrollment(this.prisma, authId),
      this.countUnused(this.prisma, authId),
    ]);
    return { account, enrollment, recoveryCodesRemaining };
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
   * Cleanup sweep: removes expired or consumed login challenges and expired
   * or revoked trusted devices, forgets pending secrets whose enrollment
   * expired, then removes enrollment rows that no longer hold anything (no
   * pending secret, no active block, no failure inside the 15-minute
   * window).
   */
  async deleteExpired(now: Date): Promise<number> {
    await this.prisma.mfaEnrollment.updateMany({
      where: { expiresAt: { lte: now } },
      data: { secret: null, expiresAt: null },
    });
    // Challenges and trusted devices that can no longer be used.
    await this.prisma.mfaLoginChallenge.deleteMany({
      where: {
        OR: [{ expiresAt: { lte: now } }, { consumedAt: { not: null } }],
      },
    });
    await this.prisma.mfaTrustedDevice.deleteMany({
      where: {
        OR: [{ expiresAt: { lte: now } }, { revokedAt: { not: null } }],
      },
    });
    // SMS codes that can no longer be used, revoked numbers, and numbers
    // left unverified for an hour. (The SMS limits are counted on
    // authSecurity, not from these rows.)
    await this.prisma.mfaSmsCode.deleteMany({
      where: {
        OR: [
          { expiresAt: { lte: now } },
          { consumedAt: { not: null } },
          { invalidatedAt: { not: null } },
        ],
      },
    });
    await this.prisma.mfaSmsPhone.deleteMany({
      where: {
        OR: [
          { status: 'REVOKED' },
          {
            status: 'PENDING',
            createdAt: { lte: new Date(now.getTime() - 60 * 60_000) },
          },
        ],
      },
    });
    const windowStart = new Date(now.getTime() - MFA_LOCKOUT.FAILURE_WINDOW_MS);
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

  /** Whether the user has MFA enabled (decides whether sign-in needs it). */
  async mfaEnabled(authId: string): Promise<boolean> {
    const security = await this.prisma.authSecurity.findUnique({
      where: { authId },
      select: { mfaEnabled: true },
    });
    return security?.mfaEnabled ?? false;
  }

  async createLoginChallenge(input: {
    authId: string;
    tokenHash: string;
    provider: 'local' | 'google';
    ipAddress: string | null;
    userAgent: string | null;
    device: string | null;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<void> {
    await this.prisma.mfaLoginChallenge.create({ data: input });
  }

  /** The owner of a challenge token, to take the owner's lock. */
  async loginChallengeOwner(tokenHash: string): Promise<string | null> {
    const challenge = await this.prisma.mfaLoginChallenge.findUnique({
      where: { tokenHash },
      select: { authId: true },
    });
    return challenge?.authId ?? null;
  }

  /**
   * The user's device with this token hash if it is still trusted at `now`
   * (not revoked, not expired); its last use is recorded. A token of
   * another user's device never matches.
   */
  async useTrustedDevice(
    authId: string,
    tokenHash: string,
    now: Date,
  ): Promise<{ id: string } | null> {
    const { count } = await this.prisma.mfaTrustedDevice.updateMany({
      where: { authId, tokenHash, revokedAt: null, expiresAt: { gt: now } },
      data: { lastUsedAt: now },
    });
    if (count !== 1) return null;
    return this.prisma.mfaTrustedDevice.findUnique({
      where: { tokenHash },
      select: { id: true },
    });
  }

  /** The user's trusted devices at `now`, newest first. */
  listTrustedDevices(authId: string, now: Date): Promise<TrustedDeviceView[]> {
    return this.prisma.mfaTrustedDevice.findMany({
      where: { authId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        name: true,
        ipAddress: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    });
  }

  /** The ID of the user's device with this token hash, if any. */
  async trustedDeviceIdByToken(
    authId: string,
    tokenHash: string,
  ): Promise<string | null> {
    const device = await this.prisma.mfaTrustedDevice.findFirst({
      where: { authId, tokenHash },
      select: { id: true },
    });
    return device?.id ?? null;
  }

  /**
   * Revokes one of the user's devices. Returns false when the user has no
   * such device (including another user's device); revoking an already
   * revoked or expired device of the user succeeds without a change.
   */
  async revokeTrustedDevice(
    authId: string,
    deviceId: string,
    now: Date,
    context: SecurityEventContext = {},
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const device = await tx.mfaTrustedDevice.findFirst({
        where: { id: deviceId, authId },
        select: { id: true, name: true },
      });
      if (!device) return false;
      const { count } = await tx.mfaTrustedDevice.updateMany({
        where: { id: deviceId, authId, revokedAt: null },
        data: { revokedAt: now },
      });
      if (count > 0) {
        await this.events.record(tx, {
          authId,
          type: 'TRUSTED_DEVICE_REVOKED',
          context,
          details: { reason: 'user', deviceId, name: device.name },
          now,
        });
      }
      return true;
    });
  }

  private unitOfWork(
    tx: Prisma.TransactionClient,
    authId: string,
  ): MfaUnitOfWork {
    const audit = async (
      changes: FieldChange[],
      metadata: ActivityLogMetadata,
    ) => {
      // About the account itself, so account erasure removes it. Never
      // includes a secret or a code.
      await this.activityLog.logActivity(
        {
          tableName: 'authUser',
          recordId: authId,
          action: 'update',
          eventType: 'update',
          changes,
          metadata,
        },
        tx,
      );
    };

    return {
      tx,
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
          mfaFailedAttemptsAt: [],
          mfaBlockedUntil: null,
        };
        // Accounts created before authSecurity rows existed get one now.
        await tx.authSecurity.upsert({
          where: { authId },
          create: { authId, ...data },
          update: data,
        });
        await audit(
          [
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
        );
      },
      verificationState: async () => {
        const security = await tx.authSecurity.findUnique({
          where: { authId },
          select: {
            mfaSecret: true,
            mfaLastUsedStep: true,
            mfaFailedAttemptsAt: true,
            mfaBlockedUntil: true,
          },
        });
        if (!security) return null;
        return {
          mfaSecret: security.mfaSecret,
          mfaLastUsedStep: security.mfaLastUsedStep,
          failedAttemptsAt: security.mfaFailedAttemptsAt,
          blockedUntil: security.mfaBlockedUntil,
        };
      },
      saveVerificationLockout: async ({ failedAttemptsAt, blockedUntil }) => {
        await tx.authSecurity.update({
          where: { authId },
          data: {
            mfaFailedAttemptsAt: failedAttemptsAt,
            mfaBlockedUntil: blockedUntil,
          },
        });
      },
      recordTotpStep: async (step) => {
        const { count } = await tx.authSecurity.updateMany({
          where: {
            authId,
            OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: step } }],
          },
          data: { mfaLastUsedStep: step },
        });
        return count === 1;
      },
      unusedRecoveryCodes: () =>
        tx.mfaRecoveryCode.findMany({
          where: { authId, usedAt: null },
          select: { id: true, codeHash: true },
        }),
      markRecoveryCodeUsed: async (id, now) => {
        // Conditional: of concurrent uses of one code, only one updates it.
        const { count } = await tx.mfaRecoveryCode.updateMany({
          where: { id, authId, usedAt: null },
          data: { usedAt: now },
        });
        return count === 1;
      },
      updateMfaSecret: async (encryptedSecret) => {
        await tx.authSecurity.update({
          where: { authId },
          data: { mfaSecret: encryptedSecret },
        });
      },
      loginChallenge: (tokenHash) =>
        tx.mfaLoginChallenge.findFirst({
          where: { tokenHash, authId },
          select: {
            id: true,
            authId: true,
            provider: true,
            expiresAt: true,
            consumedAt: true,
          },
        }),
      consumeLoginChallenge: async (id, now) => {
        const { count } = await tx.mfaLoginChallenge.updateMany({
          where: { id, authId, consumedAt: null, expiresAt: { gt: now } },
          data: { consumedAt: now },
        });
        return count === 1;
      },
      createTrustedDevice: async (input, maxActive) => {
        const device = await tx.mfaTrustedDevice.create({
          data: { authId, ...input },
          select: { id: true },
        });
        const surplus = await tx.mfaTrustedDevice.findMany({
          where: {
            authId,
            revokedAt: null,
            expiresAt: { gt: input.createdAt },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: maxActive,
          select: { id: true },
        });
        if (surplus.length > 0) {
          await tx.mfaTrustedDevice.updateMany({
            where: { id: { in: surplus.map((d) => d.id) }, revokedAt: null },
            data: { revokedAt: input.createdAt },
          });
        }
        return { id: device.id, revokedIds: surplus.map((d) => d.id) };
      },
      replaceRecoveryCodes: async (codeHashes) => {
        await tx.mfaRecoveryCode.deleteMany({ where: { authId } });
        await tx.mfaRecoveryCode.createMany({
          data: codeHashes.map((codeHash) => ({ authId, codeHash })),
        });
      },
      countRecoveryCodes: () => this.countUnused(tx, authId),
      disableMfa: async () => {
        await tx.authSecurity.update({
          where: { authId },
          data: {
            mfaEnabled: false,
            mfaMethod: null,
            mfaSecret: null,
            mfaLastUsedStep: null,
            mfaFailedAttemptsAt: [],
            mfaBlockedUntil: null,
          },
        });
        await tx.mfaRecoveryCode.deleteMany({ where: { authId } });
        await tx.mfaEnrollment.deleteMany({ where: { authId } });
        await tx.mfaLoginChallenge.deleteMany({
          where: { authId, consumedAt: null },
        });
        // SMS verification needs authenticator MFA: every number is revoked
        // and every code sent to it invalidated.
        await new MfaSmsStore(tx, authId).revokeAllPhones(
          'mfa_disabled',
          new Date(),
        );
      },
      replaceMfaSecret: async ({ encryptedSecret, usedStep }) => {
        await tx.authSecurity.update({
          where: { authId },
          data: {
            mfaSecret: encryptedSecret,
            mfaLastUsedStep: usedStep,
            mfaFailedAttemptsAt: [],
            mfaBlockedUntil: null,
          },
        });
      },
      revokeOtherSessions: async (keepSessionId, now) => {
        const revoked = await this.sessions.revokeSessions(
          authId,
          keepSessionId ? { except: keepSessionId } : {},
          'MFA_ENABLED',
          now,
          tx,
        );
        await tx.stepUpApproval.deleteMany({
          where: {
            authId,
            ...(keepSessionId ? { sessionId: { not: keepSessionId } } : {}),
          },
        });
        await tx.mfaLoginChallenge.deleteMany({
          where: { authId, consumedAt: null },
        });
        return revoked;
      },
      markSessionMfaVerified: async (sessionId, method, now) => {
        await tx.refreshSession.updateMany({
          where: { authId, familyId: sessionId, revokedAt: null },
          data: { mfaVerifiedAt: now, mfaVerifiedWith: method },
        });
      },
      recordEvent: ({ type, context, details, now }) =>
        this.events.record(tx, { authId, type, context, details, now }),
      revokeTrustedDevices: async (now) => {
        const { count } = await tx.mfaTrustedDevice.updateMany({
          where: { authId, revokedAt: null },
          data: { revokedAt: now },
        });
        return count;
      },
      audit,
    };
  }

  private countUnused(
    client: Prisma.TransactionClient | PrismaService,
    authId: string,
  ): Promise<number> {
    return client.mfaRecoveryCode.count({ where: { authId, usedAt: null } });
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
