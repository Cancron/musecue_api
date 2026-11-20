import type {
  AccountDeletionRequest,
  AccountDeletionVerification,
  AuthChallengePurpose,
  Prisma,
  RefreshSessionRevocation,
  userStatus,
} from '@prisma/client';
import { mockDeep, type DeepMockProxy } from 'jest-mock-extended';
import { randomUUID } from 'node:crypto';
import type {
  AuthChallengeRepository,
  ChallengeCheck,
  ChallengeOptions,
} from '../../src/auth/state/auth-challenge.repository';
import type {
  NewRefreshSession,
  RefreshSessionRepository,
  StoredRefreshSession,
} from '../../src/auth/state/refresh-session.repository';
import type { PrismaService } from '../../src/common/services/prisma.service';
import {
  RateLimitStore,
  type RateLimitPolicy,
  type RateLimitResult,
} from '../../src/infrastructure/rate-limit/rate-limit.store';
import { TokenVersionCache } from '../../src/infrastructure/token-version/token-version.cache';

/**
 * In-memory stand-ins for account deletion tests.
 *
 * The authentication-state fakes (token-version cache, refresh sessions,
 * one-time codes, rate limits) follow the semantics of the real drivers and
 * honor expiry against Date.now() so tests can move the clock. Outages can be
 * simulated per operation.
 *
 * AccountStore serves the Prisma calls of the deletion flow. Transactions are
 * serialized (like PostgreSQL's row lock on the user) and roll back on error;
 * the store applies the same uniqueness rule as the migration (one open
 * deletion request per account).
 */

/** A token-version cache (like the Redis one) with simulated outages. */
export class FakeTokenVersionCache extends TokenVersionCache {
  private readonly entries = new Map<
    string,
    { value: number; expiresAt: number }
  >();
  /** Operations that fail as if the cache were unreachable. */
  readonly failing = new Set<'get' | 'publish'>();

