import { localImageStorage } from './support/local-image-storage';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import type { JobExecution } from '../src/infrastructure/jobs/job.types';
import { mock } from 'jest-mock-extended';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Logger } from 'winston';
import { ActivityLogService } from '../src/common/services/activity-log.service';
import type { CustomLoggerService } from '../src/common/services/custom-logger.service';
import type { PrismaService } from '../src/common/services/prisma.service';
import { CreditSettingsService } from '../src/credits/credit-settings.service';
import { CreditUsageService } from '../src/credits/credit-usage.service';
import { CreditWalletService } from '../src/credits/credit-wallet.service';
import { PrivacyExportArchiveService } from '../src/privacy/export/privacy-export-archive.service';
import { PrivacyExportCollectorService } from '../src/privacy/export/privacy-export-collector.service';
import type { PrivacyExportJob } from '../src/privacy/interfaces/privacy-export.interface';
import {
  PRIVACY_EXPORT_FAILURES,
  PRIVACY_EXPORT_RETENTION_MS,
} from '../src/privacy/privacy-export.constants';
import { PrivacyExportService } from '../src/privacy/privacy-export.service';
import { ConfigService } from '@nestjs/config';
import { PrivacyExportDownloadService } from '../src/privacy/download/privacy-export-download.service';
import { PrivacyExportLinkSigner } from '../src/privacy/download/privacy-export-link.signer';
import { PrivacyExportLifecycleService } from '../src/privacy/queues/privacy-export-lifecycle.service';
import { PrivacyExportRetentionService } from '../src/privacy/queues/privacy-export-retention.service';
import { PrivacyExportJobHandler } from '../src/privacy/queues/privacy-export-job.handler';
import type { PrivacyExportQueueService } from '../src/privacy/queues/privacy-export.queue';
import type { PrivateImageStorageService } from '../src/storage/private-image-storage.service';
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
import { daysFrom, givenProPurchased } from './support/subscription-fixtures';

jest.setTimeout(60_000);

/**
 * Reviewed list of every field the archive's JSON documents contain (array
 * items written as `[]`). A change to the exported data must update this list
 * deliberately; credentials and internal references must never be added.
 */
