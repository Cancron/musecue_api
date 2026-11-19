import { randomUUID } from 'node:crypto';
import type {
  ActivityLogMetadata,
  FieldChange,
} from '../../src/common/services/activity-log.service';
import type {
  MfaAccountState,
  MfaEnrollmentState,
  MfaRepository,
  MfaUnitOfWork,
  TrustedDeviceInput,
  TrustedDeviceView,
} from '../../src/auth/mfa/mfa.repository';

export interface FakeMfaAccount extends MfaAccountState {
  mfaSecret: string | null;
  mfaLastUsedStep: number | null;
  mfaFailedAttemptsAt: Date[];
  mfaBlockedUntil: Date | null;
}

export interface FakeRecoveryCode {
  id: string;
  codeHash: string;
  usedAt: Date | null;
}

export interface FakeLoginChallenge {
  id: string;
  authId: string;
  tokenHash: string;
  provider: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface FakeTrustedDevice extends TrustedDeviceInput {
  id: string;
  authId: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
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
const cloneAll = <T extends object>(items: T[]) =>
  items.map((item) => ({ ...item }));

const SCRYPT_HASH =
  /^scrypt\$[0-9]{1,2}\$[0-9]{1,2}\$[0-9]\$[A-Za-z0-9_-]{22,}\$[A-Za-z0-9_-]{43}$/;

/**
 * In-memory stand-in for MfaRepository with the same transaction semantics:
 * work on one user runs strictly one at a time (the advisory lock), and its
 * writes are committed only when the work resolves (a throw rolls everything
 * back). Mirrors the database rules that matter (hash formats, a used
 * recovery code never changes, the CHECK constraints).
 */
export class FakeMfaRepository {
  readonly accounts = new Map<string, FakeMfaAccount>();
  readonly enrollments = new Map<string, MfaEnrollmentState>();
  readonly recoveryCodes = new Map<string, FakeRecoveryCode[]>();
  readonly challenges: FakeLoginChallenge[] = [];
  readonly devices: FakeTrustedDevice[] = [];
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

  // ---- Sign-in (outside the lock) ----

  mfaEnabled(authId: string) {
    this.throwIfFailing();
    return Promise.resolve(this.accounts.get(authId)?.mfaEnabled ?? false);
  }

  createLoginChallenge(input: Omit<FakeLoginChallenge, 'id' | 'consumedAt'>) {
    this.throwIfFailing();
    this.challenges.push({ ...input, id: randomUUID(), consumedAt: null });
    return Promise.resolve();
  }

  loginChallengeOwner(tokenHash: string) {
    this.throwIfFailing();
    return Promise.resolve(
      this.challenges.find((c) => c.tokenHash === tokenHash)?.authId ?? null,
    );
  }

  useTrustedDevice(authId: string, tokenHash: string, now: Date) {
    this.throwIfFailing();
    const device = this.devices.find(
      (d) =>
        d.authId === authId &&
        d.tokenHash === tokenHash &&
        !d.revokedAt &&
        d.expiresAt.getTime() > now.getTime(),
    );
    if (!device) return Promise.resolve(null);
    device.lastUsedAt = now;
    return Promise.resolve({ id: device.id });
  }

  listTrustedDevices(authId: string, now: Date): Promise<TrustedDeviceView[]> {
    return Promise.resolve(
      this.devices
        .filter(
          (d) =>
            d.authId === authId &&
            !d.revokedAt &&
            d.expiresAt.getTime() > now.getTime(),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((d) => ({
          id: d.id,
          name: d.name,
          ipAddress: d.ipAddress,
          createdAt: d.createdAt,
          lastUsedAt: d.lastUsedAt,
          expiresAt: d.expiresAt,
        })),
    );
  }

  trustedDeviceIdByToken(authId: string, tokenHash: string) {
    return Promise.resolve(
      this.devices.find((d) => d.authId === authId && d.tokenHash === tokenHash)
        ?.id ?? null,
    );
  }

  revokeTrustedDevice(authId: string, deviceId: string, now: Date) {
    const device = this.devices.find(
      (d) => d.id === deviceId && d.authId === authId,
    );
    if (!device) return Promise.resolve(false);
    device.revokedAt ??= now;
    return Promise.resolve(true);
  }

  // ---- Locked transactions ----

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
    let codes = cloneAll(this.recoveryCodes.get(authId) ?? []);
    const challenges = cloneAll(this.challenges);
    const devices = cloneAll(this.devices);
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
      unusedRecoveryCodes: () =>
        Promise.resolve(
          codes
            .filter((c) => !c.usedAt)
            .map(({ id, codeHash }) => ({ id, codeHash })),
        ),
      markRecoveryCodeUsed: (id, now) => {
        const code = codes.find((c) => c.id === id && !c.usedAt);
        if (!code) return Promise.resolve(false);
        code.usedAt = now;
        return Promise.resolve(true);
      },
      updateMfaSecret: (encryptedSecret) => {
        if (!account) return reject('no account');
        account = { ...account, mfaSecret: encryptedSecret };
        return Promise.resolve();
      },
      replaceRecoveryCodes: (codeHashes) => {
        if (codeHashes.some((hash) => !SCRYPT_HASH.test(hash))) {
          return reject('MfaRecoveryCode_codeHash_check');
        }
        codes = codeHashes.map((codeHash) => ({
          id: randomUUID(),
          codeHash,
          usedAt: null,
        }));
        return Promise.resolve();
      },
      countRecoveryCodes: () =>
        Promise.resolve(codes.filter((c) => !c.usedAt).length),
      audit: (changes, metadata) => {
        audits.push({ authId, changes, metadata });
        return Promise.resolve();
      },
      loginChallenge: (tokenHash) => {
        const c = challenges.find(
          (x) => x.tokenHash === tokenHash && x.authId === authId,
        );
        return Promise.resolve(
          c
            ? {
                id: c.id,
                authId: c.authId,
                provider: c.provider,
                expiresAt: c.expiresAt,
                consumedAt: c.consumedAt,
              }
            : null,
        );
      },
      consumeLoginChallenge: (id, now) => {
        const c = challenges.find(
          (x) =>
            x.id === id &&
            x.authId === authId &&
            !x.consumedAt &&
            x.expiresAt.getTime() > now.getTime(),
        );
        if (!c) return Promise.resolve(false);
        c.consumedAt = now;
        return Promise.resolve(true);
      },
      createTrustedDevice: (input, maxActive) => {
        const device: FakeTrustedDevice = {
          ...input,
          id: randomUUID(),
          authId,
          lastUsedAt: null,
          revokedAt: null,
        };
        devices.push(device);
        const active = devices
          .filter(
            (d) =>
              d.authId === authId &&
              !d.revokedAt &&
              d.expiresAt.getTime() > input.createdAt.getTime(),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        for (const surplus of active.slice(maxActive)) {
          surplus.revokedAt = input.createdAt;
        }
        return Promise.resolve({ id: device.id });
      },
    };

    const result = await work(uow);
    // Commit.
    if (account) this.accounts.set(authId, account);
    if (enrollment) this.enrollments.set(authId, enrollment);
    else this.enrollments.delete(authId);
    this.recoveryCodes.set(authId, codes);
    this.challenges.splice(0, this.challenges.length, ...challenges);
    this.devices.splice(0, this.devices.length, ...devices);
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
