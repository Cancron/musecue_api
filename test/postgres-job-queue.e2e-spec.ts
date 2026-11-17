import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import type { Logger } from 'winston';
import config from '../src/common/config/app.config';
import type { PrismaService } from '../src/common/services/prisma.service';
import { JobHandlerRegistry } from '../src/infrastructure/jobs/job-handler.registry';
import type {
  AbandonedJob,
  JobExecution,
  JobHandler,
  JobRequest,
} from '../src/infrastructure/jobs/job.types';
import {
  PostgresJobDispatcher,
  PostgresJobInspector,
} from '../src/infrastructure/jobs/postgres/postgres-job.dispatcher';
import { PostgresJobStore } from '../src/infrastructure/jobs/postgres/postgres-job.store';
import {
  COMPLETED_JOB_RETENTION_MS,
  FAILED_JOB_RETENTION_MS,
  JOB_LEASE_MS,
  PostgresJobWorker,
} from '../src/infrastructure/jobs/postgres/postgres-job.worker';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  connectToSchema,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';

jest.setTimeout(60_000);

/** A handler whose behaviour each test scripts. */
class ScriptedHandler implements JobHandler<Record<string, unknown>> {
  readonly seen: Array<{
    name: string;
    data: Record<string, unknown>;
    attemptsMade: number;
  }> = [];
  readonly abandoned: Array<AbandonedJob<Record<string, unknown>>> = [];
  behaviour: (job: JobExecution<Record<string, unknown>>) => Promise<void> =
    () => Promise.resolve();

  async process(job: JobExecution<Record<string, unknown>>): Promise<void> {
    this.seen.push({
      name: job.name,
      data: job.data,
      attemptsMade: job.attemptsMade,
    });
    await this.behaviour(job);
  }

  onAbandoned(job: AbandonedJob<Record<string, unknown>>): Promise<void> {
    this.abandoned.push(job);
    return Promise.resolve();
  }
}

