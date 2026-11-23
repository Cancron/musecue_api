import {
  FakeSupabaseStorage,
  FAKE_SUPABASE,
  unavailable,
} from './support/fake-supabase-storage';
import { SupabaseStorageProvider } from '../src/storage/providers/supabase-storage.provider';
import { LocalFilesystemStorageProvider } from '../src/storage/providers/local-filesystem-storage.provider';
import { localImageStorage } from './support/local-image-storage';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
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
import { AuthService } from '../src/auth/auth.service';
import { AuthUtilsService } from '../src/auth/services/auth-utils.service';
import type { EmailQueueService } from '../src/common/queues/email/email.queue';
import type { CustomLoggerService } from '../src/common/services/custom-logger.service';
import type { PrismaService } from '../src/common/services/prisma.service';
import { AccountDeletionCodeService } from '../src/privacy/account-deletion/account-deletion-code.service';
import { AccountDeletionRecoveryService } from '../src/privacy/account-deletion/account-deletion-recovery.service';
import { AccountDeletionService } from '../src/privacy/account-deletion/account-deletion.service';
import {
  AccountErasureService,
  ERASURE_LEASE_MS,
} from '../src/privacy/account-deletion/account-erasure.service';
import { PrivacyExportArchiveService } from '../src/privacy/export/privacy-export-archive.service';
import { PrivacyExportCollectorService } from '../src/privacy/export/privacy-export-collector.service';
import { PrivacyExportSupersededError } from '../src/privacy/export/privacy-export.errors';
import type { PrivacyExportJob } from '../src/privacy/interfaces/privacy-export.interface';
import { ExportAttempt } from '../src/privacy/queues/privacy-export-attempt';
import { PrivacyExportLifecycleService } from '../src/privacy/queues/privacy-export-lifecycle.service';
import { PrivacyExportJobHandler } from '../src/privacy/queues/privacy-export-job.handler';
import { ActivityLogService } from '../src/common/services/activity-log.service';
import { SubscriptionAccessService } from '../src/subscription/subscription-access.service';
import { SubscriptionPlanService } from '../src/subscription/subscription-plan.service';
import type { JobExecution } from '../src/infrastructure/jobs/job.types';
import {
  PrivateImageStorageService,
  type PrivateObjectRef,
} from '../src/storage/private-image-storage.service';
import { PrivacyExportStorageService } from '../src/storage/privacy-export-storage.service';
import { AuthChallengeRepository } from '../src/auth/state/auth-challenge.repository';
import { RefreshSessionRepository } from '../src/auth/state/refresh-session.repository';
import config from '../src/common/config/app.config';
import { PostgresRateLimitStore } from '../src/infrastructure/rate-limit/postgres-rate-limit.store';
import { NoopTokenVersionCache } from '../src/infrastructure/token-version/token-version.cache';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  connectToSchema,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';
import {
  daysFrom,
  givenProPurchased,
  recordPayment,
  termEnd,
} from './support/subscription-fixtures';
import { ReferralRegistrationService } from '../src/referrals/referral-registration.service';
import { NotificationService } from '../src/notifications/notification.service';

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
  'PaymentCustomer',
  'CheckoutSession',
  'RefreshSession',
  'AuthChallenge',
  'InfrastructureJob',
  'CreditWallet',
  'CreditAllocation',
  'CreditTransaction',
  'CreditLedgerEntry',
  'CreditSessionOverage',
  'CreditAllocationSchedule',
  'AiUsage',
  'DailyRewardClaim',
  'DailyRewardMonthlyTotal',
  'DiscountOfferTarget',
  'DiscountRedemption',
  'Referral',
  'ReferralCode',
  'ReferralMilestoneAward',
  'ReferralProgress',
  'PaymentFingerprint',
  'Notification',
  'NotificationPreference',
  'MakeupCompletion',
  'LoyaltyMissionAward',
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
  let auth: AuthService;
  let codes: AccountDeletionCodeService;
  let exportsStorage: PrivacyExportStorageService;
  let exportProcessor: PrivacyExportJobHandler;
  let workerImages: PrivateImageStorageService;
  let passwordHash: string;
  let originalRefreshSecret: string;
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
        {
          connectionString: TEST_DATABASE_URL as string,
          options: `-c search_path=${schema}`,
        },
        { schema },
      ),
    });
    prisma = client as unknown as PrismaService;
    root = await mkdtemp(join(tmpdir(), 'account-erasure-e2e-'));
    process.env.PRIVATE_UPLOAD_DIR = join(root, 'images');
    process.env.PRIVATE_EXPORT_DIR = join(root, 'exports');

    // Authentication state lives in PostgreSQL (REDIS_ENABLED=false drivers).
    originalRefreshSecret = config.jwt_refresh_secret;
    config.jwt_refresh_secret ||= 'account-erasure-e2e-refresh-secret';
    const utils = new AuthUtilsService(
      new PostgresRateLimitStore(
        prisma,
        new ConfigService({ NODE_ENV: 'test' }),
        mock<Logger>(),
      ),
    );
    const challenges = new AuthChallengeRepository(prisma);
    auth = new AuthService(
      utils,
      prisma,
      mock<ActivityLogService>(),
      new RefreshSessionRepository(prisma),
      challenges,
      new NoopTokenVersionCache(),
      mock<EmailQueueService>(),
      mock<CustomLoggerService>(),
      mock<ReferralRegistrationService>(),
      mock<NotificationService>(),
    );
    emailQueue.sendAccountDeletionCode.mockResolvedValue();
    codes = new AccountDeletionCodeService(challenges, utils, emailQueue);
    deletions = new AccountDeletionService(
      prisma,
      auth,
      utils,
      codes,
      mock<Logger>(),
    );
    images = localImageStorage();
    exportsStorage = new PrivacyExportStorageService();
    erasure = new AccountErasureService(
      prisma,
      auth,
      codes,
      images,
      exportsStorage,
      mock<Logger>(),
    );
    // A real export worker (with its own storage instances, so tests can
    // pause it while it reads a photo).
    workerImages = localImageStorage();
    const workerLogger = mock<Logger>();
    exportProcessor = new PrivacyExportJobHandler(
      prisma,
      new PrivacyExportArchiveService(
        new PrivacyExportCollectorService(
          prisma,
          new SubscriptionAccessService(
            prisma,
            new SubscriptionPlanService(
              prisma,
              new ActivityLogService(prisma, mock<CustomLoggerService>()),
            ),
          ),
        ),
        workerImages,
        exportsStorage,
      ),
      exportsStorage,
      new PrivacyExportLifecycleService(prisma, exportsStorage, workerLogger),
      workerLogger,
      new ConfigService({
        PRIVACY_EXPORT_WORKER_LEASE_MS: '5000',
        PRIVACY_EXPORT_WORKER_HEARTBEAT_MS: '20',
      }),
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
    config.jwt_refresh_secret = originalRefreshSecret;
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
    packageOrderId: string;
  }

  /** An account with data in every table, private files and a payment. */
  async function seedAccount(): Promise<SeededAccount> {
    const tag = randomBytes(5).toString('hex');
    const email = `${tag}@example.com`;
    // The account signs up with this user's referral code.
    const referrer = await client.authUser.create({
      data: {
        email: `referrer_${tag}@example.com`,
        username: `referrer_${tag}`,
        password: 'not-a-real-hash',
      },
    });
    const user = await client.authUser.create({
      data: {
        email,
        username: `user_${tag}`,
        referral: { create: { referrerAuthId: referrer.id } },
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
        // Authentication state: a signed-in device and an outstanding code.
        refreshSessions: {
          create: {
            tokenId: `jti-${tag}`,
            tokenHash: 'a'.repeat(64),
            ipAddress: '203.0.113.9',
            userAgent: 'phone',
            expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
          },
        },
        authChallenges: {
          create: {
            purpose: 'EMAIL_VERIFICATION',
            codeHash: 'b'.repeat(64),
            maxAttempts: 5,
            expiresAt: new Date(Date.now() + 3600_000),
          },
        },
        // A background job of the PostgreSQL queue driver (a failed email
        // kept for diagnosis).
        infrastructureJobs: {
          create: {
            id: randomUUID(),
            queue: 'email',
            name: 'send-verification',
            payload: 'v1.encrypted',
            status: 'FAILED',
            attemptsMade: 3,
            maxAttempts: 3,
            finishedAt: new Date(),
          },
        },
      },
    });
    const avatarKey = `${user.id}/profile/${randomUUID()}.png`;
    await putFile('images', avatarKey);
    await client.userProfile.create({
      data: {
        authId: user.id,
        firstName: 'First',
        avatarUrl: avatarKey,
        avatarStorageProvider: 'local',
      },
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
        storageProvider: 'local',
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
    // The session was completed step by step: a verified completion, which
    // earned a loyalty mission (shared configuration, kept on erasure).
    const sessionCompletedAt = new Date(Date.now() - 60_000);
    await client.guideStep.update({
      where: { id: guide.steps[0].id },
      data: { status: 'COMPLETED', completedAt: sessionCompletedAt },
    });
    await client.guide.update({
      where: { id: guide.id },
      data: { status: 'COMPLETED', completedAt: sessionCompletedAt },
    });
    await client.makeupSession.update({
      where: { id: session.id },
      data: { status: 'COMPLETED', completedAt: sessionCompletedAt },
    });
    const loyaltyMission = await client.loyaltyMission.create({
      data: {
        title: 'First look',
        recurrence: 'ONCE',
        requiredCompletions: 1,
        rewardCredits: 10,
        startsAt: new Date(sessionCompletedAt.getTime() - 60_000),
      },
    });
    await client.makeupCompletion.create({
      data: {
        sessionId: session.id,
        authId: user.id,
        completedAt: sessionCompletedAt,
      },
    });
    await client.loyaltyMissionAward.create({
      data: {
        missionId: loyaltyMission.id,
        authId: user.id,
        periodKey: 'once',
        periodStart: loyaltyMission.startsAt,
        requiredCompletions: 1,
        rewardCredits: 10,
        awardedAt: new Date(),
      },
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

    // AI credits: a purchased grant, then a session debit that used overage
    // for a metered OpenRouter request.
    // One transaction, as the ledger's consistency checks run at commit.
    await client.$transaction(async (tx) => {
      const wallet = await tx.creditWallet.create({
        data: { authId: user.id },
      });
      const allocation = await tx.creditAllocation.create({
        data: {
          walletId: wallet.id,
          authId: user.id,
          source: 'PURCHASE',
          sourceReference: `pay-${tag}`,
          amount: 10,
          remaining: 8,
          grantedAt: new Date(),
        },
      });
      const ledger = { walletId: wallet.id, authId: user.id };
      await tx.creditTransaction.create({
        data: {
          ...ledger,
          type: 'GRANT',
          amount: 10,
          balanceAfter: 10,
          idempotencyKey: `grant:PURCHASE:pay-${tag}`,
          occurredAt: new Date(),
          entries: { create: [{ allocationId: allocation.id, amount: 10 }] },
        },
      });
      const debit = await tx.creditTransaction.create({
        data: {
          ...ledger,
          type: 'DEBIT',
          amount: -2,
          overageAmount: '0.5',
          balanceAfter: 8,
          idempotencyKey: `debit:${tag}`,
          sessionId: session.id,
          usageCostUsd: '0.0125',
          creditCostUsdMicros: 5000,
          occurredAt: new Date(),
          entries: { create: [{ allocationId: allocation.id, amount: -2 }] },
        },
      });
      await tx.aiUsage.create({
        data: {
          authId: user.id,
          sessionId: session.id,
          runId: `run-${tag}`,
          operation: 'GUIDE_QUESTION',
          provider: 'openrouter',
          model: 'openai/gpt-4o-mini',
          providerRequestId: `gen-${tag}`,
          outcome: 'SUCCEEDED',
          inputTokens: 900,
          outputTokens: 100,
          totalTokens: 1000,
          costUsd: '0.0125',
          chargeStatus: 'CHARGED',
          creditCostUsdMicros: 5000,
          // 2 credits from the balance and 0.5 of session overage.
          creditsExact: '2.5',
          creditsDue: '2.5',
          creditsCharged: '2.5',
          transactionId: debit.id,
          occurredAt: new Date(),
        },
      });
      await tx.creditSessionOverage.create({
        data: {
          ...ledger,
          sessionId: session.id,
          overageLimit: 5,
          overageUsed: '0.5',
        },
      });
    });

    const running = await client.dataExport.create({
      data: {
        authId: user.id,
        idempotencyKey: `e-${tag}`,
        status: 'PROCESSING',
        startedAt: new Date(),
      },
    });
    await putFile(
      'exports',
      `${user.id}/${running.id}/${randomUUID()}.zip.partial`,
    );
    const completedAt = new Date();
    const archiveKey = `${user.id}/${randomUUID()}/${randomUUID()}.zip`;
    await putFile('exports', archiveKey);
    await client.dataExport.create({
      data: {
        authId: user.id,
        idempotencyKey: `c-${tag}`,
        status: 'COMPLETED',
        progress: 100,
        storageKey: archiveKey,
        sizeBytes: BigInt(10),
        sha256: 'a'.repeat(64),
        completedAt,
        expiresAt: new Date(completedAt.getTime() + 86_400_000),
      },
    });

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
    // A scheduled month of Pro credits for that payment.
    await client.creditAllocationSchedule.create({
      data: {
        authId: user.id,
        subscriptionId: subscription.id,
        paymentId: payment.id,
        periodStart: payment.periodStart,
        periodEnd: payment.periodEnd,
      },
    });
    const providerCustomerId = `cus_erasure_${tag}`;
    await client.paymentCustomer.create({
      data: { authId: user.id, provider: 'stripe', providerCustomerId },
    });
    await client.checkoutSession.create({
      data: {
        subscriptionId: subscription.id,
        provider: 'stripe',
        providerCustomerId,
        billingInterval: 'MONTHLY',
        amountCents: 1900,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      },
    });

    // A daily reward claim (the trigger also stores the month's total), and
    // a redemption of a discount code targeted at the user. The code is
    // shared administrator configuration: it must survive the erasure.
    await client.dailyRewardClaim.create({
      data: {
        authId: user.id,
        claimDate: new Date('2031-01-05T00:00:00.000Z'),
        monthStart: new Date('2031-01-01T00:00:00.000Z'),
        streakDay: 1,
        rewardCredits: 10,
        grantedCredits: 10,
        claimedAt: new Date('2031-01-05T08:00:00.000Z'),
      },
    });
    const offer = await client.discountOffer.create({
      data: {
        kind: 'CODE',
        code: `ERASURE-${tag}`.toUpperCase().slice(0, 32),
        name: 'Erasure test code',
        discountPercent: 20,
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 86_400_000),
        audience: 'SELECTED_USERS',
        targets: { create: { authId: user.id } },
      },
    });
    await client.discountRedemption.create({
      data: {
        offerId: offer.id,
        authId: user.id,
        source: 'CODE',
        product: 'CREDITS_SMALL',
        idempotencyKey: `erasure-${tag}`,
        packageCode: 'SMALL',
        credits: 250,
        discountPercent: 20,
        originalPriceUsdCents: 500,
        discountUsdCents: 100,
        finalPriceUsdCents: 400,
        redeemedAt: new Date(),
      },
    });

    // The account's referral code, the referral it signed up with, and a
    // friend it referred (who keeps the referral when the account is erased).
    await client.referralCode.create({
      data: { authId: user.id, code: `REF${tag.toUpperCase()}` },
    });
    // Created with its referral, like a signup (a referral is only accepted
    // in the transaction that creates the account).
    const friend = await client.authUser.create({
      data: {
        email: `friend_${tag}@example.com`,
        username: `friend_${tag}`,
        password: 'not-a-real-hash',
        referral: { create: { referrerAuthId: user.id } },
      },
    });
    // The friend buys: the account reaches a milestone as the referrer.
    const friendSubscription = await client.userSubscription.create({
      data: { authId: friend.id },
    });
    const friendTermStart = new Date(Date.now() - 86_400_000);
    const friendPayment = await recordPayment(client, friendSubscription.id, {
      periodStart: friendTermStart,
      periodEnd: termEnd({
        billingInterval: 'MONTHLY',
        startedAt: friendTermStart,
      }),
    });
    await client.referral.update({
      where: { authId: friend.id },
      data: {
        status: 'QUALIFIED',
        qualifyingPaymentId: friendPayment.id,
        qualifiedAt: new Date(),
      },
    });
    const milestone = await client.referralMilestone.upsert({
      where: { referralCount: 1 },
      create: { referralCount: 1, rewardCredits: 10 },
      update: {},
    });
    await client.referralMilestoneAward.create({
      data: {
        milestoneId: milestone.id,
        authId: user.id,
        referralCount: 1,
        rewardCredits: milestone.rewardCredits,
        awardedAt: new Date(),
      },
    });
    await client.referralProgress.create({
      data: { authId: user.id, paidReferrals: 1 },
    });
    await client.paymentFingerprint.create({
      data: { authId: user.id, fingerprintHash: 'a'.repeat(64) },
    });
    await client.notification.create({
      data: {
        authId: user.id,
        type: 'REFERRAL_MILESTONE_REACHED',
        eventKey: `referral-milestone:${milestone.id}`,
        title: 'Milestone reached',
        body: 'You earned bonus credits.',
        emailStatus: 'NOT_REQUESTED',
      },
    });
    await client.notificationPreference.create({
      data: { authId: user.id, emailReferralRewards: false },
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
    // A credit package order: a financial record, kept detached.
    const packageOrder = await client.creditPackageOrder.create({
      data: {
        authId: user.id,
        idempotencyKey: `erasure-${tag}`,
        packageCode: 'SMALL',
        credits: 250,
        listPriceUsdCents: 500,
        amountUsdCents: 500,
        provider: 'stripe',
        providerCustomerId,
      },
    });
    return {
      id: user.id,
      email,
      subscriptionId: subscription.id,
      paymentId: payment.id,
      packageOrderId: packageOrder.id,
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
            : ['SubscriptionEvent', 'CheckoutSession'].includes(table)
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
                    : table === 'CreditLedgerEntry'
                      ? `"walletId" IN (SELECT "id" FROM "CreditWallet" WHERE "authId" = '${authId}')`
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
    await expect(
      client.creditPackageOrder.findUniqueOrThrow({
        where: { id: victim.packageOrderId },
      }),
    ).resolves.toMatchObject({ authId: null, credits: 250 });

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

    // A user the erased account referred keeps the referral (and so the
    // referral discount); only the link to the deleted referrer is gone.
    await expect(
      client.referral.findMany({
        where: { authUser: { username: { startsWith: 'friend_' } } },
        select: { referrerAuthId: true },
      }),
    ).resolves.toEqual(expect.arrayContaining([{ referrerAuthId: null }]));

    // Shared discount offers stay, and keep counting the erased account's
    // redemption (a depleted offer must not reopen).
    await expect(
      client.discountOffer.findFirstOrThrow({
        where: { code: { startsWith: 'ERASURE-' }, redemptions: { none: {} } },
        select: { redemptionCount: true },
      }),
    ).resolves.toEqual({ redemptionCount: 1 });

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

    // 5. Every private file of the account is gone, referenced or not.
    expect(await filesUnder('images', victim.id)).toEqual([]);
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
      'filesRecordedAt',
      'filesDeletedAt',
      'dataErasedAt',
      'completedAt',
    ] as const) {
      expect(request[step]).toBeInstanceOf(Date);
    }
    // Files were deleted before the account.
    expect(request.filesDeletedAt!.getTime()).toBeLessThanOrEqual(
      request.dataErasedAt!.getTime(),
    );
    expect(
      request.files.map((file) => [file.kind, file.status]).sort(),
    ).toEqual(
      [
        ['EXPORT_ARCHIVE', 'DELETED'],
        ['EXPORT_OWNER_DIRECTORY', 'DELETED'],
        ['IMAGE_OWNER_DIRECTORY', 'DELETED'],
        ['PRIVATE_IMAGE', 'DELETED'],
        ['PRIVATE_IMAGE', 'DELETED'],
      ].sort(),
    );
    expect(request.files.every((file) => file.resolvedAt)).toBe(true);
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
        'CreditPackageOrder.authId',
        'PaymentTransaction.subscriptionId',
      ]);
      // Shared records are never reachable from a user.
      for (const shared of [
        'SubscriptionPlan',
        'AccountDeletionRequest',
        'AccountDeletionFile',
        'PaymentTransaction',
        'CreditPackageOrder',
        'ActivityLogEvent',
      ]) {
        expect(deleted.has(shared)).toBe(false);
      }
    } finally {
      await pg.end();
    }
  });

  it('keeps the account closed (not deleted) when the database fails after the files were deleted, and resumes', async () => {
    const victim = await seedAccount();
    const requestId = await acceptDeletion(victim.id);
    const before = await userRowCounts(victim.id, victim.subscriptionId);
    // Simulate a database failure in the middle of the hard delete.
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
    // The files are deleted, but the data transaction rolled back as a
    // whole: the account still exists, closed, with all its data.
    expect(stuck).toMatchObject({ status: 'PROCESSING', dataErasedAt: null });
    expect(stuck.filesDeletedAt).toBeInstanceOf(Date);
    expect(await filesUnder('images', victim.id)).toEqual([]);
    expect(await userRowCounts(victim.id, victim.subscriptionId)).toEqual(
      before,
    );
    await expect(
      client.authUser.findUniqueOrThrow({ where: { id: victim.id } }),
    ).resolves.toMatchObject({ status: 'PENDING_DELETION' });

    await pg.query(
      `DROP TRIGGER "fail_login_history_delete" ON "loginHistory";`,
    );
    await pg.end();
    const resumed = await recovery.resume();

    expect(resumed.completed).toBe(1);
    await expect(
      client.authUser.count({ where: { id: victim.id } }),
    ).resolves.toBe(0);
  });

  it('keeps the account closed and its storage references while file deletion fails, and completes once storage recovers', async () => {
    const victim = await seedAccount();
    const requestId = await acceptDeletion(victim.id);
    const before = await userRowCounts(victim.id, victim.subscriptionId);
    // A referenced photo (not the unreferenced leftover in the same folder).
    const { storageKey: photoKey } = await client.imageAsset.findFirstOrThrow({
      where: { session: { authId: victim.id } },
      select: { storageKey: true },
    });
    // Real storage, with one file that cannot be deleted for now.
    const realDelete = images.deleteOwnerFile.bind(images) as (
      authId: string,
      key: string,
    ) => Promise<boolean>;
    const failing = jest
      .spyOn(images, 'deleteOwnerFile')
      .mockImplementation((authId: string, key: string) =>
        key === photoKey
          ? Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }))
          : realDelete(authId, key),
      );

    await recovery.resume();
    await recovery.resume();

    const pending = await client.accountDeletionRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { files: true },
    });
    expect(pending).toMatchObject({
      status: 'PROCESSING',
      filesDeletedAt: null,
      dataErasedAt: null,
      completedAt: null,
    });
    expect(pending.lastError).toMatch(/File deletion failed/);
    // Not deleted: the account and all its data still exist, closed.
    await expect(
      client.authUser.findUniqueOrThrow({ where: { id: victim.id } }),
    ).resolves.toMatchObject({ status: 'PENDING_DELETION' });
    expect(await userRowCounts(victim.id, victim.subscriptionId)).toEqual(
      before,
    );
    // The failing file is still on disk and still referenced; the other
    // files were deleted.
    const left = (await filesUnder('images', victim.id)).map((path) =>
      path.slice(join(root, 'images').length + 1).replaceAll('\\', '/'),
    );
    expect(left).toEqual([photoKey]);
    expect(pending.files.filter((file) => file.status === 'PENDING')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'PRIVATE_IMAGE',
          storageKey: photoKey,
          lastError: 'Error (EIO)',
        }),
      ]),
    );

    failing.mockRestore();
    await recovery.resume();

    expect(await filesUnder('images', victim.id)).toEqual([]);
    await expect(
      client.accountDeletionRequest.findUniqueOrThrow({
        where: { id: requestId },
      }),
    ).resolves.toMatchObject({ status: 'COMPLETED' });
    await expect(
      client.authUser.count({ where: { id: victim.id } }),
    ).resolves.toBe(0);
  });

  it('keeps a file another account references, and completes with the rest deleted', async () => {
    const victim = await seedAccount();
    const bystander = await seedAccount();
    // Another account's row points at one of the victim's photos.
    const sharedKey = (
      await client.imageAsset.findFirstOrThrow({
        where: { session: { authId: victim.id } },
        select: { storageKey: true },
      })
    ).storageKey;
    const bystanderSession = await client.makeupSession.findFirstOrThrow({
      where: { authId: bystander.id },
    });
    await client.imageAsset.create({
      data: {
        sessionId: bystanderSession.id,
        purpose: 'COMPLETION',
        source: 'PRIVATE_UPLOAD',
        storageProvider: 'local',
        storageKey: sharedKey,
        mimeType: 'image/jpeg',
        width: 1,
        height: 1,
        sizeBytes: 1,
      },
    });
    const requestId = await acceptDeletion(victim.id);

    await expect(recovery.resume()).resolves.toMatchObject({ completed: 1 });

    const left = (await filesUnder('images', victim.id)).map((path) =>
      path.slice(join(root, 'images').length + 1).replaceAll('\\', '/'),
    );
    expect(left).toEqual([sharedKey]);
    const files = await client.accountDeletionFile.findMany({
      where: { requestId },
    });
    expect(files.find((file) => file.storageKey === sharedKey)).toMatchObject({
      status: 'RETAINED',
      note: 'Referenced by another account',
    });
  });

  it('completes when files are already missing from storage', async () => {
    const victim = await seedAccount();
    await rm(join(root, 'images', victim.id), { recursive: true, force: true });
    await rm(join(root, 'exports', victim.id), {
      recursive: true,
      force: true,
    });
    const requestId = await acceptDeletion(victim.id);

    await expect(recovery.resume()).resolves.toMatchObject({ completed: 1 });

    const files = await client.accountDeletionFile.findMany({
      where: { requestId },
    });
    expect(files.map((file) => file.status)).toEqual(
      files.map(() => 'MISSING'),
    );
  });

  describe('coordination with export workers and concurrent processing', () => {
    const waitFor = async (condition: () => boolean, timeoutMs = 5_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const runExport = (exportId: string, authId: string) =>
      exportProcessor.process({
        data: { exportId, authId },
        maxAttempts: 3,
        attemptsMade: 0,
        discard: jest.fn(),
      } as unknown as JobExecution<PrivacyExportJob>);

    it('waits for a running export worker, which stops and removes its partial archive, before deleting anything', async () => {
      const victim = await seedAccount();
      // The account's running export (one active export per user).
      const live = await client.dataExport.findFirstOrThrow({
        where: { authId: victim.id, status: 'PROCESSING' },
      });
      // Pause the worker while it copies a photo into the archive.
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => (resume = resolve));
      let paused = false;
      const read = workerImages.read.bind(workerImages) as (
        ref: PrivateObjectRef,
      ) => Promise<Buffer>;
      const readSpy = jest
        .spyOn(workerImages, 'read')
        .mockImplementation(async (key) => {
          paused = true;
          await gate;
          return read(key);
        });
      const partials = () =>
        filesUnder('exports', victim.id).then((files) =>
          files.filter((file) => file.includes(live.id)),
        );
      // A partial archive left by an earlier, crashed attempt of this export
      // (seeded); the live worker writes its own next to it.
      const stale = await partials();
      const worker = runExport(live.id, victim.id);
      await waitFor(() => paused);
      const own = (await partials()).filter((file) => !stale.includes(file));
      expect(own).toHaveLength(1);
      expect(own[0]).toMatch(/\.zip\.partial$/);

      const requestId = await acceptDeletion(victim.id);
      const first = await recovery.resume();

      // Coordinated: the export was cancelled, but nothing was deleted while
      // the worker can still write; the account stays closed.
      expect(first).toMatchObject({ completed: 0, pending: 1 });
      const waiting = await client.accountDeletionRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      expect(waiting).toMatchObject({
        status: 'PROCESSING',
        filesDeletedAt: null,
        dataErasedAt: null,
        lastError: 'Waiting for 1 export worker(s) of the account to stop',
      });
      expect(waiting.filesRecordedAt).toBeInstanceOf(Date);
      await expect(
        client.dataExport.findUniqueOrThrow({ where: { id: live.id } }),
      ).resolves.toMatchObject({
        status: 'FAILED',
        errorCode: 'ACCOUNT_UNAVAILABLE',
      });
      await expect(
        client.authUser.findUniqueOrThrow({ where: { id: victim.id } }),
      ).resolves.toMatchObject({ status: 'PENDING_DELETION' });
      expect(await filesUnder('images', victim.id)).not.toEqual([]);

      // The worker notices the cancellation, removes its partial archive and
      // releases its lease.
      resume();
      await expect(worker).resolves.toBeUndefined();
      readSpy.mockRestore();
      // The worker removed its own partial archive; the stale one is left
      // for the erasure, which is allowed to proceed now.
      expect(await partials()).toEqual(stale);
      await expect(
        client.dataExport.findUniqueOrThrow({ where: { id: live.id } }),
      ).resolves.toMatchObject({ workerLeaseUntil: null });

      const second = await recovery.resume();

      expect(second.completed).toBe(1);
      expect(await filesUnder('exports', victim.id)).toEqual([]);
      expect(await filesUnder('images', victim.id)).toEqual([]);
      await expect(
        client.authUser.count({ where: { id: victim.id } }),
      ).resolves.toBe(0);
    });

    it('never lets a worker start an export of an account whose deletion was approved', async () => {
      const victim = await seedAccount();
      const pending = await client.dataExport.findFirstOrThrow({
        where: { authId: victim.id, status: 'PROCESSING' },
      });
      const filesBefore = await filesUnder('exports', victim.id);
      await acceptDeletion(victim.id);

      // A delayed job for the export is delivered after the approval.
      await runExport(pending.id, victim.id);

      await expect(
        client.dataExport.findUniqueOrThrow({ where: { id: pending.id } }),
      ).resolves.toMatchObject({
        startedAt: pending.startedAt,
        attempts: pending.attempts,
        workerLeaseUntil: null,
      });
      expect(await filesUnder('exports', victim.id)).toEqual(filesBefore);
      await recovery.resume();
      expect(await filesUnder('exports', victim.id)).toEqual([]);
    });

    it('serializes archive file creation with the cancellation (real row locks): before it, or refused after it', async () => {
      const authId = (await seedAccount()).id;
      // The account's running export (one active export per user).
      const row = await client.dataExport.findFirstOrThrow({
        where: { authId, status: 'PROCESSING' },
      });
      const startedAt = row.startedAt!;
      const attempt = new ExportAttempt(prisma, row.id, startedAt);
      const order: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));

      const creating = attempt.fenced(async () => {
        order.push('file created');
        await held;
      });
      await waitFor(() => order.length === 1);
      // Account erasure cancels the account's exports meanwhile.
      const cancelling = client.dataExport
        .updateMany({
          where: { authId, status: { in: ['QUEUED', 'PROCESSING'] } },
          data: {
            status: 'FAILED',
            error: 'unavailable',
            errorCode: 'ACCOUNT_UNAVAILABLE',
            completedAt: new Date(),
          },
        })
        .then(() => order.push('cancelled'));
      await new Promise((resolve) => setTimeout(resolve, 150));
      // The cancellation waits for the file operation holding the row lock.
      expect(order).toEqual(['file created']);

      release();
      await Promise.all([creating, cancelling]);
      expect(order).toEqual(['file created', 'cancelled']);

      const afterwards = jest.fn(() => Promise.resolve());
      await expect(attempt.fenced(afterwards)).rejects.toBeInstanceOf(
        PrivacyExportSupersededError,
      );
      expect(afterwards.mock.calls).toHaveLength(0);
    });

    it('keeps every cleanup reference when the database fails while recording file outcomes, and resumes', async () => {
      const victim = await seedAccount();
      const requestId = await acceptDeletion(victim.id);
      const pg = await connectToSchema(schema);
      await pg.query(`
        CREATE FUNCTION "fail_file_update"() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END; $$;
        CREATE TRIGGER "fail_file_update" BEFORE UPDATE ON "AccountDeletionFile"
          FOR EACH ROW EXECUTE FUNCTION "fail_file_update"();`);

      const interrupted = await recovery.resume();

      expect(interrupted).toMatchObject({ completed: 0, pending: 1 });
      const recorded = await client.accountDeletionFile.findMany({
        where: { requestId },
      });
      // The references survived the interruption, all still pending.
      expect(recorded.length).toBeGreaterThanOrEqual(5);
      expect(recorded.every((file) => file.status === 'PENDING')).toBe(true);
      await expect(
        client.authUser.findUniqueOrThrow({ where: { id: victim.id } }),
      ).resolves.toMatchObject({ status: 'PENDING_DELETION' });

      await pg.query(
        `DROP TRIGGER "fail_file_update" ON "AccountDeletionFile";`,
      );
      await pg.end();
      const resumed = await recovery.resume();

      expect(resumed.completed).toBe(1);
      const resolved = await client.accountDeletionFile.findMany({
        where: { requestId },
      });
      expect(resolved.map((file) => file.id).sort()).toEqual(
        recorded.map((file) => file.id).sort(),
      );
      expect(resolved.every((file) => file.status !== 'PENDING')).toBe(true);
      expect(await filesUnder('images', victim.id)).toEqual([]);
      expect(await filesUnder('exports', victim.id)).toEqual([]);
    });

    it('stops a worker whose lease expired and was taken over, without duplicating or undoing the new worker’s work', async () => {
      const victim = await seedAccount();
      const bystander = await seedAccount();
      const bystanderFiles = await filesUnder('images', bystander.id);
      const requestId = await acceptDeletion(victim.id);
      // Worker A gets stuck inside its first storage operation.
      const slowImages = localImageStorage();
      const deleteFile = slowImages.deleteOwnerFile.bind(slowImages) as (
        authId: string,
        key: string,
      ) => Promise<boolean>;
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => (resume = resolve));
      let stuck = false;
      jest
        .spyOn(slowImages, 'deleteOwnerFile')
        .mockImplementationOnce(async (authId: string, key: string) => {
          stuck = true;
          await gate;
          return deleteFile(authId, key);
        });
      const workerA = new AccountErasureService(
        prisma,
        auth,
        codes,
        slowImages,
        exportsStorage,
        mock<Logger>(),
      );

      const a = workerA.process(requestId);
      await waitFor(() => stuck);
      // A's lease expires; worker B claims the request and completes it.
      const b = await erasure.process(
        requestId,
        new Date(Date.now() + ERASURE_LEASE_MS + 60_000),
      );
      expect(b).toBe('COMPLETED');
      const completed = await client.accountDeletionRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: { files: true },
      });

      resume();
      await expect(a).resolves.toBe('SKIPPED');

      // A changed nothing after losing its lease.
      await expect(
        client.accountDeletionRequest.findUniqueOrThrow({
          where: { id: requestId },
          include: { files: true },
        }),
      ).resolves.toEqual(completed);
      expect(completed).toMatchObject({ status: 'COMPLETED', attempts: 2 });
      expect(await filesUnder('images', victim.id)).toEqual([]);
      expect(await filesUnder('images', bystander.id)).toEqual(bystanderFiles);
    });

    it('turns concurrent deletion requests and concurrent sweeps on several instances into one deletion, deleting each file once', async () => {
      const victim = await seedAccount();
      const bystander = await seedAccount();
      const bystanderFiles = await filesUnder('images', bystander.id);
      // Several requests at once (identity verified for each).
      const verify = jest.spyOn(codes, 'verify').mockResolvedValue(true);
      const views = await Promise.all(
        Array.from({ length: 4 }, () =>
          deletions.requestDeletion(
            victim.id,
            { password: PASSWORD, code: 'ABC123' },
            META,
          ),
        ),
      );
      verify.mockRestore();
      expect(new Set(views.map((view) => view.id)).size).toBe(1);

      // Several instances sweep at the same time; count real deletions.
      const deleted: string[] = [];
      const instances = Array.from({ length: 3 }, () => {
        const instanceImages = localImageStorage();
        const realDelete = instanceImages.deleteOwnerFile.bind(
          instanceImages,
        ) as (authId: string, key: string) => Promise<boolean>;
        jest
          .spyOn(instanceImages, 'deleteOwnerFile')
          .mockImplementation(async (authId: string, key: string) => {
            const removed = await realDelete(authId, key);
            if (removed) deleted.push(key);
            return removed;
          });
        const instanceErasure = new AccountErasureService(
          prisma,
          auth,
          codes,
          instanceImages,
          exportsStorage,
          mock<Logger>(),
        );
        return new AccountDeletionRecoveryService(
          prisma,
          deletions,
          instanceErasure,
          new ConfigService({ NODE_ENV: 'test' }),
          mock<Logger>(),
        );
      });

      const results = await Promise.all(
        instances.map((instance) => instance.resume()),
      );

      expect(results.reduce((sum, result) => sum + result.completed, 0)).toBe(
        1,
      );
      expect(new Set(deleted).size).toBe(deleted.length);
      expect(deleted.length).toBeGreaterThan(0);
      await expect(
        client.accountDeletionRequest.count({ where: { authId: victim.id } }),
      ).resolves.toBe(1);
      await expect(
        client.accountDeletionRequest.findFirstOrThrow({
          where: { authId: victim.id },
        }),
      ).resolves.toMatchObject({ status: 'COMPLETED', attempts: 1 });
      expect(await filesUnder('images', victim.id)).toEqual([]);
      expect(await filesUnder('images', bystander.id)).toEqual(bystanderFiles);
    });
  });

  it('retries cloud account erasure after restart using each saved provider, including orphan objects', async () => {
    const victim = await seedAccount();
    const api = new FakeSupabaseStorage();
    const cloud = new PrivateImageStorageService(
      [
        new SupabaseStorageProvider(
          {
            storageUrl: FAKE_SUPABASE.url,
            serviceKey: FAKE_SUPABASE.serviceKey,
            bucket: FAKE_SUPABASE.bucket,
            timeoutMs: 1000,
          },
          api.fetch,
        ),
        new LocalFilesystemStorageProvider(join(root, 'images')),
      ],
      { activeProvider: 'supabase', localRoot: join(root, 'images') },
      mock<Logger>(),
    );
    for (const file of await filesUnder('images', victim.id)) {
      const key = file
        .slice(join(root, 'images').length + 1)
        .replaceAll('\\', '/');
      api.objects.set(key, {
        bytes: await readFile(file),
        contentType: 'image/jpeg',
      });
      await images.deleteOwnerFile(victim.id, key);
    }
    api.objects.set(victim.id + '/profile/orphan.jpg', {
      bytes: Buffer.from('orphan'),
      contentType: 'image/jpeg',
    });
    api.objects.set('another/profile/keep.jpg', {
      bytes: Buffer.from('keep'),
      contentType: 'image/jpeg',
    });
    await client.imageAsset.updateMany({
      where: { session: { authId: victim.id } },
      data: { storageProvider: 'supabase' },
    });
    await client.userProfile.update({
      where: { authId: victim.id },
      data: { avatarStorageProvider: 'supabase' },
    });
    const requestId = await acceptDeletion(victim.id);
    const instance = () =>
      new AccountErasureService(
        prisma,
        auth,
        codes,
        cloud,
        exportsStorage,
        mock<Logger>(),
      );
    api.failNext('remove', unavailable);
    await expect(instance().process(requestId)).resolves.toBe('PENDING');
    expect(
      await client.authUser.findUnique({ where: { id: victim.id } }),
    ).not.toBeNull();
    expect(
      await client.accountDeletionFile.count({
        where: { requestId, storageProvider: 'supabase', status: 'PENDING' },
      }),
    ).toBeGreaterThan(0);
    const recovered = await instance().process(requestId);
    expect(
      await client.accountDeletionRequest.findUnique({
        where: { id: requestId },
        select: { status: true, lastError: true },
      }),
    ).toMatchObject({ status: 'COMPLETED', lastError: null });
    expect(recovered).toBe('COMPLETED');
    expect(
      await client.authUser.findUnique({ where: { id: victim.id } }),
    ).toBeNull();
    expect([...api.objects.keys()]).toEqual(['another/profile/keep.jpg']);
  });

  it.each([
    ['an unregistered backend', 'retired-storage'],
    ['an unconfigured backend', 'supabase'],
  ])(
    'does not complete erasure while orphan cleanup needs %s',
    async (_label, provider) => {
      const victim = await seedAccount();
      const key = victim.id + '/profile/orphan-only-in-cleanup.jpg';
      await client.privateStorageCleanup.create({
        data: {
          provider,
          storageKey: key,
          reason: 'UPLOAD_ABANDONED',
          status: 'FAILED',
        },
      });
      const requestId = await acceptDeletion(victim.id);
      const instanceStorage = new PrivateImageStorageService(
        [
          new LocalFilesystemStorageProvider(join(root, 'images')),
          new SupabaseStorageProvider(undefined),
        ],
        { activeProvider: 'local', localRoot: join(root, 'images') },
        mock<Logger>(),
      );
      const instance = new AccountErasureService(
        prisma,
        auth,
        codes,
        instanceStorage,
        exportsStorage,
        mock<Logger>(),
      );
      await expect(instance.process(requestId)).resolves.toBe('PENDING');
      expect(
        await client.authUser.findUnique({ where: { id: victim.id } }),
      ).not.toBeNull();
      expect(
        await client.accountDeletionRequest.findUnique({
          where: { id: requestId },
        }),
      ).toMatchObject({ completedAt: null });
      expect(
        await client.privateStorageCleanup.findUnique({
          where: { provider_storageKey: { provider, storageKey: key } },
        }),
      ).not.toBeNull();
    },
  );

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
