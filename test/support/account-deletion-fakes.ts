import type {
  AccountDeletionRequest,
  AccountDeletionVerification,
  userStatus,
} from '@prisma/client';
import { mockDeep, type DeepMockProxy } from 'jest-mock-extended';
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../src/common/services/prisma.service';
import type { RedisService } from '../../src/common/services/redis.service';

/**
 * In-memory stand-ins for account deletion tests.
 *
 * FakeRedis implements the RedisService calls used by authentication
 * (token-version cache, refresh sessions, rate limits) and by deletion codes,
 * honoring TTLs against Date.now() so tests can move the clock. Outages can be
 * simulated per operation.
 *
 * AccountStore serves the Prisma calls of the deletion flow. Transactions are
 * serialized (like PostgreSQL's row lock on the user) and roll back on error;
 * the store applies the same uniqueness rule as the migration (one open
 * deletion request per account).
 */

interface Entry {
  value: string;
  expiresAt: number | null;
}

export class FakeRedis {
  private readonly entries = new Map<string, Entry>();
  /** Operations that fail as if Redis were unreachable. */
  readonly failing = new Set<'set' | 'eval' | 'get' | 'incr'>();

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  raw(key: string): unknown {
    const entry = this.live(key);
    return entry ? (JSON.parse(entry.value) as unknown) : undefined;
  }

  keys(): string[] {
    return [...this.entries.keys()].filter((key) => this.live(key));
  }

  remove(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  put(key: string, value: unknown, ttlSeconds?: number): void {
    this.entries.set(key, {
      value: JSON.stringify(value),
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  /** A RedisService-shaped object backed by this store. */
  asService(): RedisService {
    const service = {
      get: (key: string) => {
        if (this.failing.has('get')) return Promise.resolve(null);
        return Promise.resolve(this.raw(key) ?? null);
      },
      getRequired: (key: string) => {
        if (this.failing.has('get')) {
          return Promise.reject(new Error('Redis unavailable'));
        }
        return Promise.resolve(this.raw(key) ?? null);
      },
      set: (key: string, value: unknown, ttlSeconds?: number) => {
        if (this.failing.has('set')) return Promise.resolve(false);
        this.put(key, value, ttlSeconds);
        return Promise.resolve(true);
      },
      setNX: (key: string, value: unknown, ttlSeconds: number) => {
        if (this.live(key)) return Promise.resolve(false);
        this.put(key, value, ttlSeconds);
        return Promise.resolve(true);
      },
      del: (key: string) => Promise.resolve(this.entries.delete(key) ? 1 : 0),
      exists: (key: string) => Promise.resolve(Boolean(this.live(key))),
      incr: (key: string) => {
        if (this.failing.has('incr')) return Promise.resolve(null);
        const current = Number(this.raw(key) ?? 0) + 1;
        const entry = this.live(key);
        this.entries.set(key, {
          value: JSON.stringify(current),
          expiresAt: entry?.expiresAt ?? null,
        });
        return Promise.resolve(current);
      },
      expire: (key: string, ttlSeconds: number) => {
        const entry = this.live(key);
        if (entry) entry.expiresAt = Date.now() + ttlSeconds * 1000;
        return Promise.resolve(Boolean(entry));
      },
      updateSessionList: (
        key: string,
        jti: string,
        add: boolean,
        ttl: number,
      ) => {
        if (this.failing.has('eval')) {
          return Promise.reject(new Error('Redis unavailable'));
        }
        const sessions = ((this.raw(key) as string[] | undefined) ?? []).filter(
          (value) => value !== jti,
        );
        if (add) sessions.push(jti);
        if (sessions.length) this.put(key, sessions, ttl);
        else this.entries.delete(key);
        return Promise.resolve();
      },
      pruneRefreshSessions: (
        key: string,
        tokenPrefix: string,
        maxDevices: number,
        ttl: number,
      ) => {
        if (this.failing.has('eval')) {
          return Promise.reject(new Error('Redis unavailable'));
        }
        const sessions = (this.raw(key) as string[] | undefined) ?? [];
        if (maxDevices > 0 && sessions.length <= maxDevices) {
          return Promise.resolve();
        }
        const keep = Math.max(0, maxDevices);
        const kept = sessions.slice(sessions.length - keep);
        for (const jti of sessions.slice(0, sessions.length - keep)) {
          this.entries.delete(`${tokenPrefix}${jti}`);
        }
        if (kept.length) this.put(key, kept, ttl);
        else this.entries.delete(key);
        return Promise.resolve();
      },
    };
    return service as unknown as RedisService;
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
        referencesRecordedAt: null,
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