describeWithDatabase('PostgreSQL queue driver (REDIS_ENABLED=false)', () => {
  let schema: string;
  let client: PrismaClient;
  let prisma: PrismaService;
  let store: PostgresJobStore;
  let dispatcher: PostgresJobDispatcher;
  let inspector: PostgresJobInspector;
  let email: ScriptedHandler;
  let exports: ScriptedHandler;
  let worker: PostgresJobWorker;
  let now: Date;
  const originalSecret = config.jwt_refresh_secret;

  const request = (
    overrides: Partial<JobRequest<Record<string, unknown>>> = {},
  ): JobRequest<Record<string, unknown>> => ({
    name: 'send-verification',
    data: { email: 'user@example.com', verificationCode: 'A1B2C3' },
    attempts: 3,
    backoff: { type: 'exponential', delayMs: 2_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
    ...overrides,
  });
  const rows = (queue?: string) =>
    client.infrastructureJob.findMany({
      where: queue ? { queue } : {},
      orderBy: { createdAt: 'asc' },
    });
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };

  beforeAll(async () => {
    config.jwt_refresh_secret = 'postgres-queue-e2e-refresh-secret';
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    client = new PrismaClient({
      adapter: new PrismaPg(
        {
          connectionString: TEST_DATABASE_URL as string,
          options: `-c search_path=${schema}`,
        },
        { schema },
      ),
    });
    prisma = client as unknown as PrismaService;
  });

  afterAll(async () => {
    config.jwt_refresh_secret = originalSecret;
    await client?.$disconnect();
    if (schema) await dropSchema(schema);
  });

  beforeEach(async () => {
    await client.infrastructureJob.deleteMany();
    store = new PostgresJobStore(prisma);
    dispatcher = new PostgresJobDispatcher(store);
    inspector = new PostgresJobInspector(store);
    const registry = new JobHandlerRegistry();
    email = new ScriptedHandler();
    exports = new ScriptedHandler();
    registry.register('email', email);
    registry.register('privacy-export', exports);
    registry.onApplicationBootstrap();
    worker = new PostgresJobWorker(
      store,
      registry,
      new ConfigService({ NODE_ENV: 'test' }),
      mock<Logger>(),
    );
    // The worker's clock runs a minute ahead of the real clock that stamps
    // new jobs, so every job dispatched in a test is due.
    now = new Date(Date.now() + 60_000);
    worker.clock = () => now;
    worker.random = () => 0;
  });

  afterEach(() => worker.stop(0));

  it('persists jobs encrypted, bound to their row, and runs them with the handler', async () => {
    await dispatcher.dispatch('email', request());

    const pg = await connectToSchema(schema);
    try {
      const { rows: raw } = await pg.query<{ payload: string }>(
        'SELECT "payload" FROM "InfrastructureJob"',
      );
      expect(raw[0].payload).toMatch(/^v1\./);
      expect(raw[0].payload).not.toContain('A1B2C3');
      expect(raw[0].payload).not.toContain('user@example.com');
    } finally {
      await pg.end();
    }

    await worker.runUntilIdle();

    expect(email.seen).toEqual([
      {
        name: 'send-verification',
        data: { email: 'user@example.com', verificationCode: 'A1B2C3' },
        attemptsMade: 0,
      },
    ]);
    const [done] = await rows('email');
    // Completed: the payload is no longer kept.
    expect(done).toMatchObject({
      status: 'COMPLETED',
      payload: null,
      leaseToken: null,
      attemptsMade: 0,
    });
    expect(done.finishedAt).toEqual(now);
  });

  it('deduplicates jobs by key (like BullMQ jobId), not jobs without one', async () => {
    await dispatcher.dispatch(
      'privacy-export',
      request({ name: 'BUILD_ARCHIVE', jobId: 'export-1' }),
    );
    await dispatcher.dispatch(
      'privacy-export',
      request({ name: 'BUILD_ARCHIVE', jobId: 'export-1' }),
    );
    // The same key in another queue is a different job.
    await dispatcher.dispatch('email', request({ jobId: 'export-1' }));
    await dispatcher.dispatch('email', request());
    await dispatcher.dispatch('email', request());

    expect(await rows('privacy-export')).toHaveLength(1);
    expect(await rows('email')).toHaveLength(3);
  });

  it('runs the highest priority first (lowest number; none before any)', async () => {
    for (const [name, priority] of [
      ['analysis', 10],
      ['question', 1],
      ['guide', 5],
      ['plain', undefined],
    ] as const) {
      await dispatcher.dispatch('email', request({ name, priority }));
      advance(1);
    }

    await worker.runUntilIdle();

    expect(email.seen.map((job) => job.name)).toEqual([
      'plain',
      'question',
      'guide',
      'analysis',
    ]);
  });

  it('never hands the same job to two concurrent claims', async () => {
    for (let index = 0; index < 6; index += 1) {
      await dispatcher.dispatch('email', request({ jobId: `job-${index}` }));
    }

    const [first, second] = await Promise.all([
      store.claim('email', 4, JOB_LEASE_MS, now),
      store.claim('email', 4, JOB_LEASE_MS, now),
    ]);

    const ids = [...first, ...second].map((job) => job.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect(first[0]?.leaseToken).not.toBe(second[0]?.leaseToken);
  });

  it('retries with exponential backoff, then fails with only the error class after the last attempt', async () => {
    await dispatcher.dispatch('email', request());
    email.behaviour = () =>
      Promise.reject(
        Object.assign(new Error('SMTP login for user@example.com failed'), {
          code: 'EAUTH',
        }),
      );

    await worker.runUntilIdle();
    let [job] = await rows('email');
    expect(job).toMatchObject({ status: 'WAITING', attemptsMade: 1 });
    expect(job.availableAt).toEqual(new Date(now.getTime() + 2_000));
    await expect(
      inspector.getJobState('email', job.jobKey ?? ''),
    ).resolves.toBe('unknown');

    // Not due yet.
    advance(1_999);
    await worker.runUntilIdle();
    expect(email.seen).toHaveLength(1);

    advance(1);
    await worker.runUntilIdle();
    [job] = await rows('email');
    expect(job).toMatchObject({ status: 'WAITING', attemptsMade: 2 });
    expect(job.availableAt).toEqual(new Date(now.getTime() + 4_000));

    advance(4_000);
    await worker.runUntilIdle();
    [job] = await rows('email');
    expect(email.seen.map((seen) => seen.attemptsMade)).toEqual([0, 1, 2]);
    expect(job).toMatchObject({
      status: 'FAILED',
      attemptsMade: 3,
      lastError: 'Error (EAUTH)',
    });
    // Failed jobs keep their (encrypted) payload for diagnosis, never a message.
    expect(job.payload).toMatch(/^v1\./);
    expect(JSON.stringify(job)).not.toContain('user@example.com');
  });

  it('fails a discarded job at once', async () => {
    await dispatcher.dispatch('email', request());
    email.behaviour = (job) => {
      job.discard();
      return Promise.reject(new Error('permanent'));
    };

    await worker.runUntilIdle();

    expect(await rows('email')).toEqual([
      expect.objectContaining({ status: 'FAILED', attemptsMade: 1 }),
    ]);
  });

  it('deletes jobs carrying secrets as soon as they finish, whatever the outcome', async () => {
    await dispatcher.dispatch(
      'email',
      request({ jobId: 'ok', removeOnComplete: true, removeOnFail: true }),
    );
    await worker.runUntilIdle();
    await dispatcher.dispatch(
      'email',
      request({
        jobId: 'fails',
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
    email.behaviour = () => Promise.reject(new Error('SMTP down'));
    await worker.runUntilIdle();

    expect(email.seen).toHaveLength(2);
    expect(await rows('email')).toEqual([]);
  });

  it('postpones a rate-limited job without using an attempt, keeping its updated data', async () => {
    await dispatcher.dispatch('email', request({ jobId: 'limited' }));
    email.behaviour = async (job) => {
      if (job.data.deferred) return;
      await job.updateData({ ...job.data, deferred: true });
      throw await job.rateLimit(30_000);
    };

    await worker.runUntilIdle();
    let [job] = await rows('email');
    expect(job).toMatchObject({ status: 'WAITING', attemptsMade: 0 });
    expect(job.availableAt).toEqual(new Date(now.getTime() + 30_000));
    await expect(inspector.getJobState('email', 'limited')).resolves.toBe(
      'delayed',
    );

    advance(30_000);
    await worker.runUntilIdle();
    [job] = await rows('email');
    expect(job.status).toBe('COMPLETED');
    expect(email.seen.map((seen) => seen.data.deferred)).toEqual([
      undefined,
      true,
    ]);
  });

  it('requeues a job whose worker stopped (expired lease), counting the interrupted attempt', async () => {
    await dispatcher.dispatch(
      'privacy-export',
      request({
        name: 'BUILD_ARCHIVE',
        jobId: 'export-1',
        data: { exportId: 'export-1' },
      }),
    );
    // Another worker leased it and then stopped.
    const [lost] = await store.claim('privacy-export', 1, JOB_LEASE_MS, now);
    await expect(
      inspector.getJobState('privacy-export', 'export-1'),
    ).resolves.toBe('active');

    advance(JOB_LEASE_MS - 1);
    await worker.runUntilIdle();
    expect(exports.seen).toHaveLength(0);

    // Recovered as an interrupted attempt, retried after its backoff.
    advance(15_001);
    await worker.runUntilIdle();
    const [requeued] = await rows('privacy-export');
    expect(requeued).toMatchObject({
      status: 'WAITING',
      attemptsMade: 1,
      leaseToken: null,
      lastError: 'LeaseExpired (INTERRUPTED)',
    });
    expect(requeued.availableAt).toEqual(new Date(now.getTime() + 2_000));
    expect(exports.seen).toHaveLength(0);

    advance(2_000);
    await worker.runUntilIdle();
    expect(exports.seen).toEqual([
      {
        name: 'BUILD_ARCHIVE',
        data: { exportId: 'export-1' },
        attemptsMade: 1,
      },
    ]);
    expect(exports.abandoned).toEqual([]);
    // The stopped worker can no longer change the job.
    await expect(store.complete(lost, now)).resolves.toBe(false);
    await expect(store.renewLease(lost, JOB_LEASE_MS, now)).resolves.toBe(
      false,
    );
    expect(await rows('privacy-export')).toEqual([
      expect.objectContaining({ status: 'COMPLETED', attemptsMade: 1 }),
    ]);
  });

  it('fails an interrupted job on its last attempt and hands it to the domain (onAbandoned)', async () => {
    await dispatcher.dispatch(
      'privacy-export',
      request({
        name: 'BUILD_ARCHIVE',
        jobId: 'export-2',
        attempts: 1,
        data: { exportId: 'export-2' },
      }),
    );
    await store.claim('privacy-export', 1, JOB_LEASE_MS, now);

    advance(JOB_LEASE_MS + 1);
    await worker.runUntilIdle();

    expect(exports.seen).toEqual([]);
    expect(exports.abandoned).toEqual([
      {
        id: 'export-2',
        name: 'BUILD_ARCHIVE',
        data: { exportId: 'export-2' },
        reason: 'INTERRUPTED',
      },
    ]);
    expect(await rows('privacy-export')).toEqual([
      expect.objectContaining({
        status: 'FAILED',
        attemptsMade: 1,
        lastError: 'LeaseExpired (INTERRUPTED)',
      }),
    ]);
  });

  it('renews the lease of a long-running job so it is never taken over', async () => {
    await dispatcher.dispatch('email', request({ jobId: 'long' }));
    let finish!: () => void;
    email.behaviour = () => new Promise<void>((resolve) => (finish = resolve));

    await worker.pollOnce();
    const leased = await rows('email');
    expect(leased[0].leaseExpiresAt).toEqual(
      new Date(now.getTime() + JOB_LEASE_MS),
    );

    advance(30_000);
    await worker.renewLeases();
    expect((await rows('email'))[0].leaseExpiresAt).toEqual(
      new Date(now.getTime() + JOB_LEASE_MS),
    );

    finish();
    await worker.runUntilIdle();
    expect((await rows('email'))[0].status).toBe('COMPLETED');
  });

  it('fails a job whose payload was moved from another row', async () => {
    await dispatcher.dispatch(
      'privacy-export',
      request({ jobId: 'a', data: { exportId: 'a' } }),
    );
    await dispatcher.dispatch(
      'privacy-export',
      request({ jobId: 'b', data: { exportId: 'b' } }),
    );
    const [a, b] = await rows('privacy-export');
    await client.infrastructureJob.update({
      where: { id: b.id },
      data: { payload: a.payload },
    });

    await worker.runUntilIdle();

    expect(exports.seen.map((seen) => seen.data)).toEqual([{ exportId: 'a' }]);
    expect(exports.abandoned).toEqual([
      {
        id: 'b',
        name: 'send-verification',
        data: undefined,
        reason: 'UNREADABLE',
      },
    ]);
    expect((await rows('privacy-export')).map((row) => row.status)).toEqual([
      'COMPLETED',
      'FAILED',
    ]);
  });

  it('reports job states and the backlog to recovery and backpressure', async () => {
    await dispatcher.dispatch('email', request({ jobId: 'waiting' }));
    await dispatcher.dispatch(
      'email',
      request({ jobId: 'prioritized', priority: 1 }),
    );
    await expect(inspector.countBacklog('email')).resolves.toBe(2);
    await expect(inspector.getJobState('email', 'waiting')).resolves.toBe(
      'waiting',
    );
    await expect(inspector.getJobState('email', 'prioritized')).resolves.toBe(
      'prioritized',
    );
    await expect(inspector.getJobState('email', 'missing')).resolves.toBe(
      'unknown',
    );

    await worker.runUntilIdle();

    await expect(inspector.countBacklog('email')).resolves.toBe(0);
    await expect(inspector.getJobState('email', 'waiting')).resolves.toBe(
      'completed',
    );
  });

  it('removes completed jobs after an hour and keeps failed jobs for seven days', async () => {
    await dispatcher.dispatch('email', request({ jobId: 'done' }));
    await worker.runUntilIdle();
    await dispatcher.dispatch(
      'email',
      request({ jobId: 'failed', attempts: 1 }),
    );
    email.behaviour = () => Promise.reject(new Error('SMTP down'));
    await worker.runUntilIdle();
    const finishedAt = now;

    const sweep = (at: number) =>
      store.removeFinished(
        new Date(at - COMPLETED_JOB_RETENTION_MS),
        new Date(at - FAILED_JOB_RETENTION_MS),
      );
    await expect(
      sweep(finishedAt.getTime() + COMPLETED_JOB_RETENTION_MS),
    ).resolves.toBe(0);
    await expect(
      sweep(finishedAt.getTime() + COMPLETED_JOB_RETENTION_MS + 1),
    ).resolves.toBe(1);
    expect((await rows('email')).map((row) => row.jobKey)).toEqual(['failed']);
    await expect(
      sweep(finishedAt.getTime() + FAILED_JOB_RETENTION_MS + 1),
    ).resolves.toBe(1);
    expect(await rows('email')).toEqual([]);
  });

  describe('job ownership (account erasure)', () => {
    const createOwner = async () => {
      const tag = Math.random().toString(16).slice(2, 10);
      return client.authUser.create({
        data: {
          email: `owner_${tag}@example.com`,
          username: `owner_${tag}`,
          password: '',
        },
      });
    };

    it('records the owner and deletes every job of an erased account', async () => {
      const owner = await createOwner();
      const bystander = await createOwner();
      await dispatcher.dispatch('email', request({ ownerId: owner.id }));
      await dispatcher.dispatch(
        'email',
        request({ ownerId: owner.id, jobId: 'fails', attempts: 1 }),
      );
      await dispatcher.dispatch('email', request({ ownerId: bystander.id }));
      await dispatcher.dispatch('email', request());
      // One of the owner's jobs fails and would be kept for diagnosis.
      await client.infrastructureJob.updateMany({
        where: { jobKey: 'fails' },
        data: { status: 'FAILED', payload: 'v1.kept', finishedAt: now },
      });
      expect((await rows('email')).map((row) => row.authId).sort()).toEqual(
        [bystander.id, owner.id, owner.id, null].sort(),
      );

      // Account erasure hard-deletes the account row.
      await client.authUser.delete({ where: { id: owner.id } });

      const remaining = await rows('email');
      expect(remaining.map((row) => row.authId).sort()).toEqual(
        [bystander.id, null].sort(),
      );
      await worker.runUntilIdle();
      // Nothing of the erased account was processed.
      expect(email.seen).toHaveLength(2);
    });

    it('refuses a job for an account that no longer exists', async () => {
      const owner = await createOwner();
      await client.authUser.delete({ where: { id: owner.id } });

      await expect(
        dispatcher.dispatch('email', request({ ownerId: owner.id })),
      ).rejects.toMatchObject({ code: 'P2003' });
      expect(await rows('email')).toEqual([]);
    });

    it('lets a running job of an erased account finish without recreating it', async () => {
      const owner = await createOwner();
      await dispatcher.dispatch('email', request({ ownerId: owner.id }));
      let finish!: () => void;
      email.behaviour = () =>
        new Promise<void>((resolve) => (finish = resolve));

      await worker.pollOnce();
      expect(worker.runningCount('email')).toBe(1);
      await client.authUser.delete({ where: { id: owner.id } });
      finish();
      await worker.runUntilIdle();

      // Completing (or failing) the deleted job changes nothing.
      expect(await rows('email')).toEqual([]);
    });
  });
});