  raw(userId: string): number | undefined {
    const entry = this.entries.get(userId);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(userId);
      return undefined;
    }
    return entry.value;
  }

  put(userId: string, tokenVersion: number, ttlSeconds = 3600): void {
    this.entries.set(userId, {
      value: tokenVersion,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  remove(userId: string): void {
    this.entries.delete(userId);
  }

  clear(): void {
    this.entries.clear();
    this.failing.clear();
  }

  get(userId: string): Promise<number | null> {
    if (this.failing.has('get')) return Promise.resolve(null);
    return Promise.resolve(this.raw(userId) ?? null);
  }

  fill(userId: string, tokenVersion: number): Promise<void> {
    if (this.raw(userId) === undefined) this.put(userId, tokenVersion);
    return Promise.resolve();
  }

  publish(userId: string, tokenVersion: number): Promise<void> {
    if (this.failing.has('publish')) {
      return Promise.reject(new Error('Token cache unavailable'));
    }
    this.put(userId, tokenVersion);
    return Promise.resolve();
  }

  invalidate(userId: string): Promise<void> {
    this.entries.delete(userId);
    return Promise.resolve();
  }
}

interface FakeSession extends StoredRefreshSession {
  tokenId: string;
  createdAt: Date;
  revokedReason: RefreshSessionRevocation | null;
  rotatedFromId: string | null;
}

/** Refresh sessions with the repository's rotation and revocation rules. */
export class FakeRefreshSessions {
  readonly sessions = new Map<string, FakeSession>();
  /** When set, every write fails as if the database were unreachable. */
  failing = false;

  add(
    authId: string,
    tokenId: string,
    tokenHash = 'hash',
    expiresAt = new Date(Date.now() + 7 * 24 * 3600_000),
    familyId: string = randomUUID(),
  ): void {
    this.sessions.set(tokenId, {
      id: randomUUID(),
      authId,
      familyId,
      tokenId,
      tokenHash,
      expiresAt,
      createdAt: new Date(),
      revokedAt: null,
      revokedReason: null,
      rotatedFromId: null,
    });
  }

  /** Token IDs of the user's sessions that still work. */
  activeOf(authId: string): string[] {
    return [...this.sessions.values()]
      .filter(
        (session) =>
          session.authId === authId &&
          !session.revokedAt &&
          session.expiresAt.getTime() > Date.now(),
      )
      .map((session) => session.tokenId);
  }

  clear(): void {
    this.sessions.clear();
    this.failing = false;
  }

  private guard(): Promise<void> {
    return this.failing
      ? Promise.reject(new Error('Database unavailable'))
      : Promise.resolve();
  }

  private revokeWhere(
    match: (session: FakeSession) => boolean,
    reason: RefreshSessionRevocation,
  ): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (!session.revokedAt && match(session)) {
        session.revokedAt = new Date();
        session.revokedReason = reason;
        count += 1;
      }
    }
    return count;
  }

  asRepository(maxDevicesOverride?: number): RefreshSessionRepository {
    const repository = {
      createForLogin: async (
        session: NewRefreshSession,
        maxDevices: number,
      ) => {
        await this.guard();
        this.add(
          session.authId,
          session.tokenId,
          session.tokenHash,
          session.expiresAt,
          session.familyId,
        );
        const keep = maxDevicesOverride ?? maxDevices;
        const surplus = this.activeOf(session.authId)
          .map((id) => this.sessions.get(id)!)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(keep);
        this.revokeWhere((item) => surplus.includes(item), 'DEVICE_LIMIT');
      },
      find: (tokenId: string) =>
        Promise.resolve(this.sessions.get(tokenId) ?? null),
      rotate: async (
        current: { authId: string; tokenId: string; tokenHash: string },
        next: NewRefreshSession,
      ) => {
        await this.guard();
        const session = this.sessions.get(current.tokenId);
        if (
          !session ||
          session.authId !== current.authId ||
          session.tokenHash !== current.tokenHash ||
          session.revokedAt ||
          session.expiresAt.getTime() <= Date.now()
        ) {
          return false;
        }
        session.revokedAt = new Date();
        session.revokedReason = 'ROTATED';
        // A rotation keeps the sign-in session.
        this.add(
          next.authId,
          next.tokenId,
          next.tokenHash,
          next.expiresAt,
          session.familyId,
        );
        this.sessions.get(next.tokenId)!.rotatedFromId = session.id;
        return true;
      },
      isSessionActive: (authId: string, familyId: string) =>
        Promise.resolve(
          [...this.sessions.values()].some(
            (s) =>
              s.authId === authId &&
              s.familyId === familyId &&
              !s.revokedAt &&
              s.expiresAt.getTime() > Date.now(),
          ),
        ),
      revoke: async (
        authId: string,
        tokenId: string,
        reason: RefreshSessionRevocation,
      ) => {
        await this.guard();
        this.revokeWhere(
          (session) => session.authId === authId && session.tokenId === tokenId,
          reason,
        );
      },
      revokeAll: async (authId: string, reason: RefreshSessionRevocation) => {
        await this.guard();
        return this.revokeWhere((session) => session.authId === authId, reason);
      },
      deleteExpired: () => Promise.resolve(0),
    };
    return repository as unknown as RefreshSessionRepository;
  }
}

interface FakeChallenge {
  code: string;
  attempts: number;
  maxAttempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
}

/** One-time codes with the repository's attempt, expiry and single-use rules. */
export class FakeAuthChallenges {
  readonly challenges = new Map<string, FakeChallenge>();
  /** When set, every call fails as if the database were unreachable. */
  failing = false;

  constructor(private readonly tx?: Prisma.TransactionClient) {}

  clear(): void {
    this.challenges.clear();
    this.failing = false;
  }

  private key(authId: string, purpose: AuthChallengePurpose): string {
    return `${authId}:${purpose}`;
  }

