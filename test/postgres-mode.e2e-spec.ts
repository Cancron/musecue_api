// Must be first: sets REDIS_ENABLED=false (and an unreachable Redis) before
// any application module reads the environment.
import './support/env-postgres-mode';
import Redis from 'ioredis';
import request from 'supertest';
import { REDIS_CLIENT } from '../src/common/modules/redis.module';
import {
  JobDispatcher,
  JobInspector,
} from '../src/infrastructure/jobs/job.types';
import {
  PostgresJobDispatcher,
  PostgresJobInspector,
} from '../src/infrastructure/jobs/postgres/postgres-job.dispatcher';
import { PostgresRateLimitStore } from '../src/infrastructure/rate-limit/postgres-rate-limit.store';
import { RateLimitStore } from '../src/infrastructure/rate-limit/rate-limit.store';
import {
  NoopTokenVersionCache,
  TokenVersionCache,
} from '../src/infrastructure/token-version/token-version.cache';
import { describeWithDatabase } from './support/migrated-schema';
import {
  accountDeletionFlow,
  authenticationFlow,
  bootApplication,
  makeupFlow,
  privacyExportFlow,
  type SignedInUser,
  type TestApplication,
} from './support/infrastructure-flows';

jest.setTimeout(120_000);

/**
 * The complete application with REDIS_ENABLED=false while Redis is
 * unreachable: authentication, email, makeup AI and privacy-export flows run
 * on PostgreSQL only, with the same HTTP contracts as with Redis.
 */
describeWithDatabase('REDIS_ENABLED=false with Redis unreachable (e2e)', () => {
  const connect = jest.spyOn(Redis.prototype, 'connect');
  let ctx: TestApplication;
  let user: SignedInUser;

  beforeAll(async () => {
    connect.mockClear();
    // NODE_ENV=test: the in-process worker must still start on its own
    // (every flow below waits for jobs it processes).
    ctx = await bootApplication();
  });

  afterAll(async () => {
    await ctx?.close();
    connect.mockRestore();
  });

  it('starts with the PostgreSQL drivers and no Redis client', () => {
    expect(() => ctx.get(REDIS_CLIENT)).toThrow();
    expect(ctx.get(JobDispatcher)).toBeInstanceOf(PostgresJobDispatcher);
    expect(ctx.get(JobInspector)).toBeInstanceOf(PostgresJobInspector);
    expect(ctx.get(TokenVersionCache)).toBeInstanceOf(NoopTokenVersionCache);
    expect(ctx.get(RateLimitStore)).toBeInstanceOf(PostgresRateLimitStore);
  });

  it('registers, verifies the email, signs in, rotates and revokes tokens', async () => {
    user = await authenticationFlow(ctx);

    // Emails went through the PostgreSQL queue.
    const jobs = await ctx.client.infrastructureJob.findMany({
      where: { queue: 'email' },
    });
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    expect(jobs.every((job) => job.status === 'COMPLETED')).toBe(true);
    expect(jobs.every((job) => job.payload === null)).toBe(true);
    // Rate limits are counted in PostgreSQL, keyed by hashes only.
    const buckets = await ctx.client.rateLimitBucket.findMany();
    expect(buckets.length).toBeGreaterThan(0);
    expect(JSON.stringify(buckets)).not.toContain(user.email);
    expect(JSON.stringify(buckets)).not.toContain(user.ip);
  });

  it('runs the makeup AI workflow through the PostgreSQL worker', async () => {
    const { runIds } = await makeupFlow(ctx, user);

    const jobs = await ctx.client.infrastructureJob.findMany({
      where: { queue: 'makeup-ai' },
      orderBy: { createdAt: 'asc' },
    });
    // One deduplicated job per run, keyed by the run ID.
    expect(jobs.map((job) => job.jobKey)).toEqual(runIds);
    expect(jobs.map((job) => [job.name, job.priority])).toEqual([
      ['PERSONALIZATION', 10],
      ['GUIDE_GENERATION', 5],
      ['VISION_CHECK', 1],
      ['GUIDE_QUESTION', 1],
    ]);
    expect(jobs.every((job) => job.status === 'COMPLETED')).toBe(true);
  });

  it('builds and serves a privacy export through the PostgreSQL worker', async () => {
    const { exportId } = await privacyExportFlow(ctx, user);

    await expect(
      ctx.client.infrastructureJob.findFirst({
        where: { queue: 'privacy-export', jobKey: exportId },
      }),
    ).resolves.toMatchObject({
      name: 'BUILD_ARCHIVE',
      status: 'COMPLETED',
      maxAttempts: 3,
      backoffDelayMs: 15_000,
    });
  });

  it('applies the route rate limits with the same 429 response', async () => {
    const http = () => request(ctx.app.getHttpServer());
    const ip = '203.0.113.250';
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await http()
        .post('/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: 'nobody@example.com', password: 'wrong-password' });
      statuses.push(response.status);
    }
    // 5 attempts per 15 minutes per client on the login route.
    expect(statuses.slice(0, 5).every((status) => status !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it('deletes the account over HTTP together with its sessions, codes and jobs', async () => {
    const owned = await ctx.client.infrastructureJob.count({
      where: { authId: user.id },
    });
    // Verification and welcome emails, four AI runs and one export.
    expect(owned).toBe(7);

    const left = await accountDeletionFlow(ctx, user);

    expect(left).toEqual({
      user: 0,
      refreshSessions: 0,
      authChallenges: 0,
      aiRuns: 0,
      dataExports: 0,
      infrastructureJobs: 0,
    });
  });

  it('never tried to connect to Redis', () => {
    expect(connect).not.toHaveBeenCalled();
  });
});
