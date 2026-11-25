import type { Prisma, userStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  type LockedMfaCredentials,
  MfaCredentialsRepository,
  type RecoveryCodeSummary,
} from '../../src/auth/mfa/mfa-credentials.repository';
import {
  EMPTY_ENROLLMENT,
  type LockedMfaAccount,
  type MfaAccount,
  type MfaActivation,
  MfaEnrollmentRepository,
  type MfaEnrollmentState,
} from '../../src/auth/mfa/mfa-enrollment.repository';
import type { FailureCounter } from '../../src/auth/mfa/mfa-enrollment.policy';

export interface StoredRecoveryCode {
  codeHash: string;
  batchId: string;
  createdAt: Date;
  usedAt: Date | null;
  invalidatedAt: Date | null;
}

export interface StoredMfaUser {
  account: MfaAccount;
  /** null: no MfaEnrollment row. */
  enrollment: MfaEnrollmentState | null;
  /** What the real repositories write to authSecurity and MfaRecoveryCode. */
  mfaSecret: string | null;
  mfaLastUsedStep: number | null;
  counter: FailureCounter;
  recoveryCodes: StoredRecoveryCode[];
}

const NO_COUNTER: FailureCounter = {
  failedAttempts: 0,
  failureWindowStartedAt: null,
  blockedUntil: null,
};

const clone = (user: StoredMfaUser): StoredMfaUser => ({
  account: { ...user.account },
  enrollment: user.enrollment ? { ...user.enrollment } : null,
  mfaSecret: user.mfaSecret,
  mfaLastUsedStep: user.mfaLastUsedStep,
  counter: { ...user.counter },
  recoveryCodes: user.recoveryCodes.map((code) => ({ ...code })),
});

function summarize(user: StoredMfaUser): RecoveryCodeSummary {
  const current = user.recoveryCodes.filter((c) => c.invalidatedAt === null);
  return {
    remaining: current.filter((c) => c.usedAt === null).length,
    generatedAt:
      current.reduce<Date | null>(
        (latest, c) => (!latest || c.createdAt > latest ? c.createdAt : latest),
        null,
      ) ?? null,
  };
}

function addCodes(user: StoredMfaUser, hashes: string[], now: Date): void {
  const batchId = randomUUID();
  for (const codeHash of hashes) {
    if (user.recoveryCodes.some((c) => c.codeHash === codeHash)) {
      throw new Error('Unique constraint failed on (authId, codeHash)');
    }
    user.recoveryCodes.push({
      codeHash,
      batchId,
      createdAt: now,
      usedAt: null,
      invalidatedAt: null,
    });
  }
}

function invalidateCodes(user: StoredMfaUser, now: Date): void {
  for (const code of user.recoveryCodes) {
    if (code.invalidatedAt === null) code.invalidatedAt = now;
  }
}

/**
 * In-memory MfaEnrollmentRepository and MfaCredentialsRepository with the
 * real ones' transaction semantics: work for one user runs one at a time
 * (the user's row lock, shared by both), sees a snapshot, and its writes are
 * kept only when it completes.
 */
export class InMemoryMfaEnrollments {
  readonly users = new Map<string, StoredMfaUser>();
  private readonly queues = new Map<string, Promise<unknown>>();

  addUser(
    overrides: Partial<MfaAccount> & { status?: userStatus } = {},
  ): StoredMfaUser {
    const authId = overrides.authId ?? randomUUID();
    const user: StoredMfaUser = {
      account: {
        authId,
        email: `${authId.slice(0, 8)}@example.com`,
        status: 'ACTIVE',
        mfaEnabled: false,
        mfaMethod: null,
        mfaEnabledAt: null,
        ...overrides,
      },
      enrollment: null,
      mfaSecret: null,
      mfaLastUsedStep: null,
      counter: { ...NO_COUNTER },
      recoveryCodes: [],
    };
    this.users.set(authId, user);
    return user;
  }

  get(authId: string): StoredMfaUser {
    const user = this.users.get(authId);
    if (!user) throw new Error(`Unknown user ${authId}`);
    return user;
  }

  asRepository(): MfaEnrollmentRepository {
    return this as unknown as MfaEnrollmentRepository;
  }

