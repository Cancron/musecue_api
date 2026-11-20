import type { MfaSmsCodePurpose, Prisma } from '@prisma/client';
import type {
  MfaSmsRepository,
  MfaSmsUnitOfWork,
  NewSmsCode,
  SmsAccountState,
  StoredPhone,
} from '../../src/auth/mfa/sms/mfa-sms.repository';
import type { SecurityEventDetails } from '../../src/auth/security-events/security-event.log';

export interface FakeSmsCode extends NewSmsCode {
  authId: string;
  deliveredAt: Date | null;
  usedAt: Date | null;
  invalidatedAt: Date | null;
}

/**
 * In-memory MfaSmsRepository for unit tests: accounts, phones, codes and
 * login challenges, with the same rules as the PostgreSQL repository
 * (ending a code is permanent; deleting a phone deletes its sign-in codes).
 * A unit of work runs against a copy that is committed when `work`
 * resolves and dropped when it throws, like a transaction.
 */
export class FakeSmsRepository {
  accounts = new Map<string, SmsAccountState>();
  phones = new Map<string, StoredPhone>();
  codes: FakeSmsCode[] = [];
  challenges = new Map<
    string,
    { id: string; authId: string; consumedAt: Date | null; expiresAt: Date }
  >();
  events: { authId: string; type: string; details?: SecurityEventDetails }[] =
    [];
  audits: { authId: string; fields: string[] }[] = [];
  /** Simulated outages: recording deliveries, and locked transactions. */
  failMarkDelivered = false;
  failLocksAfter: number | null = null;
  private locks = 0;
  private phoneIds = 0;

  addAccount(authId: string, mfa = true) {
    this.accounts.set(authId, {
      email: `${authId}@example.com`,
      status: 'ACTIVE',
      mfaEnabled: mfa,
      mfaMethod: mfa ? 'totp' : null,
      deliveriesAt: [],
      attemptsAt: [],
    });
  }

  addChallenge(authId: string, tokenHash: string, expiresAt: Date) {
    const id = `challenge-${this.challenges.size + 1}`;
    this.challenges.set(tokenHash, {
      id,
      authId,
      consumedAt: null,
      expiresAt,
    });
    return id;
  }

  asRepository(): MfaSmsRepository {
    return {
      withLock: async <T>(
        authId: string,
        work: (uow: MfaSmsUnitOfWork) => Promise<T>,
      ) => {
        this.locks++;
        if (this.failLocksAfter !== null && this.locks > this.failLocksAfter) {
          throw new Error('database unavailable');
        }
        const snapshot = this.snapshot();
        try {
          return await work(this.unitOfWork(authId));
        } catch (error) {
          this.restore(snapshot);
          throw error;
        }
      },
      unitOfWork: (_tx: Prisma.TransactionClient, authId: string) =>
        this.unitOfWork(authId),
      read: (authId: string) => {
        const account = this.accounts.get(authId);
        const phone = this.phones.get(authId) ?? null;
        const pending =
          this.codes
            .filter(
              (c) =>
                c.authId === authId &&
                c.purpose !== 'SIGN_IN' &&
                c.deliveredAt &&
                !c.usedAt &&
                !c.invalidatedAt,
            )
            .at(-1) ?? null;
        return Promise.resolve({
          mfaEnabled: account?.mfaEnabled ?? false,
          mfaMethod: account?.mfaMethod ?? null,
          phone: phone
            ? { maskedNumber: phone.maskedNumber, verifiedAt: phone.verifiedAt }
            : null,
          pending: pending
            ? {
                purpose: pending.purpose,
                maskedNumber: pending.maskedNumber,
                expiresAt: pending.expiresAt,
              }
            : null,
        });
      },
      markDelivered: (authId: string, codeId: string, now: Date) => {
        if (this.failMarkDelivered) {
          return Promise.reject(new Error('database unavailable'));
        }
        const code = this.codes.find(
          (c) => c.id === codeId && c.authId === authId,
        );
        if (!code || code.deliveredAt || code.usedAt || code.invalidatedAt) {
          return Promise.resolve(false);
        }
        code.deliveredAt = now;
        return Promise.resolve(true);
      },
      loginChallengeOwner: (tokenHash: string) =>
        Promise.resolve(this.challenges.get(tokenHash)?.authId ?? null),
    } as unknown as MfaSmsRepository;
  }

