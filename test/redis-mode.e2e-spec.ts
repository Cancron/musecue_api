// Must be first: sets REDIS_ENABLED=true and the Redis connection (from
// TEST_REDIS_URL) before any application module reads the environment.
import './support/env-redis-mode';
import request from 'supertest';
import { REDIS_CLIENT } from '../src/common/modules/redis.module';
import { BullMqJobDispatcher } from '../src/infrastructure/jobs/bullmq/bullmq-job.dispatcher';
import {
  JobDispatcher,
  JobInspector,
} from '../src/infrastructure/jobs/job.types';
import { RateLimitStore } from '../src/infrastructure/rate-limit/rate-limit.store';
import { RedisRateLimitStore } from '../src/infrastructure/rate-limit/redis-rate-limit.store';
import {
  RedisTokenVersionCache,
  TokenVersionCache,
} from '../src/infrastructure/token-version/token-version.cache';
import {
  accountDeletionFlow,
  authenticationFlow,
  bootApplication,
  makeupFlow,
  privacyExportFlow,
  type SignedInUser,
  type TestApplication,
} from './support/infrastructure-flows';
import { TEST_DATABASE_URL } from './support/migrated-schema';
import { deleteKeysWithPrefix, TEST_REDIS_URL } from './support/test-redis';

jest.setTimeout(120_000);

const describeWithRedisAndDatabase =
  TEST_DATABASE_URL && TEST_REDIS_URL ? describe : describe.skip;

/**
 * The same flows as the PostgreSQL-only test, with REDIS_ENABLED=true: BullMQ
 * workers, Redis rate limiting and the Redis token-version cache, against a
 * real Redis (TEST_REDIS_URL).
 */
describeWithRedisAndDatabase('REDIS_ENABLED=true with BullMQ (e2e)', () => {
  let ctx: TestApplication;
  let user: SignedInUser;
  let inspector: JobInspector;

  beforeAll(async () => {
    ctx = await bootApplication();
    inspector = ctx.get<JobInspector>(JobInspector);
  });

  afterAll(async () => {
    await ctx?.close();
    await deleteKeysWithPrefix(process.env.REDIS_CACHE_KEY_PREFIX as string);
  });

  it('starts with the Redis and BullMQ drivers', () => {
    expect(ctx.get(REDIS_CLIENT)).toBeDefined();
    expect(ctx.get(JobDispatcher)).toBeInstanceOf(BullMqJobDispatcher);
    expect(ctx.get(TokenVersionCache)).toBeInstanceOf(RedisTokenVersionCache);
    expect(ctx.get(RateLimitStore)).toBeInstanceOf(RedisRateLimitStore);
  });

  it('registers, verifies the email, signs in, rotates and revokes tokens', async () => {
    user = await authenticationFlow(ctx);

    // Nothing went through the PostgreSQL drivers.
    await expect(ctx.client.infrastructureJob.count()).resolves.toBe(0);
    await expect(ctx.client.rateLimitBucket.count()).resolves.toBe(0);
  });

  it('runs the makeup AI workflow through BullMQ', async () => {
    const { runIds } = await makeupFlow(ctx, user);

    for (const runId of runIds) {
      await expect(inspector.getJobState('makeup-ai', runId)).resolves.toBe(
        'completed',
      );
    }
    await expect(inspector.countBacklog('makeup-ai')).resolves.toBe(0);
  });

  it('builds and serves a privacy export through BullMQ', async () => {
    const { exportId } = await privacyExportFlow(ctx, user);

    await expect(
      inspector.getJobState('privacy-export', exportId),
    ).resolves.toBe('completed');
  });

  it('deletes the account over HTTP, with the Redis token-version cache', async () => {
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
    expect(statuses.slice(0, 5).every((status) => status !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});
