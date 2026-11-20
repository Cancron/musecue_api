import { Injectable } from '@nestjs/common';
import type {
  MfaSmsCodePurpose,
  mfaMethod,
  Prisma,
  SecurityEventType,
  userStatus,
} from '@prisma/client';
import {
  ActivityLogService,
  type ActivityLogMetadata,
  type FieldChange,
} from '../../../common/services/activity-log.service';
import { PrismaService } from '../../../common/services/prisma.service';
import {
  SecurityEventLog,
  type SecurityEventContext,
  type SecurityEventDetails,
} from '../../security-events/security-event.log';
import { lockMfaUser } from '../mfa.repository';

/** The account fields SMS decisions depend on. */
export interface SmsAccountState {
  email: string;
  status: userStatus;
  mfaEnabled: boolean;
  mfaMethod: mfaMethod | null;
  /** SMS codes sent / checked within the last 15 minutes (newest last). */
  deliveriesAt: Date[];
  attemptsAt: Date[];
}

/** The verified phone; `phoneNumber` is encrypted. */
export interface StoredPhone {
  id: string;
  phoneNumber: string;
  maskedNumber: string;
  verifiedAt: Date;
}

export interface StoredSmsCode {
  id: string;
  purpose: MfaSmsCodePurpose;
  phoneId: string | null;
  challengeId: string | null;
  /** The encrypted number being verified (phone verification codes). */
  destination: string | null;
  maskedNumber: string;
  codeHash: string;
  createdAt: Date;
  expiresAt: Date;
  /** When the provider accepted the message; never usable before. */
  deliveredAt: Date | null;
}

export interface NewSmsCode {
  id: string;
  purpose: MfaSmsCodePurpose;
  phoneId: string | null;
  challengeId: string | null;
  destination: string | null;
  maskedNumber: string;
  codeHash: string;
  createdAt: Date;
  expiresAt: Date;
}

/** One user's SMS state inside a transaction holding the user's MFA lock. */
export interface MfaSmsUnitOfWork {
  readonly tx: Prisma.TransactionClient;
  account(): Promise<SmsAccountState | null>;
  phone(): Promise<StoredPhone | null>;
  saveDeliveries(deliveriesAt: Date[]): Promise<void>;
  saveAttempts(attemptsAt: Date[]): Promise<void>;
  createCode(code: NewSmsCode): Promise<void>;
  /**
   * Ends every open code of the user matching `filter` (all of them without
   * one); returns how many.
   */
  invalidateOpenCodes(
    now: Date,
    filter?: {
      purposes?: MfaSmsCodePurpose[];
      challengeId?: string;
      id?: string;
    },
  ): Promise<number>;
  /** The newest open (unused, not invalidated) code matching `filter`. */
  latestOpenCode(filter: {
    purposes: MfaSmsCodePurpose[];
    challengeId?: string;
  }): Promise<StoredSmsCode | null>;
  /** Uses an open code once; false if it is no longer open. */
  markCodeUsed(id: string, now: Date): Promise<boolean>;
  createPhone(input: {
    phoneNumber: string;
    maskedNumber: string;
    verifiedAt: Date;
  }): Promise<void>;
  replacePhone(
    phoneId: string,
    input: { phoneNumber: string; maskedNumber: string; verifiedAt: Date },
  ): Promise<void>;
  deletePhone(): Promise<void>;
  /** Whether a login challenge of the user is still usable at `now`. */
  openLoginChallenge(
    tokenHash: string,
    now: Date,
  ): Promise<{ id: string } | null>;
  recordEvent(event: {
    type: SecurityEventType;
    context?: SecurityEventContext;
    details?: SecurityEventDetails;
    now: Date;
  }): Promise<void>;
  audit(changes: FieldChange[], metadata: ActivityLogMetadata): Promise<void>;
}

const CODE_SELECT = {
  id: true,
  purpose: true,
  phoneId: true,
  challengeId: true,
  destination: true,
  maskedNumber: true,
  codeHash: true,
  createdAt: true,
  expiresAt: true,
  deliveredAt: true,
} as const;

/**
 * PostgreSQL persistence of SMS verification: the verified phone number,
 * SMS codes (HMACs only) and the per-user delivery and verification limits.
 * Changes run under the same per-user advisory lock as every other MFA
 * change, so limits are exact and a code is used at most once.
 */
