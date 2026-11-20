import type { MfaSmsCodePurpose, Prisma } from '@prisma/client';

/** A stored phone number (its number encrypted). */
export interface StoredSmsPhone {
  id: string;
  phoneNumber: string;
  phoneHint: string;
  createdAt: Date;
  verifiedAt: Date | null;
}

/** A usable SMS code (hash only). */
export interface StoredSmsCode {
  id: string;
  phoneId: string;
  purpose: MfaSmsCodePurpose;
  codeHash: string;
  expiresAt: Date;
}

/** What SMS decisions need from the account. */
export interface SmsAccountState {
  mfaEnabled: boolean;
  mfaMethod: string | null;
  sentAt: Date[];
  attemptsAt: Date[];
}

export type SmsPhoneRevocation =
  | 'superseded'
  | 'replaced'
  | 'removed'
  | 'mfa_disabled';

const PHONE_SELECT = {
  id: true,
  phoneNumber: true,
  phoneHint: true,
  createdAt: true,
  verifiedAt: true,
} as const;

/**
 * PostgreSQL reads and writes of one user's SMS verification state, through
 * the client of the caller's transaction (normally MfaRepository.withLock,
 * which holds the user's MFA lock). Every query is scoped to `authId`.
 */
export class MfaSmsStore {
  constructor(
    private readonly tx: Prisma.TransactionClient,
    private readonly authId: string,
  ) {}

  async account(): Promise<SmsAccountState | null> {
    const security = await this.tx.authSecurity.findUnique({
      where: { authId: this.authId },
      select: {
        mfaEnabled: true,
        mfaMethod: true,
        mfaSmsSentAt: true,
        mfaSmsAttemptsAt: true,
      },
    });
    if (!security) return null;
    return {
      mfaEnabled: security.mfaEnabled,
      mfaMethod: security.mfaMethod,
      sentAt: security.mfaSmsSentAt,
      attemptsAt: security.mfaSmsAttemptsAt,
    };
  }

  async phone(status: 'ACTIVE' | 'PENDING'): Promise<StoredSmsPhone | null> {
    const phone = await this.tx.mfaSmsPhone.findFirst({
      where: { authId: this.authId, status },
      select: PHONE_SELECT,
    });
    return phone ? { ...phone, phoneNumber: phone.phoneNumber ?? '' } : null;
  }

  async createPendingPhone(input: {
    encryptedNumber: string;
    phoneHint: string;
    now: Date;
  }): Promise<StoredSmsPhone> {
    const phone = await this.tx.mfaSmsPhone.create({
      data: {
        authId: this.authId,
        status: 'PENDING',
        phoneNumber: input.encryptedNumber,
        phoneHint: input.phoneHint,
        createdAt: input.now,
      },
      select: PHONE_SELECT,
    });
    return { ...phone, phoneNumber: phone.phoneNumber ?? '' };
  }

  /** Stores a number re-encrypted with the current MFA key. */
  async updatePhoneNumber(
    phoneId: string,
    encryptedNumber: string,
  ): Promise<void> {
    await this.tx.mfaSmsPhone.updateMany({
      where: { id: phoneId, authId: this.authId, status: { not: 'REVOKED' } },
      data: { phoneNumber: encryptedNumber },
    });
  }

  async activatePhone(phoneId: string, now: Date): Promise<void> {
    await this.tx.mfaSmsPhone.updateMany({
      where: { id: phoneId, authId: this.authId, status: 'PENDING' },
      data: { status: 'ACTIVE', verifiedAt: now },
    });
  }

  /**
   * Revokes a number (its number is erased) and, in the same transaction,
   * invalidates every SMS code sent to it that is not used yet. Returns how
   * many codes were invalidated.
   */
  async revokePhone(
    phoneId: string,
    reason: SmsPhoneRevocation,
    now: Date,
  ): Promise<number> {
    await this.tx.mfaSmsPhone.updateMany({
      where: { id: phoneId, authId: this.authId, status: { not: 'REVOKED' } },
      data: {
        status: 'REVOKED',
        phoneNumber: null,
        revokedAt: now,
        revokedReason: reason,
      },
    });
    return this.invalidateCodes({ phoneId }, now);
  }

  /** Revokes every number of the user (see revokePhone). */
  async revokeAllPhones(reason: SmsPhoneRevocation, now: Date) {
    const phones = await this.tx.mfaSmsPhone.findMany({
      where: { authId: this.authId, status: { not: 'REVOKED' } },
      select: { id: true },
    });
    let codes = 0;
    for (const phone of phones) {
      codes += await this.revokePhone(phone.id, reason, now);
    }
    return { phones: phones.length, codes };
  }

  /** Invalidates the unused codes matching `where`; returns how many. */
  async invalidateCodes(
    where: {
      phoneId?: string;
      purpose?: MfaSmsCodePurpose;
      loginChallengeId?: string;
    },
    now: Date,
  ): Promise<number> {
    const { count } = await this.tx.mfaSmsCode.updateMany({
      where: {
        authId: this.authId,
        ...where,
        consumedAt: null,
        invalidatedAt: null,
      },
      data: { invalidatedAt: now },
    });
    return count;
  }

  async createCode(input: {
    id: string;
    phoneId: string;
    purpose: MfaSmsCodePurpose;
    loginChallengeId: string | null;
    codeHash: string;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<void> {
    await this.tx.mfaSmsCode.create({
      data: { authId: this.authId, ...input },
    });
  }

  /** The codes that can still be used (unused, valid, not invalidated). */
  usableCodes(
    where: {
      phoneId: string;
      purpose: MfaSmsCodePurpose;
      loginChallengeId?: string;
    },
    now: Date,
  ): Promise<StoredSmsCode[]> {
    return this.tx.mfaSmsCode.findMany({
      where: {
        authId: this.authId,
        ...where,
        consumedAt: null,
        invalidatedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        phoneId: true,
        purpose: true,
        codeHash: true,
        expiresAt: true,
      },
    });
  }

  /** Uses a code; false when it is no longer usable (conditional). */
  async consumeCode(codeId: string, now: Date): Promise<boolean> {
    const { count } = await this.tx.mfaSmsCode.updateMany({
      where: {
        id: codeId,
        authId: this.authId,
        consumedAt: null,
        invalidatedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    return count === 1;
  }

  async saveSent(sentAt: Date[]): Promise<void> {
    await this.tx.authSecurity.update({
      where: { authId: this.authId },
      data: { mfaSmsSentAt: sentAt },
    });
  }

  async saveAttempts(attemptsAt: Date[]): Promise<void> {
    await this.tx.authSecurity.update({
      where: { authId: this.authId },
      data: { mfaSmsAttemptsAt: attemptsAt },
    });
  }
}
