import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { mock } from 'jest-mock-extended';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Logger } from 'winston';
import { AuthService } from '../src/auth/auth.service';
import { AuthUtilsService } from '../src/auth/services/auth-utils.service';
import type { EmailQueueService } from '../src/common/queues/email/email.queue';
import type { ActivityLogService } from '../src/common/services/activity-log.service';
import type { CustomLoggerService } from '../src/common/services/custom-logger.service';
import type { PrismaService } from '../src/common/services/prisma.service';
import { AccountDeletionCodeService } from '../src/privacy/account-deletion/account-deletion-code.service';
import { AccountDeletionRecoveryService } from '../src/privacy/account-deletion/account-deletion-recovery.service';
import { AccountDeletionService } from '../src/privacy/account-deletion/account-deletion.service';
import { AccountErasureService } from '../src/privacy/account-deletion/account-erasure.service';
import { PrivateImageStorageService } from '../src/storage/private-image-storage.service';
import { PrivacyExportStorageService } from '../src/storage/privacy-export-storage.service';
import { FakeRedis } from './support/account-deletion-fakes';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  connectToSchema,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';
import { daysFrom, givenProPurchased } from './support/subscription-fixtures';

jest.setTimeout(120_000);

const PASSWORD = 'correct horse battery staple';
const META = { ip: '203.0.113.1', userAgent: 'e2e' };

/** Tables holding a user's data (directly or through a parent). */
const USER_DATA_TABLES = [
  'authUser',
  'authSecurity',
  'userProfile',
  'loginHistory',
  'emailHistory',
  'MakeupSession',
  'ImageAsset',
  'MakeupPreferences',
  'FaceAnalysis',
  'Recommendation',
  'Guide',
  'GuideStep',
  'StepAttempt',
  'Question',
  'AiRun',
  'UserSubscription',
  'SubscriptionEvent',
  'DataExport',
] as const;