const EXPORTED_FIELDS: Record<string, string[]> = {
  'data/account.json': [
    '.account',
    '.account.createdAt',
    '.account.email',
    '.account.id',
    '.account.provider',
    '.account.role',
    '.account.status',
    '.account.updatedAt',
    '.account.username',
    '.account.verified',
    '.security',
    '.security.lastPasswordChange',
    '.security.mfaEnabled',
    '.security.mfaMethod',
  ],
  'data/credits.json': [
    '.aiUsage',
    '.aiUsage[].chargeNote',
    '.aiUsage[].chargeStatus',
    '.aiUsage[].costUsd',
    '.aiUsage[].creditCostUsdMicros',
    '.aiUsage[].creditsCharged',
    '.aiUsage[].creditsDue',
    '.aiUsage[].creditsExact',
    '.aiUsage[].errorCode',
    '.aiUsage[].id',
    '.aiUsage[].inputTokens',
    '.aiUsage[].model',
    '.aiUsage[].occurredAt',
    '.aiUsage[].operation',
    '.aiUsage[].outcome',
    '.aiUsage[].outputTokens',
    '.aiUsage[].provider',
    '.aiUsage[].runId',
    '.aiUsage[].sessionId',
    '.aiUsage[].totalTokens',
    '.aiUsage[].transactionId',
    '.allocations',
    '.allocations[].amount',
    '.allocations[].expiresAt',
    '.allocations[].grantedAt',
    '.allocations[].id',
    '.allocations[].periodStart',
    '.allocations[].remaining',
    '.allocations[].source',
    '.sessionOverage',
    '.sessionOverage[].initializedAt',
    '.sessionOverage[].overageLimit',
    '.sessionOverage[].overageUsed',
    '.sessionOverage[].reservationRemaining',
    '.sessionOverage[].reservedCredits',
    '.sessionOverage[].sessionId',
    '.transactions',
    '.transactions[].amount',
    '.transactions[].balanceAfter',
    '.transactions[].creditCostUsdMicros',
    '.transactions[].description',
    '.transactions[].entries',
    '.transactions[].entries[].allocationId',
    '.transactions[].entries[].amount',
    '.transactions[].id',
    '.transactions[].occurredAt',
    '.transactions[].overageAmount',
    '.transactions[].sessionId',
    '.transactions[].type',
    '.transactions[].usageCostUsd',
  ],
  'data/email-history.json': [
    '.entries',
    '.entries[].emailStatus',
    '.entries[].emailTo',
    '.entries[].emailType',
    '.entries[].sentAt',
    '.entries[].subject',
  ],
  'data/makeup-history.json': [
    '.aiProcessing',
    '.aiProcessing[].completedAt',
    '.aiProcessing[].createdAt',
    '.aiProcessing[].id',
    '.aiProcessing[].model',
    '.aiProcessing[].operation',
    '.aiProcessing[].provider',
    '.aiProcessing[].sessionId',
    '.aiProcessing[].startedAt',
    '.aiProcessing[].status',
    '.aiProcessing[].stepId',
    '.sessions',
    '.sessions[].completedAt',
    '.sessions[].createdAt',
    '.sessions[].faceAnalysis',
    '.sessions[].faceAnalysis.confidence',
    '.sessions[].faceAnalysis.createdAt',
    '.sessions[].faceAnalysis.faceShape',
    '.sessions[].faceAnalysis.notableFeatures',
    '.sessions[].faceAnalysis.skinTone',
    '.sessions[].faceAnalysis.undertone',
    '.sessions[].guide',
    '.sessions[].guide.completedAt',
    '.sessions[].guide.createdAt',
    '.sessions[].guide.currentStepIndex',
    '.sessions[].guide.id',
    '.sessions[].guide.recommendationId',
    '.sessions[].guide.startedAt',
    '.sessions[].guide.status',
    '.sessions[].guide.steps',
    '.sessions[].guide.steps[].area',
    '.sessions[].guide.steps[].attempts',
    '.sessions[].guide.steps[].attempts[].confidence',
    '.sessions[].guide.steps[].attempts[].createdAt',
    '.sessions[].guide.steps[].attempts[].feedback',
    '.sessions[].guide.steps[].attempts[].id',
    '.sessions[].guide.steps[].attempts[].imageId',
    '.sessions[].guide.steps[].attempts[].result',
    '.sessions[].guide.steps[].attempts[].spokenFeedback',
    '.sessions[].guide.steps[].commonMistake',
    '.sessions[].guide.steps[].completedAt',
    '.sessions[].guide.steps[].estimatedSeconds',
    '.sessions[].guide.steps[].id',
    '.sessions[].guide.steps[].instruction',
    '.sessions[].guide.steps[].personalizedTip',
    '.sessions[].guide.steps[].position',
    '.sessions[].guide.steps[].questions',
    '.sessions[].guide.steps[].questions[].answer',
    '.sessions[].guide.steps[].questions[].createdAt',
    '.sessions[].guide.steps[].questions[].id',
    '.sessions[].guide.steps[].questions[].question',
    '.sessions[].guide.steps[].spokenIntro',
    '.sessions[].guide.steps[].spokenSubsteps',
    '.sessions[].guide.steps[].status',
    '.sessions[].guide.steps[].substeps',
    '.sessions[].guide.steps[].successCriteria',
    '.sessions[].guide.steps[].technique',
    '.sessions[].guide.steps[].title',
    '.sessions[].id',
    '.sessions[].images',
    '.sessions[].images[].createdAt',
    '.sessions[].images[].file',
    '.sessions[].images[].guideStepId',
    '.sessions[].images[].height',
    '.sessions[].images[].id',
    '.sessions[].images[].mimeType',
    '.sessions[].images[].purpose',
    '.sessions[].images[].sizeBytes',
    '.sessions[].images[].source',
    '.sessions[].images[].width',
    '.sessions[].preferences',
    '.sessions[].preferences.createdAt',
    '.sessions[].preferences.desiredEffect',
    '.sessions[].preferences.notes',
    '.sessions[].preferences.occasion',
    '.sessions[].preferences.skillLevel',
    '.sessions[].preferences.timeMinutes',
    '.sessions[].preferences.updatedAt',
    '.sessions[].preferences.vibe',
    '.sessions[].recommendations',
    '.sessions[].recommendations[].createdAt',
    '.sessions[].recommendations[].id',
    '.sessions[].recommendations[].imageUrl',
    '.sessions[].recommendations[].matchScore',
    '.sessions[].recommendations[].name',
    '.sessions[].recommendations[].palette',
    '.sessions[].recommendations[].rank',
    '.sessions[].recommendations[].rationale',
    '.sessions[].recommendations[].savedAt',
    '.sessions[].recommendations[].selectedAt',
    '.sessions[].recommendations[].tagline',
    '.sessions[].status',
    '.sessions[].updatedAt',
  ],
  'data/profile.json': [
    '.avatar',
    '.avatar.externalUrl',
    '.avatar.file',
    '.profile',
    '.profile.bio',
    '.profile.createdAt',
    '.profile.firstName',
    '.profile.lastName',
    '.profile.updatedAt',
  ],
  'data/sign-in-history.json': [
    '.entries',
    '.entries[].action',
    '.entries[].city',
    '.entries[].country',
    '.entries[].createdAt',
    '.entries[].deviceId',
    '.entries[].failureReason',
    '.entries[].ipAddress',
    '.entries[].success',
    '.entries[].userAgent',
  ],
  'data/subscription.json': [
    '.currentStatus',
    '.currentStatus.accessExpiresAt',
    '.currentStatus.accessSource',
    '.currentStatus.hasProAccess',
    '.currentStatus.pro',
    '.currentStatus.pro.active',
    '.currentStatus.pro.billingInterval',
    '.currentStatus.pro.canceledAt',
    '.currentStatus.pro.expiresAt',
    '.currentStatus.pro.startedAt',
    '.currentStatus.status',
    '.currentStatus.trial',
    '.currentStatus.trial.active',
    '.currentStatus.trial.eligible',
    '.currentStatus.trial.expiresAt',
    '.currentStatus.trial.ineligibleReason',
    '.currentStatus.trial.startedAt',
    '.currentStatus.trial.used',
    '.events',
    '.events[].id',
    '.events[].occurredAt',
    '.events[].paymentId',
    '.events[].type',
    '.payments',
    '.payments[].amountCents',
    '.payments[].billingInterval',
    '.payments[].createdAt',
    '.payments[].currency',
    '.payments[].failedAt',
    '.payments[].failureCode',
    '.payments[].id',
    '.payments[].paidAt',
    '.payments[].periodEnd',
    '.payments[].periodStart',
    '.payments[].provider',
    '.payments[].refundedAmountCents',
    '.payments[].refundedAt',
    '.payments[].status',
    '.record',
    '.record.billingInterval',
    '.record.createdAt',
    '.record.paymentProvider',
    '.record.proCanceledAt',
    '.record.proExpiresAt',
    '.record.proStartedAt',
    '.record.status',
    '.record.trialExpiresAt',
    '.record.trialStartedAt',
    '.record.trialUsed',
    '.record.updatedAt',
  ],
};

