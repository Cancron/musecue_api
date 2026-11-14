import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import type { Job } from 'bullmq';
import { mock } from 'jest-mock-extended';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Logger } from 'winston';
import { ActivityLogService } from '../src/common/services/activity-log.service';
import type { CustomLoggerService } from '../src/common/services/custom-logger.service';
import type { PrismaService } from '../src/common/services/prisma.service';
import { PrivacyExportArchiveService } from '../src/privacy/export/privacy-export-archive.service';
import { PrivacyExportCollectorService } from '../src/privacy/export/privacy-export-collector.service';
import type { PrivacyExportJob } from '../src/privacy/interfaces/privacy-export.interface';
import { PRIVACY_EXPORT_RETENTION_MS } from '../src/privacy/privacy-export.constants';
import { PrivacyExportService } from '../src/privacy/privacy-export.service';
import { PrivacyExportProcessor } from '../src/privacy/queues/privacy-export.processor';
import type { PrivacyExportQueueService } from '../src/privacy/queues/privacy-export.queue';
import { PrivateImageStorageService } from '../src/storage/private-image-storage.service';
import { PrivacyExportStorageService } from '../src/storage/privacy-export-storage.service';
import { SubscriptionAccessService } from '../src/subscription/subscription-access.service';
import { SubscriptionPlanService } from '../src/subscription/subscription-plan.service';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';
import { readZip } from './support/read-zip';

jest.setTimeout(60_000);

const OWNER_PASSWORD_HASH = '$2b$12$E2E-OWNER-PASSWORD-HASH';
const OWNER_MFA_SECRET = 'E2E-OWNER-MFA-SECRET';
const OTHER_NOTE = 'E2E-OTHER-USER-PRIVATE-NOTE';
const OTHER_PHOTO = Buffer.from('E2E-OTHER-USER-PHOTO');
const OWNER_PHOTO = Buffer.from('e2e-owner-photo-bytes');