  asRepository(): AuthChallengeRepository {
    const guard = () =>
      this.failing
        ? Promise.reject(new Error('Database unavailable'))
        : Promise.resolve();
    const repository = {
      issue: async (
        authId: string,
        purpose: AuthChallengePurpose,
        code: string,
        options: ChallengeOptions,
      ) => {
        await guard();
        this.challenges.set(this.key(authId, purpose), {
          code,
          attempts: 0,
          maxAttempts: options.maxAttempts,
          expiresAt: options.expiresAt,
          consumedAt: null,
        });
      },
      verify: async (
        authId: string,
        purpose: AuthChallengePurpose,
        code: string,
        options: {
          now?: Date;
          onValid?: (tx: Prisma.TransactionClient) => Promise<void>;
        } = {},
      ): Promise<ChallengeCheck> => {
        await guard();
        const now = options.now ?? new Date();
        const challenge = this.challenges.get(this.key(authId, purpose));
        if (
          !challenge ||
          challenge.consumedAt ||
          challenge.expiresAt.getTime() <= now.getTime() ||
          challenge.attempts >= challenge.maxAttempts
        ) {
          return 'EXPIRED';
        }
        challenge.attempts += 1;
        if (challenge.code !== code) return 'INVALID';
        challenge.consumedAt = now;
        if (options.onValid) {
          try {
            await options.onValid(this.tx as Prisma.TransactionClient);
          } catch (error) {
            challenge.consumedAt = null;
            challenge.attempts -= 1;
            throw error;
          }
        }
        return 'VALID';
      },
      remove: async (authId: string, purpose?: AuthChallengePurpose) => {
        await guard();
        for (const key of [...this.challenges.keys()]) {
          if (
            purpose
              ? key === this.key(authId, purpose)
              : key.startsWith(`${authId}:`)
          ) {
            this.challenges.delete(key);
          }
        }
      },
      deleteExpired: () => Promise.resolve(0),
    };
    return repository as unknown as AuthChallengeRepository;
  }
}

/** Fixed-window rate limits with the PostgreSQL store's semantics. */
export class FakeRateLimits extends RateLimitStore {
  private readonly buckets = new Map<
    string,
    { hits: number; windowExpiresAt: number; blockExpiresAt: number }
  >();

  /** Seeds a counter, e.g. to start a test at the limit. */
  put(key: string, hits: number, ttlSeconds: number): void {
    this.buckets.set(key, {
      hits,
      windowExpiresAt: Date.now() + ttlSeconds * 1000,
      blockExpiresAt: 0,
    });
  }

  remove(key: string): void {
    this.buckets.delete(key);
  }

  clear(): void {
    this.buckets.clear();
  }

  hit(key: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? {
      hits: 0,
      windowExpiresAt: 0,
      blockExpiresAt: 0,
    };
    if (bucket.windowExpiresAt <= now) {
      bucket.hits = 0;
      bucket.windowExpiresAt = now + policy.windowMs;
    }
    bucket.hits += 1;
    if (bucket.blockExpiresAt <= now && bucket.hits > policy.limit) {
      bucket.blockExpiresAt = now + policy.blockMs;
    }
    this.buckets.set(key, bucket);
    const blocked = bucket.blockExpiresAt > now;
    return Promise.resolve({
      totalHits: bucket.hits,
      windowExpiresInMs: bucket.windowExpiresAt - now,
      blocked,
      blockExpiresInMs: blocked ? bucket.blockExpiresAt - now : 0,
    });
  }

  reset(key: string): Promise<void> {
    this.buckets.delete(key);
    return Promise.resolve();
  }
}

export interface StoredUser {
  id: string;
  email: string;
  username: string;
  password: string;
  provider: string;
  status: userStatus;
  tokenVersion: number;
  security: {
    failedAttempts: number;
    lastFailedAt: Date | null;
    lockExpiresAt: Date | null;
  } | null;
}

type Where = Record<string, unknown>;

export class AccountStore {
  users = new Map<string, StoredUser>();
  requests: AccountDeletionRequest[] = [];
  loginHistory: Array<{
    authId: string;
    success: boolean;
    failureReason?: string;
  }> = [];
  readonly prisma: DeepMockProxy<PrismaService> = mockDeep<PrismaService>();
  private queue: Promise<void> = Promise.resolve();
  /** Called at the start of every transaction (for race tests). */
  beforeTransaction: () => Promise<void> = () => Promise.resolve();
  /** Makes the next request insert fail (to test rollback). */
  failNextRequestInsert = false;
  /**
   * Runs after a user lookup has read its (possibly soon stale) row and
   * before it returns it, to reproduce races with concurrent writes.
   */
  onUserLookup: ((id: string) => Promise<void>) | null = null;

