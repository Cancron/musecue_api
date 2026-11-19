import type { ActivityLogMetadata } from '../../src/common/services/activity-log.service';
import type {
  MfaAccountState,
  MfaEnrollmentRepository,
  MfaEnrollmentState,
  MfaUnitOfWork,
} from '../../src/auth/mfa/mfa-enrollment.repository';

export interface FakeMfaAccount extends MfaAccountState {
  mfaSecret: string | null;
  mfaLastUsedStep: number | null;
}

export interface FakeMfaAudit {
  authId: string;
  metadata: ActivityLogMetadata;
}

const cloneEnrollment = (state: MfaEnrollmentState): MfaEnrollmentState => ({
  ...state,
  failedAttemptsAt: [...state.failedAttemptsAt],
});

/**
 * In-memory stand-in for MfaEnrollmentRepository with the same transaction
 * semantics: work on one user runs strictly one at a time (the advisory
 * lock), and its writes are committed only when the work resolves (a throw
 * rolls everything back).
 */
export class FakeMfaEnrollmentRepository {
  readonly accounts = new Map<string, FakeMfaAccount>();
  readonly enrollments = new Map<string, MfaEnrollmentState>();
  readonly audits: FakeMfaAudit[] = [];
  /** Set to make the next call fail like an unreachable database. */
  failWith: Error | null = null;
  private readonly locks = new Map<string, Promise<unknown>>();

  addAccount(authId: string, overrides: Partial<FakeMfaAccount> = {}) {
    const account: FakeMfaAccount = {
      email: `${authId}@example.com`,
      status: 'ACTIVE',
      mfaEnabled: false,
      mfaMethod: null,
      mfaSecret: null,
      mfaLastUsedStep: null,
      ...overrides,
    };
    this.accounts.set(authId, account);
    return account;
  }

  asRepository(): MfaEnrollmentRepository {
    return this as unknown as MfaEnrollmentRepository;
  }

  read(authId: string) {
    this.throwIfFailing();
    const account = this.accounts.get(authId);
    const enrollment = this.enrollments.get(authId);
    return Promise.resolve({
      account: account ? this.publicAccount(account) : null,
      enrollment: enrollment ? cloneEnrollment(enrollment) : null,
    });
  }

  withLock<T>(
    authId: string,
    work: (uow: MfaUnitOfWork) => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(authId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.transaction(authId, work));
    this.locks.set(authId, run);
    return run;
  }

  private async transaction<T>(
    authId: string,
    work: (uow: MfaUnitOfWork) => Promise<T>,
  ): Promise<T> {
    this.throwIfFailing();
    const stored = this.accounts.get(authId);
    let account = stored ? { ...stored } : undefined;
    const storedEnrollment = this.enrollments.get(authId);
    let enrollment: MfaEnrollmentState | undefined = storedEnrollment
      ? cloneEnrollment(storedEnrollment)
      : undefined;
    const audits: FakeMfaAudit[] = [];

    const uow: MfaUnitOfWork = {
      account: () =>
        Promise.resolve(account ? this.publicAccount(account) : null),
      enrollment: () =>
        Promise.resolve(enrollment ? cloneEnrollment(enrollment) : null),
      saveEnrollment: (state) => {
        if ((state.secret === null) !== (state.expiresAt === null)) {
          // Mirrors MfaEnrollment_pending_secret_expiry_check.
          return Promise.reject(new Error('check constraint violated'));
        }
        if (state.failedAttemptsAt.length > 5) {
          return Promise.reject(new Error('check constraint violated'));
        }
        enrollment = cloneEnrollment(state);
        return Promise.resolve();
      },
      deleteEnrollment: () => {
        enrollment = undefined;
        return Promise.resolve();
      },
      enableMfa: ({ encryptedSecret, usedStep, metadata }) => {
        if (!account) return Promise.reject(new Error('no account'));
        account = {
          ...account,
          mfaEnabled: true,
          mfaMethod: 'totp',
          mfaSecret: encryptedSecret,
          mfaLastUsedStep: usedStep,
        };
        audits.push({ authId, metadata });
        return Promise.resolve();
      },
    };

    const result = await work(uow);
    // Commit.
    if (account) this.accounts.set(authId, account);
    if (enrollment) this.enrollments.set(authId, enrollment);
    else this.enrollments.delete(authId);
    this.audits.push(...audits);
    return result;
  }

  private publicAccount(account: FakeMfaAccount): MfaAccountState {
    return {
      email: account.email,
      status: account.status,
      mfaEnabled: account.mfaEnabled,
      mfaMethod: account.mfaMethod,
    };
  }

  private throwIfFailing() {
    if (this.failWith) {
      const error = this.failWith;
      this.failWith = null;
      throw error;
    }
  }
}
