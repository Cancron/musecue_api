import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { mock } from 'jest-mock-extended';
import { randomBytes } from 'node:crypto';
import type { Logger } from 'winston';
import { AuthService } from '../src/auth/auth.service';
import { AuthUtilsService } from '../src/auth/services/auth-utils.service';
import type { EmailQueueService } from '../src/common/queues/email/email.queue';
import type { ActivityLogService } from '../src/common/services/activity-log.service';
import type { CustomLoggerService } from '../src/common/services/custom-logger.service';
import type { PrismaService } from '../src/common/services/prisma.service';
import { AccountDeletionCodeService } from '../src/privacy/account-deletion/account-deletion-code.service';
import { AccountDeletionService } from '../src/privacy/account-deletion/account-deletion.service';
import { FakeRedis } from './support/account-deletion-fakes';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';

jest.setTimeout(60_000);

const PASSWORD = 'correct horse battery staple';
const META = { ip: '203.0.113.1', userAgent: 'e2e' };

describeWithDatabase('Account deletion requests (PostgreSQL)', () => {
  let schema: string;
  let client: PrismaClient;
  let deletions: AccountDeletionService;
  let passwordHash: string;

  beforeAll(async () => {
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    client = new PrismaClient({
      adapter: new PrismaPg(
        { connectionString: TEST_DATABASE_URL as string },
        { schema },
      ),
    });
    const prisma = client as unknown as PrismaService;
    const redis = new FakeRedis().asService();
    const utils = new AuthUtilsService(redis);
    const auth = new AuthService(
      utils,
      prisma,
      mock<ActivityLogService>(),
      redis,
      mock<EmailQueueService>(),
      mock<CustomLoggerService>(),
    );
    deletions = new AccountDeletionService(
      prisma,
      auth,
      utils,
      new AccountDeletionCodeService(redis, utils, mock<EmailQueueService>()),
      mock<Logger>(),
    );
    passwordHash = await bcrypt.hash(PASSWORD, 4);
  });

  afterAll(async () => {
    await client?.$disconnect();
    if (schema) await dropSchema(schema);
  });

  async function createUser(): Promise<string> {
    const tag = randomBytes(6).toString('hex');
    const user = await client.authUser.create({
      data: {
        email: `${tag}@example.com`,
        username: `user_${tag}`,
        password: passwordHash,
        verified: true,
        authSecurity: { create: {} },
      },
    });
    return user.id;
  }

  it('blocks the account and records the request in one transaction', async () => {
    const authId = await createUser();

    const view = await deletions.requestDeletion(
      authId,
      { password: PASSWORD },
      META,
    );

    expect(
      await client.authUser.findUniqueOrThrow({ where: { id: authId } }),
    ).toMatchObject({ status: 'PENDING_DELETION', tokenVersion: 2 });
    const request = await client.accountDeletionRequest.findUniqueOrThrow({
      where: { id: view.id },
    });
    expect(request).toMatchObject({
      authId,
      status: 'PENDING',
      verificationMethod: 'PASSWORD',
      attempts: 0,
    });
    expect(request.sessionsRevokedAt).toBeInstanceOf(Date);
  });

  it('turns concurrent requests into exactly one deletion (row lock + partial unique index)', async () => {
    const authId = await createUser();

    const views = await Promise.all(
      Array.from({ length: 5 }, () =>
        deletions.requestDeletion(authId, { password: PASSWORD }, META),
      ),
    );

    expect(new Set(views.map((view) => view.id)).size).toBe(1);
    expect(
      await client.accountDeletionRequest.count({ where: { authId } }),
    ).toBe(1);
    expect(
      (await client.authUser.findUniqueOrThrow({ where: { id: authId } }))
        .tokenVersion,
    ).toBe(2);
  });

  it('changes nothing on a wrong password except the failed-attempt counter', async () => {
    const authId = await createUser();

    await expect(
      deletions.requestDeletion(authId, { password: 'wrong' }, META),
    ).rejects.toMatchObject({ status: 403 });

    expect(
      await client.authUser.findUniqueOrThrow({
        where: { id: authId },
        include: { authSecurity: true },
      }),
    ).toMatchObject({
      status: 'ACTIVE',
      tokenVersion: 1,
      authSecurity: { failedAttempts: 1 },
    });
    expect(
      await client.accountDeletionRequest.count({ where: { authId } }),
    ).toBe(0);
  });

  it('allows only one open request per account in the database', async () => {
    const authId = await createUser();
    const now = new Date();
    const open = {
      authId,
      verificationMethod: 'PASSWORD' as const,
      requestedAt: now,
      accountBlockedAt: now,
    };
    await client.accountDeletionRequest.create({ data: open });

    await expect(
      client.accountDeletionRequest.create({ data: open }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('enforces consistent processing status', async () => {
    const authId = await createUser();
    const now = new Date();
    const base = {
      authId,
      verificationMethod: 'PASSWORD' as const,
      requestedAt: now,
      accountBlockedAt: now,
    };

    await expect(
      client.accountDeletionRequest.create({
        data: { ...base, status: 'COMPLETED' },
      }),
    ).rejects.toThrow(/AccountDeletionRequest_completion_consistent/);
    await expect(
      client.accountDeletionRequest.create({
        data: { ...base, status: 'COMPLETED', completedAt: now },
      }),
    ).rejects.toThrow(/AccountDeletionRequest_completion_consistent/);
    await expect(
      client.accountDeletionRequest.create({
        data: { ...base, accountBlockedAt: new Date(now.getTime() - 1) },
      }),
    ).rejects.toThrow(/AccountDeletionRequest_blocked_after_request/);
  });

  it('keeps the request after the account row is deleted (no foreign key), so the deletion can be tracked and resumed', async () => {
    const authId = await createUser();
    const view = await deletions.requestDeletion(
      authId,
      { password: PASSWORD },
      META,
    );

    await client.authUser.delete({ where: { id: authId } });

    expect(
      await client.accountDeletionRequest.findUnique({
        where: { id: view.id },
      }),
    ).toMatchObject({ authId, status: 'PENDING' });
  });

  it('re-blocks a reactivated account and reuses its open request', async () => {
    const authId = await createUser();
    const first = await deletions.requestDeletion(
      authId,
      { password: PASSWORD },
      META,
    );
    await client.authUser.update({
      where: { id: authId },
      data: { status: 'ACTIVE' },
    });

    const again = await deletions.requestDeletion(
      authId,
      { password: PASSWORD },
      META,
    );

    expect(again.id).toBe(first.id);
    expect(
      await client.authUser.findUniqueOrThrow({ where: { id: authId } }),
    ).toMatchObject({ status: 'PENDING_DELETION', tokenVersion: 3 });
    expect(
      await client.accountDeletionRequest.count({ where: { authId } }),
    ).toBe(1);
  });
});