describeWithDatabase('Personal data export (PostgreSQL)', () => {
  let schema: string;
  let client: PrismaClient;
  let prisma: PrismaService;
  let root: string;
  let exportsService: PrivacyExportService;
  let processor: PrivacyExportJobHandler;
  let exportStorage: PrivacyExportStorageService;
  let images: PrivateImageStorageService;
  let lifecycle: PrivacyExportLifecycleService;
  let downloads: PrivacyExportDownloadService;
  let retention: PrivacyExportRetentionService;
  let wallet: CreditWalletService;
  let credits: CreditUsageService;
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
        {
          connectionString: TEST_DATABASE_URL as string,
          options: `-c search_path=${schema}`,
        },
        { schema },
      ),
    });
    prisma = client as unknown as PrismaService;
    const creditSettings = new CreditSettingsService(
      prisma,
      new ActivityLogService(prisma, mock<CustomLoggerService>()),
      mock<CustomLoggerService>(),
    );
    wallet = new CreditWalletService(prisma, creditSettings);
    credits = new CreditUsageService(prisma, wallet, creditSettings);

    root = await mkdtemp(join(tmpdir(), 'privacy-export-e2e-'));
    process.env.PRIVATE_UPLOAD_DIR = join(root, 'images');
    process.env.PRIVATE_EXPORT_DIR = join(root, 'exports');

    const queue = mock<PrivacyExportQueueService>();
    queue.enqueue.mockImplementation((job) => {
      queued.push(job);
      return Promise.resolve();
    });
    exportStorage = new PrivacyExportStorageService();
    images = localImageStorage();
    const logger = mock<Logger>();
    lifecycle = new PrivacyExportLifecycleService(
      prisma,
      exportStorage,
      logger,
    );
    exportsService = new PrivacyExportService(prisma, queue, lifecycle, logger);
    retention = new PrivacyExportRetentionService(
      prisma,
      lifecycle,
      exportStorage,
      new ConfigService({}),
      logger,
    );
    downloads = new PrivacyExportDownloadService(
      prisma,
      new PrivacyExportLinkSigner(
        new ConfigService({
          PRIVACY_EXPORT_DOWNLOAD_SECRET:
            'e2e-download-signing-secret-0123456789',
        }),
      ),
      exportStorage,
      new ConfigService({}),
    );
    const subscriptions = new SubscriptionAccessService(
      prisma,
      new SubscriptionPlanService(
        prisma,
        new ActivityLogService(prisma, mock<CustomLoggerService>()),
      ),
    );
    processor = new PrivacyExportJobHandler(
      prisma,
      new PrivacyExportArchiveService(
        new PrivacyExportCollectorService(prisma, subscriptions),
        images,
        exportStorage,
      ),
      exportStorage,
      lifecycle,
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

  const runQueuedJob = async (job: PrivacyExportJob, attemptsMade = 0) =>
    processor.process({
      data: job,
      maxAttempts: 3,
      attemptsMade,
      discard: jest.fn(),
    } as unknown as JobExecution<PrivacyExportJob>);

  /** Files stored for an export (a missing directory means none). */
  const exportFiles = async (authId: string, exportId: string) => {
    try {
      return await readdir(join(root, 'exports', authId, exportId));
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return [];
      throw error;
    }
  };

  interface SeededUser {
    id: string;
    email: string;
    username: string;
    sessionId: string;
    imageId: string;
    photo: Buffer;
    photoKey: string;
    avatar: Buffer;
    avatarKey: string;
    /** Credentials and internal references that must never be exported. */
    secrets: string[];
    /** Distinctive values of this user's personal data. */
    markers: string[];
  }

  /** A user with data in every exported area and marked credentials. */
  async function seedUser(label: string): Promise<SeededUser> {
    const tag = randomBytes(4).toString('hex');
    const secrets = {
      password: `$2b$12$${label}-PASSWORD-HASH-${tag}`,
      providerId: `${label}-GOOGLE-SUBJECT-${tag}`,
      mfaSecret: `${label}-MFA-SECRET-${tag}`,
      idempotencyKey: `${label}-IDEMPOTENCY-KEY-${tag}`,
      aiRawResult: `${label}-AI-RAW-RESULT-${tag}`,
      providerSubscriptionId: `sub_${label}_${tag}`,
      smtpMessageId: `${label}-SMTP-MESSAGE-${tag}`,
      emailError: `${label}-SMTP-ERROR-DETAIL-${tag}`,
      creditReference: `${label}-CREDIT-REFERENCE-${tag}`,
      generationId: `${label}-OPENROUTER-GENERATION-${tag}`,
    };
    const email = `${label.toLowerCase()}-${tag}@example.com`;
    const username = `${label.toLowerCase()}_${tag}`;
    const user = await client.authUser.create({
      data: {
        email,
        username,
        password: secrets.password,
        verified: true,
        provider: 'google',
        providerId: secrets.providerId,
        tokenVersion: 7,
      },
    });
    await client.authSecurity.create({
      data: {
        authId: user.id,
        mfaEnabled: true,
        mfaMethod: 'totp',
        mfaSecret: secrets.mfaSecret,
        failedAttempts: 1,
        lastPasswordChange: new Date(),
      },
    });

    const avatar = Buffer.from(`${label}-AVATAR-BYTES-${tag}`);
    const avatarKey = `${user.id}/profile/${randomUUID()}.png`;
    await putImage(avatarKey, avatar);
    await client.userProfile.create({
      data: {
        authId: user.id,
        firstName: `${label}-FIRST-NAME`,
        lastName: `${label}-LAST-NAME`,
        bio: `${label}-BIO-${tag}`,
        avatarUrl: avatarKey,
        avatarStorageProvider: 'local',
      },
    });

    const session = await client.makeupSession.create({
      data: {
        authId: user.id,
        status: 'COMPLETED',
        completedAt: new Date(),
        preferences: {
          create: {
            vibe: 'soft',
            timeMinutes: 15,
            occasion: `${label}-OCCASION`,
            notes: `${label}-PREFERENCE-NOTE-${tag}`,
          },
        },
        faceAnalysis: {
          create: {
            faceShape: 'oval',
            skinTone: 'medium',
            undertone: 'warm',
            notableFeatures: [`${label}-FEATURE`],
            confidence: 0.8,
          },
        },
        recommendations: {
          create: {
            rank: 1,
            name: `${label}-LOOK-NAME`,
            tagline: 'tagline',
            matchScore: 90,
            imageUrl: 'https://cdn.example.com/look.jpg',
            palette: ['#c48f7a'],
            rationale: `${label}-RATIONALE`,
            selectedAt: new Date(),
            savedAt: new Date(),
          },
        },
      },
      include: { recommendations: true },
    });
    const photo = Buffer.from(`${label}-SESSION-PHOTO-BYTES-${tag}`);
    const photoKey = `${user.id}/${session.id}/${randomUUID()}.jpg`;
    await putImage(photoKey, photo);
    const image = await client.imageAsset.create({
      data: {
        sessionId: session.id,
        purpose: 'INITIAL_ANALYSIS',
        source: 'PRIVATE_UPLOAD',
        storageProvider: 'local',
        storageKey: photoKey,
        mimeType: 'image/jpeg',
        width: 800,
        height: 1000,
        sizeBytes: photo.length,
      },
    });
    await client.guide.create({
      data: {
        sessionId: session.id,
        recommendationId: session.recommendations[0].id,
        status: 'COMPLETED',
        steps: {
          create: {
            position: 0,
            status: 'COMPLETED',
            title: `${label}-STEP-TITLE`,
            instruction: 'Apply',
            area: 'face',
            technique: 'pat',
            estimatedSeconds: 60,
            personalizedTip: 'tip',
            commonMistake: 'mistake',
            successCriteria: 'criteria',
            attempts: {
              create: {
                imageId: image.id,
                result: 'PASS',
                feedback: `${label}-STEP-FEEDBACK`,
                confidence: 0.9,
              },
            },
            questions: {
              create: {
                question: `${label}-QUESTION?`,
                answer: `${label}-ANSWER`,
              },
            },
          },
        },
      },
    });
    const run = await client.aiRun.create({
      data: {
        authId: user.id,
        sessionId: session.id,
        operation: 'PERSONALIZATION',
        status: 'COMPLETED',
        promptVersion: 'v1',
        idempotencyKey: secrets.idempotencyKey,
        result: { raw: secrets.aiRawResult },
        usage: { promptTokens: 10 },
      },
    });

    // AI credits: purchased credits, the session's AI request and its charge.
    await wallet.grant({
      authId: user.id,
      source: 'PURCHASE',
      sourceReference: secrets.creditReference,
      amount: '10',
    });
    await wallet.initializeSession({ authId: user.id, sessionId: session.id });
    const usage = await credits.record({
      authId: user.id,
      sessionId: session.id,
      runId: run.id,
      operation: 'PERSONALIZATION',
      provider: 'openrouter',
      model: 'test-model',
      providerRequestId: secrets.generationId,
      outcome: 'SUCCEEDED',
      inputTokens: 1000,
      outputTokens: 250,
      costUsd: '0.0125',
      occurredAt: new Date(),
    });
    await client.$transaction((tx) => credits.chargeRun(tx, usage.id));

    await client.userSubscription.create({
      data: {
        authId: user.id,
        paymentProvider: 'test-provider',
        providerSubscriptionId: secrets.providerSubscriptionId,
      },
    });
    await givenProPurchased(client, user.id, {
      billingInterval: 'MONTHLY',
      startedAt: daysFrom(new Date(), -5),
    });
    const payment = await client.paymentTransaction.findFirstOrThrow({
      where: { subscription: { authId: user.id } },
    });

    await client.loginHistory.create({
      data: {
        authId: user.id,
        ipAddress: label === 'OWNER' ? '203.0.113.5' : '198.51.100.77',
        userAgent: `${label}-USER-AGENT`,
        action: 'login',
        success: true,
      },
    });
    await client.emailHistory.create({
      data: {
        authId: user.id,
        emailTo: email,
        emailType: 'verification',
        subject: 'Verify your email address',
        messageId: secrets.smtpMessageId,
        emailStatus: 'sent',
        sentAt: new Date(),
        errorMessage: secrets.emailError,
      },
    });

    return {
      id: user.id,
      email,
      username,
      sessionId: session.id,
      imageId: image.id,
      photo,
      photoKey,
      avatar,
      avatarKey,
      secrets: [
        ...Object.values(secrets),
        payment.providerPaymentId,
        avatarKey,
        photoKey,
      ],
      markers: [
        user.id,
        email,
        username,
        session.id,
        image.id,
        `${label}-FIRST-NAME`,
        `${label}-BIO-${tag}`,
        `${label}-PREFERENCE-NOTE-${tag}`,
        `${label}-FEATURE`,
        `${label}-LOOK-NAME`,
        `${label}-STEP-TITLE`,
        `${label}-STEP-FEEDBACK`,
        `${label}-QUESTION?`,
        `${label}-ANSWER`,
        `${label}-USER-AGENT`,
        photo.toString('utf8'),
        avatar.toString('utf8'),
      ],
    };
  }

  /** Every key path in a JSON value, with array positions written as []. */
  function keyPaths(value: unknown, prefix = ''): string[] {
    if (Array.isArray(value)) {
      return value.flatMap((item) => keyPaths(item, `${prefix}[]`));
    }
    if (value && typeof value === 'object') {
      return Object.entries(value).flatMap(([key, child]) => [
        `${prefix}.${key}`,
        ...keyPaths(child, `${prefix}.${key}`),
      ]);
    }
    return [];
  }

  it('archives all of the owner’s data and photos, and nothing of anyone else', async () => {
    const owner = await seedUser('OWNER');
    const other = await seedUser('OTHER');
    // The other user also has an export; it must not affect the owner's.
    await exportsService.requestExport(other.id);

    const requested = await exportsService.requestExport(owner.id);
    const job = queued.find((item) => item.exportId === requested.id)!;
    expect(job).toEqual({ exportId: requested.id, authId: owner.id });
    await runQueuedJob(job);

    const status = await exportsService.getExport(owner.id, requested.id);
    expect(status).toMatchObject({
      status: 'COMPLETED',
      progress: 100,
      photoCount: 2,
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
    const archive = await readFile(
      join(root, 'exports', row.storageKey as string),
    );
    expect(Number(row.sizeBytes)).toBe(archive.length);
    const zip = await readZip(archive);
    const doc = <T>(path: string): T =>
      JSON.parse(zip.files.get(path)!.toString('utf8')) as T;

    // --- Required contents -------------------------------------------------
    expect([...zip.names].sort()).toEqual(
      [
        'README.txt',
        'manifest.json',
        'data/account.json',
        'data/profile.json',
        'data/makeup-history.json',
        'data/subscription.json',
        'data/sign-in-history.json',
        'data/email-history.json',
        'data/credits.json',
        'photos/profile/avatar.png',
        `photos/sessions/${owner.sessionId}/${owner.imageId}.jpg`,
      ].sort(),
    );
    // User-owned photos, byte for byte.
    expect(zip.files.get('photos/profile/avatar.png')).toEqual(owner.avatar);
    expect(
      zip.files.get(`photos/sessions/${owner.sessionId}/${owner.imageId}.jpg`),
    ).toEqual(owner.photo);

    const account = doc<{
      account: Record<string, unknown>;
      security: Record<string, unknown>;
    }>('data/account.json');
    expect(account.account).toMatchObject({
      id: owner.id,
      email: owner.email,
      username: owner.username,
      provider: 'google',
    });
    expect(account.security).toMatchObject({
      mfaEnabled: true,
      mfaMethod: 'totp',
    });

    const profile = doc<{
      profile: Record<string, unknown>;
      avatar: Record<string, unknown>;
    }>('data/profile.json');
    expect(profile.profile).toMatchObject({
      firstName: 'OWNER-FIRST-NAME',
      lastName: 'OWNER-LAST-NAME',
    });
    expect(profile.avatar).toEqual({
      file: 'photos/profile/avatar.png',
      externalUrl: null,
    });

    const history = JSON.stringify(doc('data/makeup-history.json'));
    for (const value of [
      owner.sessionId,
      'OWNER-PREFERENCE-NOTE',
      'OWNER-FEATURE',
      'OWNER-LOOK-NAME',
      'OWNER-STEP-TITLE',
      'OWNER-STEP-FEEDBACK',
      'OWNER-QUESTION?',
      'OWNER-ANSWER',
      `photos/sessions/${owner.sessionId}/${owner.imageId}.jpg`,
      'PERSONALIZATION',
    ]) {
      expect(history).toContain(value);
    }

    const subscription = doc<{
      currentStatus: Record<string, unknown>;
      record: Record<string, unknown>;
      payments: Array<Record<string, unknown>>;
      events: Array<Record<string, unknown>>;
    }>('data/subscription.json');
    expect(subscription.currentStatus).toMatchObject({
      status: 'PRO',
      hasProAccess: true,
    });
    expect(subscription.record).toMatchObject({
      status: 'PRO',
      billingInterval: 'MONTHLY',
    });
    expect(subscription.payments).toEqual([
      expect.objectContaining({ status: 'SUCCEEDED', amountCents: 1900 }),
    ]);
    expect(subscription.events).toEqual([
      expect.objectContaining({ type: 'CREATED' }),
    ]);
    expect(
      doc<{ entries: Array<{ userAgent: string }> }>(
        'data/sign-in-history.json',
      ).entries.map((entry) => entry.userAgent),
    ).toEqual(['OWNER-USER-AGENT']);
    expect(
      doc<{ entries: Array<{ emailTo: string }> }>(
        'data/email-history.json',
      ).entries.map((entry) => entry.emailTo),
    ).toEqual([owner.email]);

    const credits = doc<{
      allocations: Array<Record<string, unknown>>;
      transactions: Array<Record<string, unknown>>;
      sessionOverage: Array<Record<string, unknown>>;
      aiUsage: Array<Record<string, unknown>>;
    }>('data/credits.json');
    expect(credits.allocations).toEqual([
      expect.objectContaining({ source: 'PURCHASE', amount: '10' }),
    ]);
    expect(
      credits.transactions.map((t) => [t.type, t.amount, t.sessionId]),
    ).toEqual([
      ['GRANT', '10', null],
      ['DEBIT', '-2.5', owner.sessionId],
    ]);
    expect(credits.sessionOverage).toEqual([
      expect.objectContaining({ sessionId: owner.sessionId }),
    ]);
    expect(credits.aiUsage).toEqual([
      expect.objectContaining({
        sessionId: owner.sessionId,
        inputTokens: 1000,
        outputTokens: 250,
        costUsd: '0.0125',
        creditCostUsdMicros: 5000,
        creditsCharged: '2.5',
      }),
    ]);

    // --- Exactly the reviewed fields, nothing more ---------------------------
    const exported = Object.fromEntries(
      zip.names
        .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
        .map((name) => [name, [...new Set(keyPaths(doc(name)))].sort()]),
    );
    expect(exported).toEqual(EXPORTED_FIELDS);

    // --- Nothing that must stay private -----------------------------------------
    const names = zip.names.join('\n');
    const text = Buffer.concat([...zip.files.values()]).toString('utf8');
    for (const secret of [...owner.secrets, ...other.secrets]) {
      expect(text).not.toContain(secret);
      expect(names).not.toContain(secret);
    }
    for (const marker of other.markers) {
      expect(text).not.toContain(marker);
      expect(names).not.toContain(marker);
    }
    expect(archive.includes(other.photo)).toBe(false);
    expect(archive.includes(other.avatar)).toBe(false);
    const allKeys = Object.values(exported).flat();
    // (AI usage token counts, `inputTokens` etc., are not credentials.)
    expect(
      allKeys.filter((path) =>
        /password(?!Change)|token(?!s$)|secret|storageKey|idempotency|providerId|provider(Payment|Subscription)Id|messageId|errorMessage|failureMessage/i.test(
          path,
        ),
      ),
    ).toEqual([]);

    // Ownership of the export record itself.
    const othersExport = queued.find((item) => item.authId === other.id)!;
    await expect(
      exportsService.getExport(owner.id, othersExport.exportId),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await exportsService.listExports(owner.id)).map((item) => item.id),
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
          error: 'failed',
          errorCode: 'GENERATION_FAILED',
          completedAt: now,
          expiresAt: new Date(now.getTime() - 1),
        },
      }),
    ).rejects.toThrow(/DataExport_expiry_after_completion/);
    // A failed export always says why, only failures have a code, and a
    // failed export never points at an archive.
    await expect(
      client.dataExport.create({
        data: { authId: owner, idempotencyKey: 'no-reason', status: 'FAILED' },
      }),
    ).rejects.toThrow(/DataExport_failed_has_reason/);
    await expect(
      client.dataExport.create({
        data: {
          authId: owner,
          idempotencyKey: 'code-without-failure',
          errorCode: 'INTERRUPTED',
        },
      }),
    ).rejects.toThrow(/DataExport_error_code_only_when_failed/);
    await expect(
      client.dataExport.create({
        data: {
          authId: owner,
          idempotencyKey: 'failed-with-archive',
          status: 'FAILED',
          error: 'failed',
          errorCode: 'GENERATION_FAILED',
          completedAt: now,
          storageKey: `${owner}/x/archive.zip`,
        },
      }),
    ).rejects.toThrow(/DataExport_failed_has_no_archive/);
  });

  it('records a failed export with its reason, deletes its files, and completes a later retry with one archive', async () => {
    const owner = await createUser('hash');
    const session = await client.makeupSession.create({
      data: { authId: owner },
    });
    const photoKey = `${owner}/${session.id}/${randomUUID()}.jpg`;
    await putImage(photoKey, Buffer.from('photo'));
    await client.imageAsset.create({
      data: {
        sessionId: session.id,
        purpose: 'INITIAL_ANALYSIS',
        source: 'PRIVATE_UPLOAD',
        storageProvider: 'local',
        storageKey: photoKey,
        mimeType: 'image/jpeg',
        width: 1,
        height: 1,
        sizeBytes: 5,
      },
    });
    const ioError = () => Object.assign(new Error('EIO'), { code: 'EIO' });

    // 1. Every attempt fails, and its partial archive cannot even be
    //    removed right away: the final failure still cleans up.
    const failing = await exportsService.requestExport(owner);
    const failingJob = queued.find((job) => job.exportId === failing.id)!;
    const read = jest.spyOn(images, 'read').mockRejectedValue(ioError());
    const remove = jest
      .spyOn(exportStorage, 'delete')
      .mockRejectedValue(ioError());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(runQueuedJob(failingJob, attempt)).rejects.toMatchObject({
        code: 'EIO',
      });
    }
    remove.mockRestore();
    read.mockRestore();

    const failed = await client.dataExport.findUniqueOrThrow({
      where: { id: failing.id },
    });
    expect(failed).toMatchObject({
      status: 'FAILED',
      attempts: 3,
      errorCode: 'GENERATION_FAILED',
      error: PRIVACY_EXPORT_FAILURES.GENERATION_FAILED,
      storageKey: null,
    });
    expect(failed.filesDeletedAt).toBeInstanceOf(Date);
    expect(await exportFiles(owner, failing.id)).toEqual([]);
    await expect(
      exportsService.getExport(owner, failing.id),
    ).resolves.toMatchObject({
      status: 'FAILED',
      errorCode: 'GENERATION_FAILED',
      error: PRIVACY_EXPORT_FAILURES.GENERATION_FAILED,
    });
    // Redelivering the failed job creates nothing.
    await runQueuedJob(failingJob);
    expect(await exportFiles(owner, failing.id)).toEqual([]);

    // 2. A new request is not blocked; its first attempt fails, the retry
    //    completes, and exactly one archive remains.
    const retried = await exportsService.requestExport(owner);
    expect(retried.id).not.toBe(failing.id);
    const retryJob = queued.find((job) => job.exportId === retried.id)!;
    jest.spyOn(images, 'read').mockRejectedValueOnce(ioError());
    await expect(runQueuedJob(retryJob, 0)).rejects.toMatchObject({
      code: 'EIO',
    });
    expect(
      await client.dataExport.findUniqueOrThrow({ where: { id: retried.id } }),
    ).toMatchObject({ status: 'QUEUED', errorCode: null, error: null });
    await runQueuedJob(retryJob, 1);
    jest.restoreAllMocks();

    const completed = await client.dataExport.findUniqueOrThrow({
      where: { id: retried.id },
    });
    expect(completed).toMatchObject({ status: 'COMPLETED', attempts: 2 });
    expect(await exportFiles(owner, retried.id)).toEqual([
      completed.storageKey!.split('/').pop(),
    ]);
    // Only one job per export was ever queued.
    expect(
      queued.filter((job) => job.authId === owner).map((job) => job.exportId),
    ).toEqual([failing.id, retried.id]);
  });

  it('downloads a completed archive only for its owner, only with a valid unexpired link', async () => {
    const owner = await createUser('hash');
    const other = await createUser('hash');
    const requested = await exportsService.requestExport(owner);
    await runQueuedJob(queued.find((job) => job.exportId === requested.id)!);
    const row = await client.dataExport.findUniqueOrThrow({
      where: { id: requested.id },
    });
    const archiveOnDisk = await readFile(
      join(root, 'exports', row.storageKey!),
    );
    const issuedAt = new Date();

    // Another user can neither obtain a link nor use the owner's link.
    await expect(
      downloads.createLink(other, requested.id, issuedAt),
    ).rejects.toMatchObject({ status: 404 });
    const link = await downloads.createLink(owner, requested.id, issuedAt);
    expect(new Date(link.expiresAt).getTime()).toBeLessThanOrEqual(
      issuedAt.getTime() + 15 * 60_000,
    );
    const params = new URL(link.url, 'http://api.invalid').searchParams;
    const expires = Number(params.get('expires'));
    const signature = params.get('signature')!;
    await expect(
      downloads.openDownload(other, requested.id, expires, signature, issuedAt),
    ).rejects.toMatchObject({ status: 403 });

    // The owner receives exactly the stored archive.
    const opened = await downloads.openDownload(
      owner,
      requested.id,
      expires,
      signature,
      issuedAt,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of opened.archive.stream) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks)).toEqual(archiveOnDisk);
    expect(opened.sha256).toBe(row.sha256);

    // Once the link expires it is refused, even for the owner.
    await expect(
      downloads.openDownload(
        owner,
        requested.id,
        expires,
        signature,
        new Date(expires * 1000),
      ),
    ).rejects.toMatchObject({ status: 410 });
  });

  it('expires archives 24 hours after export and deletes them in the retention sweep, without any request', async () => {
    const owner = await createUser('hash');
    const other = await createUser('hash');
    const mine = await exportsService.requestExport(owner);
    await runQueuedJob(queued.find((job) => job.exportId === mine.id)!);
    const theirs = await exportsService.requestExport(other);
    await runQueuedJob(queued.find((job) => job.exportId === theirs.id)!);
    // The other user's archive was exported two hours later.
    const theirRow = await client.dataExport.findUniqueOrThrow({
      where: { id: theirs.id },
    });
    await client.dataExport.update({
      where: { id: theirs.id },
      data: {
        completedAt: new Date(theirRow.completedAt!.getTime() + 2 * 3_600_000),
        expiresAt: new Date(theirRow.expiresAt!.getTime() + 2 * 3_600_000),
      },
    });
    const row = await client.dataExport.findUniqueOrThrow({
      where: { id: mine.id },
    });
    expect(row.expiresAt!.getTime() - row.completedAt!.getTime()).toBe(
      PRIVACY_EXPORT_RETENTION_MS,
    );

    // One millisecond before expiry nothing changes.
    await retention.sweep(new Date(row.expiresAt!.getTime() - 1));
    expect(
      await client.dataExport.findUniqueOrThrow({ where: { id: mine.id } }),
    ).toMatchObject({ status: 'COMPLETED', filesDeletedAt: null });
    expect(await exportFiles(owner, mine.id)).toHaveLength(1);

    // At expiry: EXPIRED, files deleted, reference kept.
    const result = await retention.sweep(row.expiresAt!);
    expect(result).toMatchObject({ expired: 1, filesDeleted: 1 });
    const expired = await client.dataExport.findUniqueOrThrow({
      where: { id: mine.id },
    });
    expect(expired).toMatchObject({
      status: 'EXPIRED',
      storageKey: row.storageKey,
      sha256: row.sha256,
    });
    expect(expired.filesDeletedAt).toBeInstanceOf(Date);
    expect(await exportFiles(owner, mine.id)).toEqual([]);
    await expect(
      downloads.createLink(owner, mine.id, row.expiresAt!),
    ).rejects.toMatchObject({ status: 410 });

    // The other user's (later) export is untouched, and repeating is a no-op.
    expect(
      await client.dataExport.findUniqueOrThrow({ where: { id: theirs.id } }),
    ).toMatchObject({ status: 'COMPLETED', filesDeletedAt: null });
    expect(await exportFiles(other, theirs.id)).toHaveLength(1);
    const again = await retention.sweep(row.expiresAt!);
    expect(again).toMatchObject({ expired: 0, filesDeleted: 0 });
    expect(await exportFiles(other, theirs.id)).toHaveLength(1);
  });

  it('enforces that expired exports keep their archive reference', async () => {
    const owner = await createUser('hash');
    const now = new Date();
    await expect(
      client.dataExport.create({
        data: {
          authId: owner,
          idempotencyKey: 'expired-without-reference',
          status: 'EXPIRED',
          completedAt: now,
          expiresAt: new Date(now.getTime() + 1),
        },
      }),
    ).rejects.toThrow(/DataExport_expired_keeps_archive_reference/);
    await expect(
      client.dataExport.create({
        data: {
          authId: owner,
          idempotencyKey: 'deleted-but-active',
          filesDeletedAt: now,
        },
      }),
    ).rejects.toThrow(/DataExport_files_deleted_only_when_terminal/);
  });

  it('still deletes the archive files of a deleted account (storage scan), and only those', async () => {
    const leaving = await createUser('hash');
    const staying = await createUser('hash');
    const gone = await exportsService.requestExport(leaving);
    await runQueuedJob(queued.find((job) => job.exportId === gone.id)!);
    const kept = await exportsService.requestExport(staying);
    await runQueuedJob(queued.find((job) => job.exportId === kept.id)!);

    // Deleting the account cascades to its export records; the files stay.
    await client.authUser.delete({ where: { id: leaving } });
    expect(await exportFiles(leaving, gone.id)).toHaveLength(1);

    // A fresh instance (as after a restart) scans storage on its first sweep.
    const freshInstance = new PrivacyExportRetentionService(
      prisma,
      lifecycle,
      exportStorage,
      new ConfigService({}),
      mock<Logger>(),
    );
    const result = await freshInstance.sweep(
      new Date(Date.now() + 2 * 3_600_000),
    );

    expect(result?.storageScanned).toBe(true);
    expect(result?.storageScopesRemoved).toBe(1);
    expect(await exportFiles(leaving, gone.id)).toEqual([]);
    expect(await exportFiles(staying, kept.id)).toHaveLength(1);
  });

  it('removes export records when the account is deleted', async () => {
    const owner = await createUser('hash');
    await exportsService.requestExport(owner);

    await client.authUser.delete({ where: { id: owner } });

    expect(await client.dataExport.count({ where: { authId: owner } })).toBe(0);
  });
});