  asCredentialsRepository(): MfaCredentialsRepository {
    return {
      summary: (authId: string) => {
        const user = this.get(authId);
        return Promise.resolve({
          counter: { ...user.counter },
          recovery: summarize(user),
        });
      },
      withLockedCredentials: <T>(
        authId: string,
        work: (locked: LockedMfaCredentials) => Promise<T>,
      ) => this.withLockedCredentials(authId, work),
      deleteInvalidatedBefore: () => Promise.resolve(0),
    } as unknown as MfaCredentialsRepository;
  }

  read(
    authId: string,
  ): Promise<{ account: MfaAccount; enrollment: MfaEnrollmentState } | null> {
    const user = this.users.get(authId);
    if (!user) return Promise.resolve(null);
    const copy = clone(user);
    return Promise.resolve({
      account: copy.account,
      enrollment: copy.enrollment ?? { ...EMPTY_ENROLLMENT },
    });
  }

  /** Runs `work` on a snapshot under the user's lock; commits on success. */
  private locked<T>(
    authId: string,
    work: (draft: StoredMfaUser) => Promise<T>,
  ): Promise<{ result: T } | null> {
    const previous = this.queues.get(authId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const stored = this.users.get(authId);
        if (!stored) return null;
        const draft = clone(stored);
        const result = await work(draft);
        // Commit only after the work succeeded (a throw rolls back).
        this.users.set(authId, draft);
        return { result };
      });
    this.queues.set(authId, run);
    return run;
  }

  withLockedAccount<T>(
    authId: string,
    work: (locked: LockedMfaAccount) => Promise<T>,
  ): Promise<{ result: T } | null> {
    return this.locked(authId, (draft) =>
      work({
        account: { ...draft.account },
        enrollment: draft.enrollment
          ? { ...draft.enrollment }
          : { ...EMPTY_ENROLLMENT },
        tx: {} as Prisma.TransactionClient,
        saveEnrollment: (state) => {
          draft.enrollment = { ...state };
          return Promise.resolve();
        },
        activate: (activation: MfaActivation) => {
          draft.account = {
            ...draft.account,
            mfaEnabled: true,
            mfaMethod: activation.method,
            mfaEnabledAt: activation.enabledAt,
          };
          draft.mfaSecret = activation.encryptedSecret;
          draft.mfaLastUsedStep = activation.lastUsedStep;
          draft.counter = { ...NO_COUNTER };
          draft.enrollment = null;
          invalidateCodes(draft, activation.enabledAt);
          addCodes(draft, activation.recoveryCodeHashes, activation.enabledAt);
          return Promise.resolve();
        },
      }),
    );
  }

  withLockedCredentials<T>(
    authId: string,
    work: (locked: LockedMfaCredentials) => Promise<T>,
  ): Promise<{ result: T } | null> {
    return this.locked(authId, (draft) =>
      work({
        credentials: {
          authId,
          status: draft.account.status,
          mfaEnabled: draft.account.mfaEnabled,
          mfaMethod: draft.account.mfaMethod,
          encryptedSecret: draft.mfaSecret,
          lastUsedStep: draft.mfaLastUsedStep,
          counter: { ...draft.counter },
        },
        tx: {} as Prisma.TransactionClient,
        acceptTotpStep: (step) => {
          if (draft.mfaLastUsedStep !== null && draft.mfaLastUsedStep >= step) {
            return Promise.resolve(false);
          }
          draft.mfaLastUsedStep = step;
          return Promise.resolve(true);
        },
        consumeRecoveryCode: (codeHash, now) => {
          const code = draft.recoveryCodes.find(
            (c) =>
              c.codeHash === codeHash &&
              c.usedAt === null &&
              c.invalidatedAt === null,
          );
          if (code) code.usedAt = now;
          return Promise.resolve(Boolean(code));
        },
        saveCounter: (counter) => {
          draft.counter = { ...counter };
          return Promise.resolve();
        },
        replaceRecoveryCodes: (hashes, now) => {
          invalidateCodes(draft, now);
          addCodes(draft, hashes, now);
          return Promise.resolve();
        },
        recoverySummary: () => Promise.resolve(summarize(draft)),
      }),
    );
  }

  deleteStale(): Promise<number> {
    return Promise.resolve(0);
  }
}