  codesOf(authId: string, purpose?: MfaSmsCodePurpose) {
    return this.codes.filter(
      (c) => c.authId === authId && (!purpose || c.purpose === purpose),
    );
  }

  private unitOfWork(authId: string): MfaSmsUnitOfWork {
    const open = (c: FakeSmsCode) =>
      c.authId === authId && !c.usedAt && !c.invalidatedAt;
    return {
      tx: {} as Prisma.TransactionClient,
      account: () => Promise.resolve(this.accounts.get(authId) ?? null),
      phone: () => Promise.resolve(this.phones.get(authId) ?? null),
      saveDeliveries: (deliveriesAt) => {
        const account = this.accounts.get(authId)!;
        this.accounts.set(authId, { ...account, deliveriesAt });
        return Promise.resolve();
      },
      saveAttempts: (attemptsAt) => {
        const account = this.accounts.get(authId)!;
        this.accounts.set(authId, { ...account, attemptsAt });
        return Promise.resolve();
      },
      createCode: (code) => {
        this.codes.push({
          ...code,
          authId,
          deliveredAt: null,
          usedAt: null,
          invalidatedAt: null,
        });
        return Promise.resolve();
      },
      invalidateOpenCodes: (now, filter = {}) => {
        let count = 0;
        for (const c of this.codes) {
          if (
            open(c) &&
            (!filter.purposes || filter.purposes.includes(c.purpose)) &&
            (!filter.challengeId || c.challengeId === filter.challengeId) &&
            (!filter.id || c.id === filter.id)
          ) {
            c.invalidatedAt = now;
            count++;
          }
        }
        return Promise.resolve(count);
      },
      latestOpenCode: ({ purposes, challengeId }) =>
        Promise.resolve(
          this.codes
            .filter(
              (c) =>
                open(c) &&
                purposes.includes(c.purpose) &&
                (!challengeId || c.challengeId === challengeId),
            )
            .at(-1) ?? null,
        ),
      markCodeUsed: (id, now) => {
        const code = this.codes.find((c) => c.id === id);
        if (
          !code ||
          !open(code) ||
          !code.deliveredAt ||
          code.expiresAt <= now
        ) {
          return Promise.resolve(false);
        }
        code.usedAt = now;
        return Promise.resolve(true);
      },
      createPhone: (input) => {
        this.phones.set(authId, { id: `phone-${++this.phoneIds}`, ...input });
        return Promise.resolve();
      },
      replacePhone: (phoneId, input) => {
        this.phones.set(authId, { id: phoneId, ...input });
        return Promise.resolve();
      },
      deletePhone: () => {
        const phone = this.phones.get(authId);
        this.phones.delete(authId);
        // ON DELETE CASCADE of its sign-in codes.
        this.codes = this.codes.filter((c) => c.phoneId !== phone?.id);
        return Promise.resolve();
      },
      openLoginChallenge: (tokenHash, now) => {
        const challenge = this.challenges.get(tokenHash);
        return Promise.resolve(
          challenge &&
            challenge.authId === authId &&
            !challenge.consumedAt &&
            challenge.expiresAt > now
            ? { id: challenge.id }
            : null,
        );
      },
      recordEvent: ({ type, details }) => {
        this.events.push({ authId, type, details });
        return Promise.resolve();
      },
      audit: (changes) => {
        this.audits.push({ authId, fields: changes.map((c) => c.fieldName) });
        return Promise.resolve();
      },
    };
  }

  private snapshot() {
    return {
      accounts: new Map(this.accounts),
      phones: new Map(this.phones),
      codes: this.codes.map((c) => ({ ...c })),
      events: [...this.events],
      audits: [...this.audits],
    };
  }

  private restore(s: ReturnType<FakeSmsRepository['snapshot']>) {
    this.accounts = s.accounts;
    this.phones = s.phones;
    this.codes = s.codes;
    this.events = s.events;
    this.audits = s.audits;
  }
}