describeWithDatabase('Account erasure (PostgreSQL)', () => {
  let schema: string;
  let client: PrismaClient;
  let prisma: PrismaService;
  let root: string;
  let deletions: AccountDeletionService;
  let erasure: AccountErasureService;
  let recovery: AccountDeletionRecoveryService;
  let images: PrivateImageStorageService;
  let passwordHash: string;
  const emailQueue = mock<EmailQueueService>();
  const env = {
    images: process.env.PRIVATE_UPLOAD_DIR,
    exports: process.env.PRIVATE_EXPORT_DIR,
  };

  beforeAll(async () => {
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    client = new PrismaClient({
      adapter: new PrismaPg(
        { connectionString: TEST_DATABASE_URL as string },
        { schema },
      ),
    });
    prisma = client as unknown as PrismaService;
    root = await mkdtemp(join(tmpdir(), 'account-erasure-e2e-'));
    process.env.PRIVATE_UPLOAD_DIR = join(root, 'images');
    process.env.PRIVATE_EXPORT_DIR = join(root, 'exports');

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
    emailQueue.sendAccountDeletionCode.mockResolvedValue();
    const codes = new AccountDeletionCodeService(redis, utils, emailQueue);
    deletions = new AccountDeletionService(
      prisma,
      auth,
      utils,
      codes,
      mock<Logger>(),
    );
    images = new PrivateImageStorageService();
    erasure = new AccountErasureService(
      prisma,
      auth,
      codes,
      images,
      new PrivacyExportStorageService(),
      mock<Logger>(),
    );
    recovery = new AccountDeletionRecoveryService(
      prisma,
      deletions,
      erasure,
      new ConfigService({ NODE_ENV: 'test' }),
      mock<Logger>(),
    );
    passwordHash = await bcrypt.hash(PASSWORD, 4);
    await client.subscriptionPlan.create({ data: { code: 'PRO' } });
  });

  afterAll(async () => {
    await client?.$disconnect();
    if (schema) await dropSchema(schema);
    if (root) await rm(root, { recursive: true, force: true });
    for (const [key, value] of [
      ['PRIVATE_UPLOAD_DIR', env.images],
      ['PRIVATE_EXPORT_DIR', env.exports],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const putFile = async (rootName: 'images' | 'exports', key: string) => {
    const path = join(root, rootName, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `bytes of ${key}`);
  };
  const filesUnder = async (rootName: 'images' | 'exports', authId: string) => {
    const list = async (dir: string): Promise<string[]> => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        const nested = await Promise.all(
          entries.map((entry) =>
            entry.isDirectory()
              ? list(join(dir, entry.name))
              : Promise.resolve([join(dir, entry.name)]),
          ),
        );
        return nested.flat();
      } catch {
        return [];
      }
    };
    return list(join(root, rootName, authId));
  };

  interface SeededAccount {
    id: string;
    email: string;
    subscriptionId: string;
    paymentId: string;
    sessionId: string;
    photoKey: string;
  }

  /** An account with data in every table, private files and a payment. */
  async function seedAccount(): Promise<SeededAccount> {
    const tag = randomBytes(5).toString('hex');
    const email = `${tag}@example.com`;
    const user = await client.authUser.create({
      data: {
        email,
        username: `user_${tag}`,
        password: passwordHash,
        verified: true,
        authSecurity: { create: { failedAttempts: 0 } },
        loginHistory: {
          create: {
            ipAddress: '203.0.113.9',
            userAgent: 'phone',
            action: 'login',
            success: true,
          },
        },
        emailHistory: {
          create: {
            emailTo: email,
            emailType: 'verification',
            subject: 'Verify',
            messageId: `m-${tag}`,
            emailStatus: 'sent',
          },
        },
      },
    });
    const avatarKey = `${user.id}/profile/${randomUUID()}.png`;
    await putFile('images', avatarKey);
    await client.userProfile.create({
      data: { authId: user.id, firstName: 'First', avatarUrl: avatarKey },
    });

    const session = await client.makeupSession.create({
      data: {
        authId: user.id,
        status: 'COMPLETED',
        preferences: { create: { vibe: 'soft', timeMinutes: 10 } },
        faceAnalysis: {
          create: {
            faceShape: 'oval',
            skinTone: 'medium',
            undertone: 'warm',
            notableFeatures: [],
            confidence: 0.9,
          },
        },
        recommendations: {
          create: {
            rank: 1,
            name: 'Look',
            tagline: 't',
            matchScore: 90,
            imageUrl: 'https://cdn.example.com/look.jpg',
            palette: [],
            rationale: 'r',
          },
        },
      },
      include: { recommendations: true },
    });
    const photoKey = `${user.id}/${session.id}/${randomUUID()}.jpg`;
    await putFile('images', photoKey);
    // A file no row references any more (left by an earlier failure).
    await putFile('images', `${user.id}/${session.id}/${randomUUID()}.jpg`);
    const image = await client.imageAsset.create({
      data: {
        sessionId: session.id,
        purpose: 'INITIAL_ANALYSIS',
        source: 'PRIVATE_UPLOAD',
        storageKey: photoKey,
        mimeType: 'image/jpeg',
        width: 1,
        height: 1,
        sizeBytes: 1,
      },
    });
    const guide = await client.guide.create({
      data: {
        sessionId: session.id,
        recommendationId: session.recommendations[0].id,
        steps: {
          create: {
            position: 0,
            title: 'Step',
            instruction: 'i',
            area: 'face',
            technique: 'pat',
            estimatedSeconds: 10,
            personalizedTip: 'p',
            commonMistake: 'c',
            successCriteria: 's',
            attempts: {
              create: {
                imageId: image.id,
                result: 'PASS',
                feedback: 'f',
                confidence: 1,
              },
            },
            questions: { create: { question: 'q?', answer: 'a' } },
          },
        },
      },
      include: { steps: true },
    });
    await client.aiRun.create({
      data: {
        authId: user.id,
        sessionId: session.id,
        stepId: guide.steps[0].id,
        operation: 'GUIDE_QUESTION',
        promptVersion: 'v1',
        idempotencyKey: `k-${tag}`,
      },
    });

    const exportRow = await client.dataExport.create({
      data: { authId: user.id, idempotencyKey: `e-${tag}` },
    });
    await putFile('exports', `${user.id}/${exportRow.id}/${randomUUID()}.zip`);
    // A temporary file of an interrupted export attempt.
    await putFile(
      'exports',
      `${user.id}/${exportRow.id}/${randomUUID()}.zip.partial`,
    );

    const subscription = await client.userSubscription.create({
      data: { authId: user.id },
    });
    await givenProPurchased(client, user.id, {
      billingInterval: 'MONTHLY',
      startedAt: daysFrom(new Date(), -3),
    });
    const payment = await client.paymentTransaction.findFirstOrThrow({
      where: { subscriptionId: subscription.id },
    });

    await client.activityLogEvent.create({
      data: {
        tableName: 'authUser',
        recordId: user.id,
        action: 'create',
        actionedBy: user.id,
        ipAddress: '203.0.113.9',
        details: {
          create: { fieldName: 'email', oldValue: null, newValue: email },
        },
      },
    });
    await client.activityLogEvent.create({
      data: {
        tableName: 'UserSubscription',
        recordId: subscription.id,
        action: 'update',
        actionedBy: user.id,
      },
    });
    return {
      id: user.id,
      email,
      subscriptionId: subscription.id,
      paymentId: payment.id,
      sessionId: session.id,
      photoKey,
    };
  }

  /** Rows of every user-data table that belong to `authId`. */
  async function userRowCounts(authId: string, subscriptionId: string) {
    const pg = await connectToSchema(schema);
    try {
      const counts: Record<string, number> = {};
      for (const table of USER_DATA_TABLES) {
        const where =
          table === 'authUser'
            ? `"id" = '${authId}'`
            : table === 'SubscriptionEvent'
              ? `"subscriptionId" = '${subscriptionId}'`
              : [
                    'ImageAsset',
                    'MakeupPreferences',
                    'FaceAnalysis',
                    'Recommendation',
                    'Guide',
                  ].includes(table)
                ? `"sessionId" IN (SELECT "id" FROM "MakeupSession" WHERE "authId" = '${authId}')`
                : table === 'GuideStep'
                  ? `"guideId" IN (SELECT g."id" FROM "Guide" g JOIN "MakeupSession" s ON s."id" = g."sessionId" WHERE s."authId" = '${authId}')`
                  : ['StepAttempt', 'Question'].includes(table)
                    ? `"stepId" IN (SELECT st."id" FROM "GuideStep" st JOIN "Guide" g ON g."id" = st."guideId" JOIN "MakeupSession" s ON s."id" = g."sessionId" WHERE s."authId" = '${authId}')`
                    : `"authId" = '${authId}'`;
        const { rows } = await pg.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM "${table}" WHERE ${where}`,
        );
        counts[table] = Number(rows[0].count);
      }
      return counts;
    } finally {
      await pg.end();
    }
  }

  /** Requests the code, confirms with password + code, and returns the request ID. */
  async function acceptDeletion(authId: string): Promise<string> {
    await deletions.requestConfirmationCode(authId);
    const code = emailQueue.sendAccountDeletionCode.mock.calls.at(-1)![2];
    const view = await deletions.requestDeletion(
      authId,
      { password: PASSWORD, code },
      META,
    );
    return view.id;
  }

  it('hard-deletes the account and all its data and files, keeps its payments detached, and leaves everything else untouched', async () => {
    const victim = await seedAccount();
    const bystander = await seedAccount();
    // The victim is an administrator who once changed the shared plan.
    await client.activityLogEvent.create({
      data: {
        tableName: 'SubscriptionPlan',
        recordId: 'PRO',
        action: 'update',
        actionedBy: victim.id,
        ipAddress: '203.0.113.9',
        userAgent: 'admin-browser',
        device: 'laptop',
        details: {
          create: { fieldName: 'trialDays', oldValue: '7', newValue: '14' },
        },
      },
    });
    // A file in the victim's folder that the bystander's record also uses.
    const sharedKey = `${victim.id}/${victim.sessionId}/${randomUUID()}.jpg`;
    await putFile('images', sharedKey);
    const bystanderSession = await client.makeupSession.findFirstOrThrow({
      where: { authId: bystander.id },
    });
    await client.imageAsset.create({
      data: {
        sessionId: bystanderSession.id,
        purpose: 'COMPLETION',
        source: 'PRIVATE_UPLOAD',
        storageKey: sharedKey,
        mimeType: 'image/jpeg',
        width: 1,
        height: 1,
        sizeBytes: 1,
      },
    });
    const paymentBefore = await client.paymentTransaction.findUniqueOrThrow({
      where: { id: victim.paymentId },
    });
    const bystanderBefore = await userRowCounts(
      bystander.id,
      bystander.subscriptionId,
    );
    const bystanderFiles = {
      images: await filesUnder('images', bystander.id),
      exports: await filesUnder('exports', bystander.id),
    };
    const planBefore = await client.subscriptionPlan.findUniqueOrThrow({
      where: { code: 'PRO' },
    });
    expect(
      Object.values(
        await userRowCounts(victim.id, victim.subscriptionId),
      ).every((n) => n > 0),
    ).toBe(true);

    const requestId = await acceptDeletion(victim.id);
    const result = await recovery.resume();

    expect(result.completed).toBe(1);

    // 1. Hard deletion: no row of the account remains in any table.
    expect(await userRowCounts(victim.id, victim.subscriptionId)).toEqual(
      Object.fromEntries(USER_DATA_TABLES.map((table) => [table, 0])),
    );
    // ...including any table with an authId column added in the future.
    const pg = await connectToSchema(schema);
    try {
      const { rows: tables } = await pg.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = '${schema}' AND column_name = 'authId'
            AND table_name <> 'AccountDeletionRequest'`,
      );
      for (const { table_name } of tables) {
        const { rows } = await pg.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM "${table_name}" WHERE "authId" = '${victim.id}'`,
        );
        expect([table_name, rows[0].count]).toEqual([table_name, '0']);
      }
    } finally {
      await pg.end();
    }
    await expect(
      client.activityLogEvent.count({
        where: {
          OR: [
            { recordId: victim.id },
            { recordId: victim.subscriptionId },
            { actionedBy: victim.id },
          ],
        },
      }),
    ).resolves.toBe(0);

    // 2. Payment records are kept: only the link to the deleted subscription
    //    is gone; amount, status and transaction IDs are unchanged.
    const paymentAfter = await client.paymentTransaction.findUniqueOrThrow({
      where: { id: victim.paymentId },
    });
    expect(paymentAfter).toEqual({
      ...paymentBefore,
      subscriptionId: null,
      updatedAt: paymentAfter.updatedAt,
    });

    // 3. Shared records: the plan is untouched; the admin's audit entry stays
    //    without anything that identifies the person.
    await expect(
      client.subscriptionPlan.findUniqueOrThrow({ where: { code: 'PRO' } }),
    ).resolves.toEqual(planBefore);
    const audit = await client.activityLogEvent.findFirstOrThrow({
      where: { tableName: 'SubscriptionPlan', recordId: 'PRO' },
      include: { details: true },
    });
    expect(audit).toMatchObject({
      actionedBy: null,
      ipAddress: null,
      userAgent: null,
      device: null,
      details: [expect.objectContaining({ fieldName: 'trialDays' })],
    });

    // 4. Another account is not affected in any way.
    expect(await userRowCounts(bystander.id, bystander.subscriptionId)).toEqual(
      bystanderBefore,
    );
    await expect(
      client.paymentTransaction.findUniqueOrThrow({
        where: { id: bystander.paymentId },
      }),
    ).resolves.toMatchObject({ subscriptionId: bystander.subscriptionId });
    expect(await filesUnder('images', bystander.id)).toEqual(
      bystanderFiles.images,
    );
    expect(await filesUnder('exports', bystander.id)).toEqual(
      bystanderFiles.exports,
    );

    // 5. Every private file of the account is gone, referenced or not,
    //    including temporary export files; only the shared file is kept.
    expect(await filesUnder('images', victim.id)).toEqual([
      join(root, 'images', sharedKey),
    ]);
    expect(await filesUnder('exports', victim.id)).toEqual([]);

    // 6. The request records every step, and every storage reference.
    const request = await client.accountDeletionRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { files: true },
    });
    expect(request).toMatchObject({
      authId: victim.id,
      status: 'COMPLETED',
      verificationMethod: 'PASSWORD_AND_EMAIL_CODE',
      lastError: null,
      lockedUntil: null,
    });
    for (const step of [
      'accountBlockedAt',
      'sessionsRevokedAt',
      'processingStartedAt',
      'dataErasedAt',
      'filesDeletedAt',
      'completedAt',
    ] as const) {
      expect(request[step]).toBeInstanceOf(Date);
    }
    const byOutcome = (outcome: string) =>
      request.files
        .filter((file) => file.outcome === outcome)
        .map((file) => file.storageKey)
        .sort();
    expect(byOutcome('RETAINED_SHARED')).toEqual([sharedKey]);
    // Photos, avatar and unreferenced photo; archive and temporary file.
    expect(byOutcome('DELETED')).toHaveLength(5);
    expect(
      request.files.every(
        (file) => file.resolvedAt && file.kind !== 'IMAGE_OWNER_DIRECTORY',
      ),
    ).toBe(true);
  });

  it('keeps payment records immutable after they were detached', async () => {
    const victim = await seedAccount();
    const other = await seedAccount();
    await acceptDeletion(victim.id);
    await recovery.resume();

    // Never re-attached or moved, never changed, never deleted.
    await expect(
      client.paymentTransaction.update({
        where: { id: victim.paymentId },
        data: { subscriptionId: other.subscriptionId },
      }),
    ).rejects.toThrow(/subscription cannot change/);
    await expect(
      client.paymentTransaction.update({
        where: { id: victim.paymentId },
        data: { amountCents: 1 },
      }),
    ).rejects.toThrow(/cannot change/);
    await expect(
      client.paymentTransaction.delete({ where: { id: victim.paymentId } }),
    ).rejects.toThrow(/cannot be deleted/);
    // A payment of an existing subscription cannot be detached by hand.
    await expect(
      client.paymentTransaction.update({
        where: { id: other.paymentId },
        data: { subscriptionId: null },
      }),
    ).rejects.toThrow(/subscription cannot change/);
  });

  it('has no foreign key that blocks deleting a user or cascades into shared records', async () => {
    const pg = await connectToSchema(schema);
    try {
      const { rows } = await pg.query<{
        child: string;
        parent: string;
        rule: string;
        column: string;
      }>(
        `SELECT c.relname AS child, p.relname AS parent,
                con.confdeltype AS rule, a.attname AS column
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_class p ON p.oid = con.confrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
          WHERE con.contype = 'f' AND n.nspname = '${schema}'`,
      );
      // Tables whose rows are deleted when a user is deleted (cascade closure).
      const deleted = new Set(['authUser']);
      for (let grew = true; grew; ) {
        grew = false;
        for (const fk of rows) {
          if (
            fk.rule === 'c' &&
            deleted.has(fk.parent) &&
            !deleted.has(fk.child)
          ) {
            deleted.add(fk.child);
            grew = true;
          }
        }
      }
      // Exactly the user's own tables (activity-log entries are detached and
      // handled explicitly, so their details are not in the closure).
      expect([...deleted].sort()).toEqual([...USER_DATA_TABLES].sort());
      // Nothing refuses the deletion (RESTRICT / NO ACTION into deleted rows).
      const blocking = rows.filter(
        (fk) => deleted.has(fk.parent) && ['r', 'a'].includes(fk.rule),
      );
      expect(blocking).toEqual([]);
      // Rows outside the user's data are only detached, never deleted.
      const detached = rows
        .filter(
          (fk) =>
            deleted.has(fk.parent) && fk.rule === 'n' && !deleted.has(fk.child),
        )
        .map((fk) => `${fk.child}.${fk.column}`)
        .sort();
      expect(detached).toEqual([
        'ActivityLogEvent.actionedBy',
        'PaymentTransaction.subscriptionId',
      ]);
      // Shared records are never reachable from a user.
      for (const shared of [
        'SubscriptionPlan',
        'AccountDeletionRequest',
        'AccountDeletionFile',
        'PaymentTransaction',
        'ActivityLogEvent',
      ]) {
        expect(deleted.has(shared)).toBe(false);
      }
    } finally {
      await pg.end();
    }
  });

  it('leaves nothing half-done when the database fails during erasure, and resumes on the next sweep', async () => {
    const victim = await seedAccount();
    const requestId = await acceptDeletion(victim.id);
    const before = await userRowCounts(victim.id, victim.subscriptionId);
    // Simulate a database failure in the middle of the cascade.
    const pg = await connectToSchema(schema);
    await pg.query(`
      CREATE FUNCTION "fail_login_history_delete"() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END; $$;
      CREATE TRIGGER "fail_login_history_delete" BEFORE DELETE ON "loginHistory"
        FOR EACH ROW EXECUTE FUNCTION "fail_login_history_delete"();`);

    const failed = await recovery.resume();

    expect(failed).toMatchObject({ completed: 0, pending: 1 });
    const stuck = await client.accountDeletionRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { files: true },
    });
    // The files were already removed (that step completed), but the data
    // erasure rolled back as a whole: the account still exists, closed, with
    // all its rows, and the request resumes at the data step.
    expect(stuck).toMatchObject({
      status: 'PROCESSING',
      dataErasedAt: null,
      lockedUntil: null,
    });
    expect(stuck.filesDeletedAt).toBeInstanceOf(Date);
    expect(stuck.files.every((file) => file.resolvedAt)).toBe(true);
    expect(stuck.lastError).toEqual(expect.any(String));
    expect(await userRowCounts(victim.id, victim.subscriptionId)).toEqual(
      before,
    );
    await expect(
      client.authUser.findUniqueOrThrow({ where: { id: victim.id } }),
    ).resolves.toMatchObject({ status: 'PENDING_DELETION' });
    expect(await filesUnder('images', victim.id)).toEqual([]);

    await pg.query(
      `DROP TRIGGER "fail_login_history_delete" ON "loginHistory";`,
    );
    await pg.end();
    const resumed = await recovery.resume();

    expect(resumed.completed).toBe(1);
    await expect(
      client.accountDeletionRequest.findUniqueOrThrow({
        where: { id: requestId },
      }),
    ).resolves.toMatchObject({ status: 'COMPLETED', attempts: 2 });
    await expect(
      client.authUser.count({ where: { id: victim.id } }),
    ).resolves.toBe(0);
  });

  it('keeps the account closed and undeleted while a file cannot be removed, and retries from the saved reference', async () => {
    const victim = await seedAccount();
    const requestId = await acceptDeletion(victim.id);
    const before = await userRowCounts(victim.id, victim.subscriptionId);
    // A second adapter over the same root performs the real removals.
    const realStore = new PrivateImageStorageService();
    const removals: string[] = [];
    const remove = jest
      .spyOn(images, 'remove')
      .mockImplementation((key: string) => {
        removals.push(key);
        if (key === victim.photoKey) {
          return Promise.reject(
            Object.assign(new Error('EIO'), { code: 'EIO' }),
          );
        }
        return realStore.remove(key);
      });

    await recovery.resume();

    // Storage: the failing photo is still there; the others were removed.
    const remaining = await filesUnder('images', victim.id);
    expect(remaining).toEqual([join(root, 'images', victim.photoKey)]);
    expect(await filesUnder('exports', victim.id)).toEqual([]);
    // The account is not deleted: it stays closed with all of its data.
    await expect(
      client.authUser.findUniqueOrThrow({ where: { id: victim.id } }),
    ).resolves.toMatchObject({ status: 'PENDING_DELETION' });
    expect(await userRowCounts(victim.id, victim.subscriptionId)).toEqual(
      before,
    );
    const pending = await client.accountDeletionRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { files: true },
    });
    expect(pending).toMatchObject({
      status: 'PROCESSING',
      filesDeletedAt: null,
      dataErasedAt: null,
    });
    expect(pending.referencesRecordedAt).toBeInstanceOf(Date);
    // The reference to the failing file is kept for the retry.
    expect(pending.files.filter((file) => file.resolvedAt === null)).toEqual([
      expect.objectContaining({
        kind: 'PRIVATE_IMAGE',
        storageKey: victim.photoKey,
        attempts: 1,
        lastError: 'Error (EIO)',
      }),
    ]);

    // Storage recovers: only the failed file is removed on the retry.
    remove.mockRestore();
    const retried = jest.spyOn(images, 'remove');
    await recovery.resume();

    expect(retried.mock.calls.map(([key]) => key)).toEqual([victim.photoKey]);
    expect(await filesUnder('images', victim.id)).toEqual([]);
    await expect(
      client.authUser.count({ where: { id: victim.id } }),
    ).resolves.toBe(0);
    await expect(
      client.accountDeletionRequest.findUniqueOrThrow({
        where: { id: requestId },
      }),
    ).resolves.toMatchObject({ status: 'COMPLETED' });
    retried.mockRestore();
    expect(removals).toContain(victim.photoKey);
  });

  it('performs the deletion once, however often or concurrently it is processed', async () => {
    const victim = await seedAccount();
    const requestId = await acceptDeletion(victim.id);

    const outcomes = await Promise.all([
      erasure.process(requestId),
      erasure.process(requestId),
    ]);
    const again = await erasure.process(requestId);

    expect(outcomes.sort()).toEqual(['COMPLETED', 'SKIPPED']);
    expect(again).toBe('SKIPPED');
    await expect(
      client.accountDeletionRequest.findUniqueOrThrow({
        where: { id: requestId },
      }),
    ).resolves.toMatchObject({ status: 'COMPLETED', attempts: 1 });
    await expect(
      client.paymentTransaction.count({ where: { id: victim.paymentId } }),
    ).resolves.toBe(1);
  });
});
