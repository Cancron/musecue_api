import type { Prisma, userStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  EMPTY_ENROLLMENT,
  type LockedMfaAccount,
  type MfaAccount,
  type MfaActivation,
  MfaEnrollmentRepository,
  type MfaEnrollmentState,
} from '../../src/auth/mfa/mfa-enrollment.repository';

export interface StoredMfaUser {
  account: MfaAccount;
  /** null: no MfaEnrollment row. */
  enrollment: MfaEnrollmentState | null;
  /** What the real repository writes to authSecurity on activation. */
  mfaSecret: string | null;
  mfaLastUsedStep: number | null;
}

const clone = (user: StoredMfaUser): StoredMfaUser => ({
  account: { ...user.account },
  enrollment: user.enrollment ? { ...user.enrollment } : null,
  mfaSecret: user.mfaSecret,
  mfaLastUsedStep: user.mfaLastUsedStep,
});

/**
 * In-memory MfaEnrollmentRepository with the real one's transaction
 * semantics: work for one user runs one at a time (the row lock), sees a
 * snapshot, and its writes are kept only when it completes.
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

  withLockedAccount<T>(
    authId: string,
    work: (locked: LockedMfaAccount) => Promise<T>,
  ): Promise<{ result: T } | null> {
    const previous = this.queues.get(authId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const stored = this.users.get(authId);
        if (!stored) return null;
        const draft = clone(stored);
        const locked: LockedMfaAccount = {
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
            draft.enrollment = null;
            return Promise.resolve();
          },
        };
        const result = await work(locked);
        // Commit only after the work succeeded (a throw rolls back).
        this.users.set(authId, draft);
        return { result };
      });
    this.queues.set(authId, run);
    return run;
  }

  deleteStale(): Promise<number> {
    return Promise.resolve(0);
  }
}