@Injectable()
export class MfaSmsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLog: ActivityLogService,
    private readonly events: SecurityEventLog,
  ) {}

  /** Runs `work` in a transaction holding the user's MFA lock. */
  withLock<T>(
    authId: string,
    work: (uow: MfaSmsUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await lockMfaUser(tx, authId);
      return work(this.unitOfWork(tx, authId));
    });
  }

  /** Unlocked read for status and sign-in (never the number itself). */
  async read(authId: string): Promise<{
    mfaEnabled: boolean;
    mfaMethod: mfaMethod | null;
    phone: { maskedNumber: string; verifiedAt: Date } | null;
    pending: {
      purpose: MfaSmsCodePurpose;
      maskedNumber: string;
      expiresAt: Date;
    } | null;
  }> {
    const [security, phone, pending] = await Promise.all([
      this.prisma.authSecurity.findUnique({
        where: { authId },
        select: { mfaEnabled: true, mfaMethod: true },
      }),
      this.prisma.mfaPhone.findUnique({
        where: { authId },
        select: { maskedNumber: true, verifiedAt: true },
      }),
      this.prisma.mfaSmsCode.findFirst({
        where: {
          authId,
          purpose: { in: ['PHONE_ENROLLMENT', 'PHONE_REPLACEMENT'] },
          usedAt: null,
          invalidatedAt: null,
          deliveredAt: { not: null },
          expiresAt: { gt: new Date() },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { purpose: true, maskedNumber: true, expiresAt: true },
      }),
    ]);
    return {
      mfaEnabled: security?.mfaEnabled ?? false,
      mfaMethod: security?.mfaMethod ?? null,
      phone,
      pending,
    };
  }

  /**
   * Records that the provider accepted the code's message: only then can it
   * be used. False when the code is no longer open (for example ended by a
   * newer code meanwhile).
   */
  async markDelivered(
    authId: string,
    codeId: string,
    now: Date,
  ): Promise<boolean> {
    const { count } = await this.prisma.mfaSmsCode.updateMany({
      where: {
        id: codeId,
        authId,
        deliveredAt: null,
        usedAt: null,
        invalidatedAt: null,
      },
      data: { deliveredAt: now },
    });
    return count === 1;
  }

  /** The owner of a login challenge token, to take the owner's lock. */
  async loginChallengeOwner(tokenHash: string): Promise<string | null> {
    const challenge = await this.prisma.mfaLoginChallenge.findUnique({
      where: { tokenHash },
      select: { authId: true },
    });
    return challenge?.authId ?? null;
  }

  /** The SMS state of `authId` inside an existing (locked) transaction. */
  unitOfWork(tx: Prisma.TransactionClient, authId: string): MfaSmsUnitOfWork {
    return {
      tx,
      account: async () => {
        const user = await tx.authUser.findUnique({
          where: { id: authId },
          select: {
            email: true,
            status: true,
            authSecurity: {
              select: {
                mfaEnabled: true,
                mfaMethod: true,
                mfaSmsDeliveriesAt: true,
                mfaSmsAttemptsAt: true,
              },
            },
          },
        });
        if (!user) return null;
        return {
          email: user.email,
          status: user.status,
          mfaEnabled: user.authSecurity?.mfaEnabled ?? false,
          mfaMethod: user.authSecurity?.mfaMethod ?? null,
          deliveriesAt: user.authSecurity?.mfaSmsDeliveriesAt ?? [],
          attemptsAt: user.authSecurity?.mfaSmsAttemptsAt ?? [],
        };
      },
      phone: () =>
        tx.mfaPhone.findUnique({
          where: { authId },
          select: {
            id: true,
            phoneNumber: true,
            maskedNumber: true,
            verifiedAt: true,
          },
        }),
      saveDeliveries: async (deliveriesAt) => {
        await tx.authSecurity.update({
          where: { authId },
          data: { mfaSmsDeliveriesAt: deliveriesAt },
        });
      },
      saveAttempts: async (attemptsAt) => {
        await tx.authSecurity.update({
          where: { authId },
          data: { mfaSmsAttemptsAt: attemptsAt },
        });
      },
      createCode: async (code) => {
        await tx.mfaSmsCode.create({ data: { authId, ...code } });
      },
      invalidateOpenCodes: async (now, filter = {}) => {
        const { count } = await tx.mfaSmsCode.updateMany({
          where: {
            authId,
            usedAt: null,
            invalidatedAt: null,
            ...(filter.purposes ? { purpose: { in: filter.purposes } } : {}),
            ...(filter.challengeId ? { challengeId: filter.challengeId } : {}),
            ...(filter.id ? { id: filter.id } : {}),
          },
          data: { invalidatedAt: now },
        });
        return count;
      },
      latestOpenCode: ({ purposes, challengeId }) =>
        tx.mfaSmsCode.findFirst({
          where: {
            authId,
            purpose: { in: purposes },
            usedAt: null,
            invalidatedAt: null,
            ...(challengeId ? { challengeId } : {}),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: CODE_SELECT,
        }),
      markCodeUsed: async (id, now) => {
        // Conditional: of concurrent uses of one code, only one updates it.
        const { count } = await tx.mfaSmsCode.updateMany({
          where: {
            id,
            authId,
            usedAt: null,
            invalidatedAt: null,
            deliveredAt: { not: null },
            expiresAt: { gt: now },
          },
          data: { usedAt: now },
        });
        return count === 1;
      },
      createPhone: async (input) => {
        await tx.mfaPhone.create({ data: { authId, ...input } });
      },
      replacePhone: async (phoneId, input) => {
        await tx.mfaPhone.update({
          where: { id: phoneId, authId },
          data: input,
        });
      },
      deletePhone: async () => {
        await tx.mfaPhone.deleteMany({ where: { authId } });
      },
      openLoginChallenge: (tokenHash, now) =>
        tx.mfaLoginChallenge.findFirst({
          where: {
            tokenHash,
            authId,
            consumedAt: null,
            expiresAt: { gt: now },
          },
          select: { id: true },
        }),
      recordEvent: ({ type, context, details, now }) =>
        this.events.record(tx, { authId, type, context, details, now }),
      audit: async (changes, metadata) => {
        // About the account itself; never a number, code or secret.
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
      },
    };
  }
}