describeWithDatabase('Personal data export (PostgreSQL)', () => {
  let schema: string;
  let client: PrismaClient;
  let prisma: PrismaService;
  let root: string;
  let exportsService: PrivacyExportService;
  let processor: PrivacyExportProcessor;
  const queued: PrivacyExportJob[] = [];
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

    root = await mkdtemp(join(tmpdir(), 'privacy-export-e2e-'));
    process.env.PRIVATE_UPLOAD_DIR = join(root, 'images');
    process.env.PRIVATE_EXPORT_DIR = join(root, 'exports');

    const queue = mock<PrivacyExportQueueService>();
    queue.enqueue.mockImplementation((job) => {
      queued.push(job);
      return Promise.resolve();
    });
    const exportStorage = new PrivacyExportStorageService();
    const logger = mock<Logger>();
    exportsService = new PrivacyExportService(
      prisma,
      queue,
      exportStorage,
      logger,
    );
    const subscriptions = new SubscriptionAccessService(
      prisma,
      new SubscriptionPlanService(
        prisma,
        new ActivityLogService(prisma, mock<CustomLoggerService>()),
      ),
    );
    processor = new PrivacyExportProcessor(
      prisma,
      new PrivacyExportArchiveService(
        new PrivacyExportCollectorService(prisma, subscriptions),
        new PrivateImageStorageService(),
        exportStorage,
      ),
      exportStorage,
      logger,
    );
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

  const putImage = async (key: string, bytes: Buffer) => {
    const path = join(root, 'images', key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  };

  async function createUser(password: string): Promise<string> {
    const tag = randomBytes(6).toString('hex');
    const user = await client.authUser.create({
      data: {
        email: `${tag}@example.com`,
        username: `user_${tag}`,
        password,
        verified: true,
      },
    });
    return user.id;
  }

  async function createSession(
    authId: string,
    photo: Buffer,
    notes: string,
  ): Promise<{ sessionId: string; imageId: string; storageKey: string }> {
    const session = await client.makeupSession.create({
      data: {
        authId,
        status: 'IMAGE_UPLOADED',
        preferences: { create: { vibe: 'soft', timeMinutes: 15, notes } },
      },
    });
    const storageKey = `${authId}/${session.id}/photo.jpg`;
    await putImage(storageKey, photo);
    const image = await client.imageAsset.create({
      data: {
        sessionId: session.id,
        purpose: 'INITIAL_ANALYSIS',
        source: 'PRIVATE_UPLOAD',
        storageKey,
        mimeType: 'image/jpeg',
        width: 800,
        height: 1000,
        sizeBytes: photo.length,
      },
    });
    return { sessionId: session.id, imageId: image.id, storageKey };
  }

  const runQueuedJob = async (job: PrivacyExportJob) =>
    processor.process({
      data: job,
      opts: { attempts: 3 },
      attemptsMade: 0,
      discard: jest.fn(),
    } as unknown as Job<PrivacyExportJob>);

  it('builds a complete archive of only the owner’s data and records its status', async () => {
    const owner = await createUser(OWNER_PASSWORD_HASH);
    const other = await createUser('E2E-OTHER-PASSWORD-HASH');
    await client.authSecurity.create({
      data: { authId: owner, mfaEnabled: true, mfaSecret: OWNER_MFA_SECRET },
    });
    const mine = await createSession(owner, OWNER_PHOTO, 'Owner note');
    const theirs = await createSession(other, OTHER_PHOTO, OTHER_NOTE);
    await client.aiRun.create({
      data: {
        authId: owner,
        sessionId: mine.sessionId,
        operation: 'PERSONALIZATION',
        promptVersion: 'v1',
        idempotencyKey: 'E2E-OWNER-IDEMPOTENCY-KEY',
      },
    });
    await client.loginHistory.create({
      data: {
        authId: owner,
        ipAddress: '203.0.113.5',
        userAgent: 'e2e',
        action: 'login',
        success: true,
      },
    });
    // Another user's export must not block or affect the owner's.
    await exportsService.requestExport(other);

    const requested = await exportsService.requestExport(owner);
    expect(requested).toMatchObject({ status: 'QUEUED', progress: 0 });
    const job = queued.find((item) => item.exportId === requested.id)!;
    expect(job).toEqual({ exportId: requested.id, authId: owner });

    await runQueuedJob(job);

    const status = await exportsService.getExport(owner, requested.id);
    expect(status).toMatchObject({
      status: 'COMPLETED',
      progress: 100,
      photoCount: 1,
      missingPhotoCount: 0,
      error: null,
    });
    expect(
      new Date(status.expiresAt!).getTime() -
        new Date(status.completedAt!).getTime(),
    ).toBe(PRIVACY_EXPORT_RETENTION_MS);

    const row = await client.dataExport.findUniqueOrThrow({
      where: { id: requested.id },
    });
    expect(row.attempts).toBe(1);
    expect(row.storageKey).toMatch(new RegExp(`^${owner}/${requested.id}/`));
    const archive = await readFile(
      join(root, 'exports', row.storageKey as string),
    );
    expect(Number(row.sizeBytes)).toBe(archive.length);

    const zip = await readZip(archive);
    expect(
      zip.files.get(`photos/sessions/${mine.sessionId}/${mine.imageId}.jpg`),
    ).toEqual(OWNER_PHOTO);
    const account = JSON.parse(
      zip.files.get('data/account.json')!.toString('utf8'),
    ) as { account: { id: string }; security: { mfaEnabled: boolean } };
    expect(account.account.id).toBe(owner);
    expect(account.security.mfaEnabled).toBe(true);
    const history = JSON.parse(
      zip.files.get('data/makeup-history.json')!.toString('utf8'),
    ) as { sessions: Array<{ id: string }> };
    expect(history.sessions.map((session) => session.id)).toEqual([
      mine.sessionId,
    ]);

    const everything = Buffer.concat([...zip.files.values()]).toString('utf8');
    for (const forbidden of [
      OWNER_PASSWORD_HASH,
      OWNER_MFA_SECRET,
      'E2E-OWNER-IDEMPOTENCY-KEY',
      mine.storageKey,
      other,
      theirs.sessionId,
      OTHER_NOTE,
      OTHER_PHOTO.toString('utf8'),
      '"tokenVersion"',
    ]) {
      expect(everything).not.toContain(forbidden);
    }

    // The owner cannot read the other user's export, and vice versa.
    const othersExport = queued.find((item) => item.authId === other)!;
    await expect(
      exportsService.getExport(owner, othersExport.exportId),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await exportsService.listExports(owner)).map((item) => item.id),
    ).toEqual([requested.id]);
  });

  it('lets concurrent requests converge on one active export per user (partial unique index)', async () => {
    const owner = await createUser('hash');

    const results = await Promise.all(
      Array.from({ length: 4 }, () => exportsService.requestExport(owner)),
    );

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(await client.dataExport.count({ where: { authId: owner } })).toBe(1);
    await expect(
      client.dataExport.create({
        data: { authId: owner, idempotencyKey: 'direct-second-active' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('enforces status consistency rules in the database', async () => {
    const owner = await createUser('hash');

    await expect(
      client.dataExport.create({
        data: {
          authId: owner,
          idempotencyKey: 'completed-without-archive',
          status: 'COMPLETED',
          progress: 100,
        },
      }),
    ).rejects.toThrow(/DataExport_completed_has_archive/);
    await expect(
      client.dataExport.create({
        data: { authId: owner, idempotencyKey: 'bad-progress', progress: 101 },
      }),
    ).rejects.toThrow(/DataExport_progress_range/);
    const now = new Date();
    await expect(
      client.dataExport.create({
        data: {
          authId: owner,
          idempotencyKey: 'expiry-before-completion',
          status: 'FAILED',
          completedAt: now,
          expiresAt: new Date(now.getTime() - 1),
        },
      }),
    ).rejects.toThrow(/DataExport_expiry_after_completion/);
  });

  it('removes export records when the account is deleted', async () => {
    const owner = await createUser('hash');
    await exportsService.requestExport(owner);

    await client.authUser.delete({ where: { id: owner } });

    expect(await client.dataExport.count({ where: { authId: owner } })).toBe(0);
  });
});
