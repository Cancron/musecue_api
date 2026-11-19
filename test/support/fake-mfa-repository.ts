import type {
  ActivityLogMetadata,
  FieldChange,
} from '../../src/common/services/activity-log.service';
import type {
  MfaAccountState,
  MfaEnrollmentState,
  MfaRepository,
  MfaUnitOfWork,
} from '../../src/auth/mfa/mfa.repository';

export interface FakeMfaAccount extends MfaAccountState {
  mfaSecret: string | null;
  mfaLastUsedStep: number | null;
  mfaFailedAttemptsAt: Date[];
  mfaBlockedUntil: Date | null;
}

export interface FakeRecoveryCode {
  codeHash: string;
  usedAt: Date | null;
}

export interface FakeMfaAudit {
  authId: string;
  changes: FieldChange[];
  metadata: ActivityLogMetadata;
}

const cloneEnrollment = (state: MfaEnrollmentState): MfaEnrollmentState => ({
  ...state,
  failedAttemptsAt: [...state.failedAttemptsAt],
});
const cloneAccount = (account: FakeMfaAccount): FakeMfaAccount => ({
  ...account,
  mfaFailedAttemptsAt: [...account.mfaFailedAttemptsAt],
});
const cloneCodes = (codes: FakeRecoveryCode[]) =>
  codes.map((code) => ({ ...code }));

/**
 * In-memory stand-in for MfaRepository with the same transaction semantics:
 * work on one user runs strictly one at a time (the advisory lock), and its
 * writes are committed only when the work resolves (a throw rolls everything
 * back). Mirrors the database rules that matter (hash format, a used
 * recovery code never changes, the CHECK constraints).
 */
export class FakeMfaRepository {
  readonly accounts = new Map<string, FakeMfaAccount>();
  readonly enrollments = new Map<string, MfaEnrollmentState>();
  readonly recoveryCodes = new Map<string, FakeRecoveryCode[]>();
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
      mfaFailedAttemptsAt: [],
      mfaBlockedUntil: null,
      ...overrides,
    };
    this.accounts.set(authId, account);
    return account;
  }

  asRepository(): MfaRepository {
    return this as unknown as MfaRepository;
  }

  unusedCodes(authId: string): FakeRecoveryCode[] {
    return (this.recoveryCodes.get(authId) ?? []).filter((c) => !c.usedAt);
  }

  read(authId: string) {
    this.throwIfFailing();
    const account = this.accounts.get(authId);
    const enrollment = this.enrollments.get(authId);
    return Promise.resolve({
      account: account ? this.publicAccount(account) : null,
      enrollment: enrollment ? cloneEnrollment(enrollment) : null,
      recoveryCodesRemaining: this.unusedCodes(authId).length,
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
    let account = stored ? cloneAccount(stored) : undefined;
    const storedEnrollment = this.enrollments.get(authId);
    let enrollment: MfaEnrollmentState | undefined = storedEnrollment
      ? cloneEnrollment(storedEnrollment)
      : undefined;
    let codes = cloneCodes(this.recoveryCodes.get(authId) ?? []);
    const audits: FakeMfaAudit[] = [];
    const reject = (message: string) => Promise.reject(new Error(message));

    const uow: MfaUnitOfWork = {
      account: () =>
        Promise.resolve(account ? this.publicAccount(account) : null),
      enrollment: () =>
        Promise.resolve(enrollment ? cloneEnrollment(enrollment) : null),
      saveEnrollment: (state) => {
        if ((state.secret === null) !== (state.expiresAt === null)) {
          return reject('MfaEnrollment_pending_secret_expiry_check');
        }
        if (state.failedAttemptsAt.length > 5) {
          return reject('MfaEnrollment_failed_attempts_check');
        }
        enrollment = cloneEnrollment(state);
        return Promise.resolve();
      },
      deleteEnrollment: () => {
        enrollment = undefined;
        return Promise.resolve();
      },
      enableMfa: ({ encryptedSecret, usedStep, metadata }) => {
        if (!account) return reject('no account');
        account = {
          ...account,
          mfaEnabled: true,
          mfaMethod: 'totp',
          mfaSecret: encryptedSecret,
          mfaLastUsedStep: usedStep,
          mfaFailedAttemptsAt: [],
          mfaBlockedUntil: null,
        };
        audits.push({
          authId,
          changes: [
            { fieldName: 'mfaEnabled', oldValue: 'false', newValue: 'true' },
          ],
          metadata,
        });
        return Promise.resolve();
      },
      verificationState: () =>
        Promise.resolve(
          account
            ? {
                mfaSecret: account.mfaSecret,
                mfaLastUsedStep: account.mfaLastUsedStep,
                failedAttemptsAt: [...account.mfaFailedAttemptsAt],
                blockedUntil: account.mfaBlockedUntil,
              }
            : null,
        ),
      saveVerificationLockout: ({ failedAttemptsAt, blockedUntil }) => {
        if (!account) return reject('no account');
        if (failedAttemptsAt.length > 5) {
          return reject('authSecurity_mfaFailedAttemptsAt_check');
        }
        account = {
          ...account,
          mfaFailedAttemptsAt: [...failedAttemptsAt],
          mfaBlockedUntil: blockedUntil,
        };
        return Promise.resolve();
      },
      recordTotpStep: (step) => {
        if (!account) return Promise.resolve(false);
        if (
          account.mfaLastUsedStep !== null &&
          account.mfaLastUsedStep >= step
        ) {
          return Promise.resolve(false);
        }
        account = { ...account, mfaLastUsedStep: step };
        return Promise.resolve(true);
      },
      consumeRecoveryCode: (codeHash, now) => {
        const code = codes.find((c) => c.codeHash === codeHash && !c.usedAt);
        if (!code) return Promise.resolve(false);
        code.usedAt = now;
        return Promise.resolve(true);
      },
      replaceRecoveryCodes: (codeHashes) => {
        if (codeHashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash))) {
          return reject('MfaRecoveryCode_codeHash_check');
        }
        if (new Set(codeHashes).size !== codeHashes.length) {
          return reject('MfaRecoveryCode_codeHash_key');
        }
        codes = codeHashes.map((codeHash) => ({ codeHash, usedAt: null }));
        return Promise.resolve();
      },
      countRecoveryCodes: () =>
        Promise.resolve(codes.filter((c) => !c.usedAt).length),
      audit: (changes, metadata) => {
        audits.push({ authId, changes, metadata });
        return Promise.resolve();
      },
    };

    const result = await work(uow);
    // Commit.
    if (account) this.accounts.set(authId, account);
    if (enrollment) this.enrollments.set(authId, enrollment);
    else this.enrollments.delete(authId);
    this.recoveryCodes.set(authId, codes);
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