  constructor() {
    this.wire();
  }

  reset(): void {
    this.users = new Map();
    this.requests = [];
    this.loginHistory = [];
    this.failNextRequestInsert = false;
    this.beforeTransaction = () => Promise.resolve();
    this.onUserLookup = null;
  }

  addUser(user: Partial<StoredUser> & { id?: string }): StoredUser {
    const id = user.id ?? randomUUID();
    const stored: StoredUser = {
      id,
      email: `${id}@example.com`,
      username: `user_${id.slice(0, 8)}`,
      password: '',
      provider: 'local',
      status: 'ACTIVE',
      tokenVersion: 1,
      security: { failedAttempts: 0, lastFailedAt: null, lockExpiresAt: null },
      ...user,
    };
    this.users.set(id, stored);
    return stored;
  }

  private snapshot() {
    return {
      users: new Map(
        [...this.users].map(([id, user]) => [
          id,
          { ...user, security: user.security && { ...user.security } },
        ]),
      ),
      requests: this.requests.map((request) => ({ ...request })),
    };
  }

  private open(authId: string) {
    return this.requests.filter(
      (request) => request.authId === authId && request.status !== 'COMPLETED',
    );
  }

  private matchesRequest(
    request: AccountDeletionRequest,
    where: Where,
  ): boolean {
    return Object.entries(where).every(([field, expected]) => {
      if (field === 'OR') {
        return (expected as Where[]).some((branch) =>
          this.matchesRequest(request, branch),
        );
      }
      const value = request[field as keyof AccountDeletionRequest];
      if (expected && typeof expected === 'object' && 'in' in expected) {
        return (expected.in as unknown[]).includes(value);
      }
      if (expected && typeof expected === 'object' && 'gt' in expected) {
        return String(value) > String(expected.gt);
      }
      if (expected && typeof expected === 'object' && 'lt' in expected) {
        return (
          value instanceof Date &&
          value.getTime() < (expected.lt as Date).getTime()
        );
      }
      return value === expected;
    });
  }

  private wire(): void {
    const prisma = this.prisma;

    prisma.$transaction.mockImplementation((async (
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => {
      // Requests arrive concurrently (the hook lets tests line them up);
      // the transactions themselves then run one at a time, like
      // PostgreSQL serializing them on the user's row lock.
      await this.beforeTransaction();
      const previous = this.queue;
      let release!: () => void;
      this.queue = new Promise((resolve) => (release = resolve));
      await previous;
      const before = this.snapshot();
      try {
        return await callback(prisma);
      } catch (error) {
        this.users = before.users;
        this.requests = before.requests;
        throw error;
      } finally {
        release();
      }
    }) as never);

    prisma.authUser.findUnique.mockImplementation((async (args: {
      where: { id?: string; email?: string };
    }) => {
      const user = args.where.id
        ? this.users.get(args.where.id)
        : [...this.users.values()].find(
            (item) => item.email === args.where.email,
          );
      if (!user) return null;
      const row = {
        ...user,
        authSecurity: user.security && {
          id: `sec-${user.id}`,
          ...user.security,
        },
      };
      if (this.onUserLookup) await this.onUserLookup(user.id);
      return row;
    }) as never);
    prisma.authUser.findUniqueOrThrow.mockImplementation(((args: {
      where: { id: string };
    }) => {
      const user = this.users.get(args.where.id);
      return user
        ? Promise.resolve({ ...user })
        : Promise.reject(new Error('No authUser found'));
    }) as never);
    prisma.authUser.updateMany.mockImplementation(((args: {
      where: { id: string; status?: userStatus };
      data: { status?: userStatus; tokenVersion?: { increment: number } };
    }) => {
      const user = this.users.get(args.where.id);
      if (!user || (args.where.status && user.status !== args.where.status)) {
        return Promise.resolve({ count: 0 });
      }
      if (args.data.status) user.status = args.data.status;
      if (args.data.tokenVersion) {
        user.tokenVersion += args.data.tokenVersion.increment;
      }
      return Promise.resolve({ count: 1 });
    }) as never);
    prisma.authUser.update.mockImplementation(((args: {
      where: { id: string };
      data: { tokenVersion?: { increment: number } };
    }) => {
      const user = this.users.get(args.where.id);
      if (!user) return Promise.reject(new Error('No authUser found'));
      if (args.data.tokenVersion) {
        user.tokenVersion += args.data.tokenVersion.increment;
      }
      return Promise.resolve({ ...user });
    }) as never);
    prisma.authSecurity.update.mockImplementation(((args: {
      where: { authId: string };
      data: {
        failedAttempts: number;
        lastFailedAt: Date;
        lockExpiresAt?: Date;
      };
    }) => {
      const user = this.users.get(args.where.authId);
      if (!user?.security) return Promise.reject(new Error('No authSecurity'));
      Object.assign(user.security, args.data);
      return Promise.resolve({});
    }) as never);
    prisma.loginHistory.create.mockImplementation(((args: {
      data: { authId: string; success: boolean; failureReason?: string };
    }) => {
      this.loginHistory.push(args.data);
      return Promise.resolve({});
    }) as never);

    prisma.accountDeletionRequest.create.mockImplementation(((args: {
      data: {
        authId: string;
        verificationMethod: AccountDeletionVerification;
        requestedAt: Date;
        accountBlockedAt: Date;
      };
    }) => {
      if (this.failNextRequestInsert) {
        this.failNextRequestInsert = false;
        return Promise.reject(new Error('insert failed'));
      }
      if (this.open(args.data.authId).length) {
        return Promise.reject(
          Object.assign(new Error('Unique constraint failed'), {
            code: 'P2002',
          }),
        );
      }
      const request: AccountDeletionRequest = {
        id: randomUUID(),
        status: 'PENDING',
        sessionsRevokedAt: null,
        processingStartedAt: null,
        filesRecordedAt: null,
        dataErasedAt: null,
        filesDeletedAt: null,
        lockedUntil: null,
        completedAt: null,
        attempts: 0,
        lastError: null,
        updatedAt: new Date(),
        ...args.data,
      };
      this.requests.push(request);
      return Promise.resolve({ ...request });
    }) as never);
    prisma.accountDeletionRequest.findFirst.mockImplementation(((args: {
      where: Where;
    }) =>
      Promise.resolve(
        this.requests.find((request) =>
          this.matchesRequest(request, args.where),
        ) ?? null,
      )) as never);
    prisma.accountDeletionRequest.findMany.mockImplementation(((args: {
      where: Where;
      take?: number;
    }) =>
      Promise.resolve(
        this.requests
          .filter((request) => this.matchesRequest(request, args.where))
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, args.take)
          .map((request) => ({ ...request })),
      )) as never);
    prisma.accountDeletionRequest.findUniqueOrThrow.mockImplementation(((args: {
      where: { id: string };
    }) => {
      const request = this.requests.find((item) => item.id === args.where.id);
      return request
        ? Promise.resolve({ ...request })
        : Promise.reject(new Error('No request found'));
    }) as never);
    const apply = (
      request: AccountDeletionRequest,
      data: Record<string, unknown>,
    ) => {
      for (const [field, value] of Object.entries(data)) {
        const current = request[field as keyof AccountDeletionRequest];
        (request as Record<string, unknown>)[field] =
          value && typeof value === 'object' && 'increment' in value
            ? (current as number) + (value.increment as number)
            : value;
      }
      request.updatedAt = new Date();
    };
    prisma.accountDeletionRequest.update.mockImplementation(((args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const request = this.requests.find((item) => item.id === args.where.id);
      if (!request) return Promise.reject(new Error('No request found'));
      apply(request, args.data);
      return Promise.resolve({ ...request });
    }) as never);
    prisma.accountDeletionRequest.updateMany.mockImplementation(((args: {
      where: Where;
      data: Record<string, unknown>;
    }) => {
      const targets = this.requests.filter((request) =>
        this.matchesRequest(request, args.where),
      );
      for (const request of targets) apply(request, args.data);
      return Promise.resolve({ count: targets.length });
    }) as never);
  }
}
