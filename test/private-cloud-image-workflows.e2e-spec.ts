import type { CreditUsageService } from '../src/credit/credit-usage.service';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import type { JobExecution } from '../src/infrastructure/jobs/job.types';
import { mock } from 'jest-mock-extended';
import sharp from 'sharp';
import type { Logger } from 'winston';
import type { PrismaService } from '../src/common/services/prisma.service';
import { MockAiGateway } from '../src/makeup/ai/mock-ai.gateway';
import { LiveAiGateway } from '../src/makeup/ai/live-ai.gateway';
import { OpenRouterProvider } from '../src/makeup/ai/providers/openrouter.provider';
import type { StructuredGenerationRequest } from '../src/makeup/ai/providers/structured-ai.provider';
import { MakeupService } from '../src/makeup/makeup.service';
import { MakeupJobHandler } from '../src/makeup/queues/makeup-job.handler';
import type {
  MakeupAiJob,
  MakeupQueueService,
} from '../src/makeup/queues/makeup.queue';
import { ImageValidationService } from '../src/makeup/services/image-validation.service';
import { ProfileService } from '../src/profile/profile.service';
import { PrivateImageLifecycleService } from '../src/storage/private-image-lifecycle.service';
import { PrivateImageStorageService } from '../src/storage/private-image-storage.service';
import { LocalFilesystemStorageProvider } from '../src/storage/providers/local-filesystem-storage.provider';
import { SupabaseStorageProvider } from '../src/storage/providers/supabase-storage.provider';
import type { PrivateObjectStorageProvider } from '../src/storage/private-object-storage.provider';
import { FakeS3CompatibleStorage } from './support/fake-s3-compatible-storage';
import {
  FAKE_SUPABASE,
  FakeSupabaseStorage,
  accessDenied,
  unavailable,
} from './support/fake-supabase-storage';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';
import { createUser } from './support/subscription-fixtures';

jest.setTimeout(60_000);

/**
 * Credits are not under test here (see test/credit-usage.e2e-spec.ts): AI
 * requests may be made, and no usage is recorded or charged. A plain object,
 * so jest.resetAllMocks() cannot change it.
 */
const creditsNotUnderTestStub = {
  hasSpendableCredits: () => Promise.resolve(true),
  closePendingForRun: () => Promise.resolve(0),
  recordUsage: () => Promise.resolve(null),
  chargeInTransaction: () => Promise.resolve(undefined),
  close: () => Promise.resolve(undefined),
} satisfies Partial<Record<keyof CreditUsageService, unknown>>;
const creditsNotUnderTest =
  creditsNotUnderTestStub as unknown as CreditUsageService;

type ImageFormat = 'jpeg' | 'png' | 'webp';

/** A real image (validated by sharp like production uploads). */
async function photo(format: ImageFormat = 'jpeg', shade = 120) {
  const buffer = await sharp({
    create: {
      width: 400,
      height: 400,
      channels: 3,
      background: { r: shade, g: 80, b: 160 },
    },
  })
    .toFormat(format)
    .toBuffer();
  return { buffer, size: buffer.length } as Express.Multer.File;
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { status?: number; message?: string; code?: string };
  }
  throw new Error('Expected the operation to fail');
}

describeWithDatabase(
  'Private cloud image workflows (PostgreSQL + mocked Supabase)',
  () => {
    let schema: string;
    let client: PrismaClient;
    let prisma: PrismaService;
    const supabase = new FakeSupabaseStorage();
    const localProvider = new LocalFilesystemStorageProvider(
      '/nonexistent/musecue-local-images',
    );
    const localCalls = {
      put: jest.spyOn(localProvider, 'put'),
      get: jest.spyOn(localProvider, 'get'),
      delete: jest.spyOn(localProvider, 'delete'),
      createSignedUrl: jest.spyOn(localProvider, 'createSignedUrl'),
    };
    const queue = mock<MakeupQueueService>();
    const ai = new MockAiGateway();
    let storage: PrivateImageStorageService;
    let lifecycle: PrivateImageLifecycleService;
    let makeup: MakeupService;
    let profile: ProfileService;
    let processor: MakeupJobHandler;
    let owner: string;
    let intruder: string;

    const ledger = () => client.privateStorageCleanup.findMany();
    const makeDue = () =>
      client.privateStorageCleanup.updateMany({
        data: { nextAttemptAt: new Date(Date.now() - 1_000) },
      });
    const newSession = (authId: string, status = 'CREATED' as const) =>
      client.makeupSession.create({ data: { authId, status } });
    const bucketKeys = () => [...supabase.objects.keys()].sort();

    const injected: Array<{ name: string; table: string }> = [];

    /** Makes PostgreSQL itself fail a write, via a trigger on the test schema. */
    async function injectDbFailure(
      table: string,
      event: 'INSERT' | 'UPDATE' | 'DELETE',
      when?: string,
    ) {
      const name = `inject_${randomBytes(4).toString('hex')}`;
      await client.$executeRawUnsafe(
        `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected database failure'; END $$`,
      );
      await client.$executeRawUnsafe(
        `CREATE TRIGGER ${name} BEFORE ${event} ON "${table}" FOR EACH ROW ${when ? `WHEN (${when}) ` : ''}EXECUTE FUNCTION ${name}()`,
      );
      injected.push({ name, table });
    }

    async function removeInjectedFailures() {
      for (const { name, table } of injected.splice(0)) {
        await client.$executeRawUnsafe(
          `DROP TRIGGER IF EXISTS ${name} ON "${table}"`,
        );
        await client.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
      }
    }

    afterEach(removeInjectedFailures);

    /** Session with a selected look and a guide whose first step is CURRENT. */
    async function guideFixture(authId: string) {
      const session = await client.makeupSession.create({
        data: { authId, status: 'IN_PROGRESS' },
      });
      const recommendation = await client.recommendation.create({
        data: {
          sessionId: session.id,
          rank: 1,
          name: 'Soft glow',
          tagline: 'Natural',
          matchScore: 90,
          imageUrl: 'https://example.com/look.jpg',
          palette: [],
          rationale: 'Fits the brief',
          selectedAt: new Date(),
        },
      });
      const guide = await client.guide.create({
        data: {
          sessionId: session.id,
          recommendationId: recommendation.id,
          status: 'IN_PROGRESS',
          startedAt: new Date(),
        },
      });
      const step = await client.guideStep.create({
        data: {
          guideId: guide.id,
          position: 0,
          status: 'CURRENT',
          title: 'Base',
          instruction: 'Apply base',
          area: 'face',
          technique: 'blend',
          estimatedSeconds: 60,
          personalizedTip: 'Thin layers',
          commonMistake: 'Too much product',
          successCriteria: 'Even tone',
        },
      });
      return { session, step };
    }

    function job(name: string, data: MakeupAiJob) {
      const discard = jest.fn();
      return {
        discard,
        job: {
          name,
          data,
          maxAttempts: 3,
          attemptsMade: 0,
          discard,
          updateData: jest.fn(),
        } as unknown as JobExecution<MakeupAiJob>,
      };
    }

    beforeAll(async () => {
      schema = await createSchema();
      await applyMigrations(schema, migrationNames());
      client = new PrismaClient({
        adapter: new PrismaPg(
          {
            connectionString: TEST_DATABASE_URL as string,
            // Raw SQL (the workflow row locks) resolves through search_path.
            options: `-c search_path=${schema}`,
          },
          { schema },
        ),
      });
      prisma = client as unknown as PrismaService;
      const logger = mock<Logger>();
      storage = new PrivateImageStorageService(
        [
          new SupabaseStorageProvider(
            {
              storageUrl: FAKE_SUPABASE.url,
              serviceKey: FAKE_SUPABASE.serviceKey,
              bucket: FAKE_SUPABASE.bucket,
              timeoutMs: 300,
            },
            supabase.fetch,
          ),
          localProvider,
        ],
        { activeProvider: 'supabase', localRoot: '/nonexistent' },
        logger,
      );
      lifecycle = new PrivateImageLifecycleService(
        prisma,
        storage,
        new ConfigService({ NODE_ENV: 'test' }),
        logger,
      );
      const validation = new ImageValidationService();
      makeup = new MakeupService(
        prisma,
        queue,
        validation,
        storage,
        lifecycle,
        ai,
      );
      profile = new ProfileService(prisma, validation, storage, lifecycle);
      processor = new MakeupJobHandler(
        prisma,
        ai,
        storage,
        logger,
        new ConfigService(),
        creditsNotUnderTest,
      );
      owner = await createUser(client);
      intruder = await createUser(client);
    });

    afterAll(async () => {
      await client?.$disconnect();
      if (schema) await dropSchema(schema);
    });

    beforeEach(async () => {
      supabase.reset();
      jest.clearAllMocks();
      queue.enqueue.mockResolvedValue();
      await client.privateStorageCleanup.deleteMany();
    });

    afterEach(() => {
      // New images never touch the local filesystem.
      for (const call of Object.values(localCalls)) {
        expect(call).not.toHaveBeenCalled();
      }
    });

    describe('face photo uploads', () => {
      it('stores the photo in the private bucket and records its provider and key', async () => {
        const session = await newSession(owner);
        const file = await photo('jpeg');

        await makeup.uploadInitialImage(owner, session.id, file);

        const [image] = await client.imageAsset.findMany({
          where: { sessionId: session.id },
        });
        expect(image).toMatchObject({
          purpose: 'INITIAL_ANALYSIS',
          source: 'PRIVATE_UPLOAD',
          storageProvider: 'supabase',
          mimeType: 'image/jpeg',
          width: 400,
          height: 400,
        });
        expect(image.storageKey).toMatch(
          new RegExp(`^${owner}/${session.id}/[0-9a-f-]{36}\\.jpg$`),
        );
        expect(supabase.objects.get(image.storageKey)).toEqual({
          bytes: file.buffer,
          contentType: 'image/jpeg',
        });
        expect(
          (
            await client.makeupSession.findUniqueOrThrow({
              where: { id: session.id },
            })
          ).status,
        ).toBe('IMAGE_UPLOADED');
        expect(await ledger()).toEqual([]);
      });

      it('serves content and signed URLs from the stored provider and key, to the owner only', async () => {
        const session = await newSession(owner);
        const file = await photo('png');
        await makeup.uploadInitialImage(owner, session.id, file);
        const image = await client.imageAsset.findFirstOrThrow({
          where: { sessionId: session.id },
        });

        await expect(makeup.getImageContent(owner, image.id)).resolves.toEqual({
          mimeType: 'image/png',
          bytes: file.buffer,
        });
        const signed = await makeup.getImageSignedUrl(owner, image.id);
        expect(new URL(signed.url).pathname).toBe(
          `/storage/v1/object/sign/${FAKE_SUPABASE.bucket}/${image.storageKey}`,
        );
        expect(signed.expiresInSeconds).toBe(60);

        const before = supabase.requests.length;
        expect(
          await rejection(makeup.getImageContent(intruder, image.id)),
        ).toMatchObject({ status: 404 });
        expect(
          await rejection(makeup.getImageSignedUrl(intruder, image.id)),
        ).toMatchObject({ status: 404 });
        expect(supabase.requests).toHaveLength(before);
      });

      it("refuses uploads into another user's session before storing anything", async () => {
        const session = await newSession(owner);

        expect(
          await rejection(
            makeup.uploadInitialImage(intruder, session.id, await photo()),
          ),
        ).toMatchObject({ status: 404 });
        expect(supabase.count('upload')).toBe(0);
        expect(await ledger()).toEqual([]);
      });

      it('rejects invalid images before touching storage', async () => {
        const session = await newSession(owner);
        const notAnImage = {
          buffer: Buffer.from('definitely not an image'),
          size: 23,
        } as Express.Multer.File;

        expect(
          await rejection(
            makeup.uploadInitialImage(owner, session.id, notAnImage),
          ),
        ).toMatchObject({ status: 400 });
        expect(supabase.requests).toHaveLength(0);
      });

      it('deletes the replaced photo from the bucket', async () => {
        const session = await newSession(owner);
        await makeup.uploadInitialImage(
          owner,
          session.id,
          await photo('jpeg', 10),
        );
        const first = await client.imageAsset.findFirstOrThrow({
          where: { sessionId: session.id },
        });

        await makeup.uploadInitialImage(
          owner,
          session.id,
          await photo('webp', 20),
        );

        const images = await client.imageAsset.findMany({
          where: { sessionId: session.id },
        });
        expect(images).toHaveLength(1);
        expect(images[0].storageKey).not.toBe(first.storageKey);
        expect(bucketKeys()).toEqual([images[0].storageKey]);
        expect(await ledger()).toEqual([]);
      });

      it('fails cleanly on rejected credentials: nothing stored, nothing recorded', async () => {
        const session = await newSession(owner);
        supabase.failNext('upload', accessDenied);

        expect(
          await rejection(
            makeup.uploadInitialImage(owner, session.id, await photo()),
          ),
        ).toMatchObject({ status: 500 });

        expect(
          await client.imageAsset.count({ where: { sessionId: session.id } }),
        ).toBe(0);
        expect(bucketKeys()).toEqual([]);
        expect(await ledger()).toEqual([]);
      });

      it.each([
        ['a provider outage', unavailable],
        ['a network failure', { kind: 'network' } as const],
      ])(
        'fails cleanly on %s: no reference, and the possible write is cleaned up later',
        async (_label, failure) => {
          const session = await newSession(owner);
          supabase.failNext('upload', failure);

          expect(
            await rejection(
              makeup.uploadInitialImage(owner, session.id, await photo()),
            ),
          ).toMatchObject({ status: 503 });

          expect(
            await client.imageAsset.count({ where: { sessionId: session.id } }),
          ).toBe(0);
          const [pending] = await ledger();
          expect(pending).toMatchObject({
            reason: 'UPLOAD_ABANDONED',
            status: 'PENDING',
          });
          await makeDue();
          await expect(lifecycle.processDue()).resolves.toEqual(['DELETED']);
          expect(bucketKeys()).toEqual([]);
          expect(await ledger()).toEqual([]);
          expect(
            (
              await client.makeupSession.findUniqueOrThrow({
                where: { id: session.id },
              })
            ).status,
          ).toBe('CREATED');
        },
      );

      it('deletes a photo that was stored although the upload timed out', async () => {
        const session = await newSession(owner);
        supabase.failNext('upload', { kind: 'store-then-hang' });

        expect(
          await rejection(
            makeup.uploadInitialImage(owner, session.id, await photo()),
          ),
        ).toMatchObject({ status: 503 });

        expect(
          await client.imageAsset.count({ where: { sessionId: session.id } }),
        ).toBe(0);
        const [pending] = await ledger();
        expect(pending).toMatchObject({ reason: 'UPLOAD_ABANDONED' });
        expect(bucketKeys()).toEqual([pending.storageKey]);

        await makeDue();
        await expect(lifecycle.processDue()).resolves.toEqual(['DELETED']);
        expect(bucketKeys()).toEqual([]);
        expect(await ledger()).toEqual([]);
      });

      it('keeps a failed replacement deletion in the ledger and completes it later', async () => {
        const session = await newSession(owner);
        await makeup.uploadInitialImage(
          owner,
          session.id,
          await photo('jpeg', 1),
        );
        const old = await client.imageAsset.findFirstOrThrow({
          where: { sessionId: session.id },
        });
        supabase.failNext('remove', unavailable);

        await makeup.uploadInitialImage(
          owner,
          session.id,
          await photo('jpeg', 2),
        );

        expect(supabase.objects.has(old.storageKey)).toBe(true);
        const [pending] = await ledger();
        expect(pending).toMatchObject({
          provider: 'supabase',
          storageKey: old.storageKey,
          reason: 'IMAGE_REPLACED',
          status: 'PENDING',
          attempts: 1,
          lastErrorCode: 'STORAGE_UNAVAILABLE',
        });

        await makeDue();
        await expect(lifecycle.processDue()).resolves.toEqual(['DELETED']);
        expect(supabase.objects.has(old.storageKey)).toBe(false);
        expect(await ledger()).toEqual([]);
      });

      it('keeps exactly one photo when uploads race for the same session', async () => {
        const session = await newSession(owner);
        supabase.latencyMs = 15;

        const results = await Promise.allSettled(
          [1, 2, 3, 4].map(async (shade) =>
            makeup.uploadInitialImage(
              owner,
              session.id,
              await photo('jpeg', shade),
            ),
          ),
        );

        expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
        const images = await client.imageAsset.findMany({
          where: { sessionId: session.id },
        });
        expect(images).toHaveLength(1);
        expect(bucketKeys()).toEqual([images[0].storageKey]);
        expect(supabase.count('upload')).toBe(4);
        expect(await ledger()).toEqual([]);
      });
    });

    describe('makeup step snapshots and checks', () => {
      it('stores a snapshot linked to the step with provider and key', async () => {
        const { session, step } = await guideFixture(owner);
        const file = await photo('webp');

        await makeup.saveStepSnapshot(owner, step.id, file);

        const [image] = await client.imageAsset.findMany({
          where: { sessionId: session.id },
        });
        expect(image).toMatchObject({
          guideStepId: step.id,
          purpose: 'STEP_CHECK',
          storageProvider: 'supabase',
          mimeType: 'image/webp',
        });
        expect(image.storageKey).toMatch(
          new RegExp(`^${owner}/${session.id}/`),
        );
        expect(supabase.objects.get(image.storageKey)?.bytes).toEqual(
          file.buffer,
        );
        expect(await ledger()).toEqual([]);
      });

      it("refuses snapshots for another user's step without storing anything", async () => {
        const { step } = await guideFixture(owner);

        expect(
          await rejection(
            makeup.saveStepSnapshot(intruder, step.id, await photo()),
          ),
        ).toMatchObject({ status: 404 });
        expect(supabase.count('upload')).toBe(0);
      });

      it('removes the stored snapshot when the step advances during the upload', async () => {
        const { session, step } = await guideFixture(owner);
        supabase.afterUploadStored = async () => {
          await client.guideStep.update({
            where: { id: step.id },
            data: { status: 'COMPLETED' },
          });
        };

        expect(
          await rejection(
            makeup.saveStepSnapshot(owner, step.id, await photo()),
          ),
        ).toMatchObject({ status: 409 });

        expect(
          await client.imageAsset.count({ where: { sessionId: session.id } }),
        ).toBe(0);
        expect(bucketKeys()).toEqual([]);
        expect(await ledger()).toEqual([]);
      });

      it('keeps every snapshot when several are saved in parallel', async () => {
        const { session, step } = await guideFixture(owner);
        supabase.latencyMs = 10;

        await Promise.all(
          [1, 2, 3].map(async (shade) =>
            makeup.saveStepSnapshot(owner, step.id, await photo('jpeg', shade)),
          ),
        );

        const images = await client.imageAsset.findMany({
          where: { sessionId: session.id },
        });
        expect(images).toHaveLength(3);
        expect(bucketKeys()).toEqual(images.map((i) => i.storageKey).sort());
        expect(await ledger()).toEqual([]);
      });

      it('keeps only the winning image when identical checks race on one idempotency key', async () => {
        const { session, step } = await guideFixture(owner);
        supabase.latencyMs = 10;

        const runs = await Promise.all(
          [1, 2, 3].map(async (shade) =>
            makeup.checkStep(
              owner,
              step.id,
              'same-key',
              await photo('jpeg', shade),
            ),
          ),
        );

        expect(new Set(runs.map((run) => run.id)).size).toBe(1);
        expect(
          await client.aiRun.count({ where: { sessionId: session.id } }),
        ).toBe(1);
        const images = await client.imageAsset.findMany({
          where: { sessionId: session.id },
        });
        expect(images).toHaveLength(1);
        expect(bucketKeys()).toEqual([images[0].storageKey]);
        expect(queue.enqueue.mock.calls).toHaveLength(1);
        expect(queue.enqueue.mock.calls[0]?.[1]).toMatchObject({
          runId: runs[0].id,
          imageId: images[0].id,
        });
        expect(await ledger()).toEqual([]);
      });

      it('removes the check image when the AI run cannot be queued', async () => {
        const { session, step } = await guideFixture(owner);
        queue.enqueue.mockRejectedValueOnce(new Error('Redis down'));

        expect(
          await rejection(
            makeup.checkStep(owner, step.id, 'key-1', await photo()),
          ),
        ).toMatchObject({ status: 503 });

        expect(
          await client.imageAsset.count({ where: { sessionId: session.id } }),
        ).toBe(0);
        expect(bucketKeys()).toEqual([]);
        expect(await ledger()).toEqual([]);
      });
    });

    describe('AI worker image processing', () => {
      it('analyses the face photo read from the stored provider and key', async () => {
        const session = await newSession(owner);
        const file = await photo('jpeg', 77);
        await makeup.uploadInitialImage(owner, session.id, file);
        await makeup.savePreferences(owner, session.id, {
          vibe: 'natural',
          timeMinutes: 15,
        });
        const run = await makeup.startAnalysis(owner, session.id, 'analysis-1');
        const personalize = jest.spyOn(ai, 'personalize');

        await processor.process(
          job('PERSONALIZATION', {
            runId: run.id,
            authId: owner,
            sessionId: session.id,
          }).job,
        );

        expect(personalize.mock.calls[0]?.[0].image).toEqual({
          bytes: file.buffer,
          mimeType: 'image/jpeg',
        });
        const image = await client.imageAsset.findFirstOrThrow({
          where: { sessionId: session.id },
        });
        expect(supabase.requests).toContainEqual({
          op: 'download',
          key: image.storageKey,
        });
        expect(
          await client.aiRun.findUniqueOrThrow({ where: { id: run.id } }),
        ).toMatchObject({ status: 'COMPLETED' });
        expect(
          (
            await client.makeupSession.findUniqueOrThrow({
              where: { id: session.id },
            })
          ).status,
        ).toBe('RECOMMENDATIONS_READY');
      });

      it('evaluates the step check image from private storage', async () => {
        const { step } = await guideFixture(owner);
        const file = await photo('png', 33);
        const run = await makeup.checkStep(owner, step.id, 'check-1', file);
        const payload = queue.enqueue.mock.calls[0][1];
        const evaluate = jest.spyOn(ai, 'evaluateStep');

        await processor.process(job('VISION_CHECK', payload).job);

        expect(evaluate.mock.calls[0]?.[0].image).toEqual({
          bytes: file.buffer,
          mimeType: 'image/png',
        });
        expect(
          await client.stepAttempt.count({
            where: { imageId: payload.imageId },
          }),
        ).toBe(1);
        expect(
          await client.aiRun.findUniqueOrThrow({ where: { id: run.id } }),
        ).toMatchObject({ status: 'COMPLETED' });
      });

      it('fails the run immediately, with a safe message, when the stored image is gone', async () => {
        const { step } = await guideFixture(owner);
        const run = await makeup.checkStep(
          owner,
          step.id,
          'check-2',
          await photo(),
        );
        const payload = queue.enqueue.mock.calls[0][1];
        supabase.objects.clear();
        const { job: vision, discard } = job('VISION_CHECK', payload);

        expect(await rejection(processor.process(vision))).toMatchObject({
          code: 'IMAGE_NOT_FOUND',
        });
        expect(discard).toHaveBeenCalledTimes(1);
        expect(
          await client.aiRun.findUniqueOrThrow({ where: { id: run.id } }),
        ).toMatchObject({
          status: 'FAILED',
          error:
            'The photo for this request is no longer available. Please upload it again.',
        });
      });

      it('keeps the run retryable when storage is temporarily unavailable', async () => {
        const { step } = await guideFixture(owner);
        const run = await makeup.checkStep(
          owner,
          step.id,
          'check-3',
          await photo(),
        );
        const payload = queue.enqueue.mock.calls[0][1];
        supabase.failNext('download', unavailable);
        const { job: vision, discard } = job('VISION_CHECK', payload);

        expect(await rejection(processor.process(vision))).toMatchObject({
          code: 'IMAGE_STORAGE_UNAVAILABLE',
        });
        expect(discard).not.toHaveBeenCalled();
        expect(
          await client.aiRun.findUniqueOrThrow({ where: { id: run.id } }),
        ).toMatchObject({ status: 'QUEUED' });
      });

      it("never reads another user's image, even with a forged job payload", async () => {
        const { step } = await guideFixture(owner);
        await makeup.checkStep(owner, step.id, 'check-4', await photo());
        const payload = queue.enqueue.mock.calls[0][1];
        const downloadsBefore = supabase.count('download');

        await expect(
          processor.process(
            job('VISION_CHECK', { ...payload, authId: intruder }).job,
          ),
        ).rejects.toBeDefined();
        expect(supabase.count('download')).toBe(downloadsBefore);
      });
    });

    describe('profile avatars', () => {
      let user: string;
      const avatarRow = () =>
        client.userProfile.findUnique({
          where: { authId: user },
          select: { avatarUrl: true, avatarStorageProvider: true },
        });

      beforeEach(async () => {
        user = await createUser(client);
      });

      it('stores a first avatar privately and serves it through the content route', async () => {
        const file = await photo('png');

        await expect(profile.updateAvatar(user, file)).resolves.toMatchObject({
          avatarUrl: '/v1/profile/avatar/content',
        });

        const row = await avatarRow();
        expect(row?.avatarStorageProvider).toBe('supabase');
        expect(row?.avatarUrl).toMatch(
          new RegExp(`^${user}/profile/[0-9a-f-]{36}\\.png$`),
        );
        expect(supabase.objects.get(row?.avatarUrl as string)?.bytes).toEqual(
          file.buffer,
        );
        await expect(profile.getAvatarContent(user)).resolves.toEqual({
          bytes: file.buffer,
          mimeType: 'image/png',
        });
        expect(
          await rejection(profile.getAvatarContent(intruder)),
        ).toMatchObject({
          status: 404,
        });
      });

      it('deletes the previous avatar on replacement', async () => {
        await profile.updateAvatar(user, await photo('png', 1));
        const first = (await avatarRow())?.avatarUrl as string;

        await profile.updateAvatar(user, await photo('webp', 2));

        const second = (await avatarRow())?.avatarUrl as string;
        expect(second).not.toBe(first);
        expect(bucketKeys()).toEqual([second]);
        expect(await ledger()).toEqual([]);
      });

      it('keeps external (Google) avatars working and never deletes them', async () => {
        const google = 'https://lh3.googleusercontent.com/a/photo';
        await client.userProfile.create({
          data: { authId: user, avatarUrl: google },
        });

        await expect(profile.getProfile(user)).resolves.toMatchObject({
          avatarUrl: google,
        });
        expect(await rejection(profile.getAvatarContent(user))).toMatchObject({
          status: 404,
        });

        await profile.updateAvatar(user, await photo());
        expect(supabase.count('remove')).toBe(0);
        expect(await ledger()).toEqual([]);
        await expect(profile.getProfile(user)).resolves.toMatchObject({
          avatarUrl: '/v1/profile/avatar/content',
        });

        await client.userProfile.update({
          where: { authId: user },
          data: {
            avatarUrl: google,
            avatarStorageProvider: null,
          },
        });
        supabase.objects.clear();
        await profile.deleteAvatar(user);
        expect(await avatarRow()).toEqual({
          avatarUrl: null,
          avatarStorageProvider: null,
        });
        expect(supabase.count('remove')).toBe(0);
      });

      it('removes the avatar object when the avatar is deleted', async () => {
        await profile.updateAvatar(user, await photo());

        await expect(profile.deleteAvatar(user)).resolves.toMatchObject({
          avatarUrl: null,
        });

        expect(await avatarRow()).toEqual({
          avatarUrl: null,
          avatarStorageProvider: null,
        });
        expect(bucketKeys()).toEqual([]);
        expect(await ledger()).toEqual([]);
      });

      it('leaves the current avatar untouched when the upload fails', async () => {
        await profile.updateAvatar(user, await photo('jpeg', 1));
        const current = await avatarRow();
        supabase.failNext('upload', unavailable);

        expect(
          await rejection(profile.updateAvatar(user, await photo('jpeg', 2))),
        ).toMatchObject({ status: 503 });

        expect(await avatarRow()).toEqual(current);
        expect(bucketKeys()).toEqual([current?.avatarUrl]);
        await makeDue();
        await lifecycle.processDue();
        expect(await avatarRow()).toEqual(current);
        expect(bucketKeys()).toEqual([current?.avatarUrl]);
        expect(await ledger()).toEqual([]);
      });

      it('records a failed avatar deletion and completes it on a later pass', async () => {
        await profile.updateAvatar(user, await photo('jpeg', 1));
        const old = (await avatarRow())?.avatarUrl as string;
        supabase.failNext('remove', unavailable);

        await profile.updateAvatar(user, await photo('jpeg', 2));

        expect(await ledger()).toEqual([
          expect.objectContaining({
            storageKey: old,
            reason: 'AVATAR_REPLACED',
            status: 'PENDING',
            lastErrorCode: 'STORAGE_UNAVAILABLE',
          }),
        ]);
        await makeDue();
        await expect(lifecycle.processDue()).resolves.toEqual(['DELETED']);
        expect(bucketKeys()).toEqual([(await avatarRow())?.avatarUrl]);
      });

      it.each([
        ['first avatars (no profile row yet)', false],
        ['replacements of an existing avatar', true],
      ])('keeps exactly one avatar when %s race', async (_label, existing) => {
        if (existing)
          await profile.updateAvatar(user, await photo('jpeg', 200));
        supabase.latencyMs = 15;

        const results = await Promise.allSettled(
          [1, 2, 3, 4].map(async (shade) =>
            profile.updateAvatar(user, await photo('jpeg', shade)),
          ),
        );

        expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
        const row = await avatarRow();
        expect(row?.avatarStorageProvider).toBe('supabase');
        expect(bucketKeys()).toEqual([row?.avatarUrl]);
        expect(await ledger()).toEqual([]);
      });

      it('rejects inconsistent avatar rows at the database level', async () => {
        await expect(
          client.userProfile.create({
            data: { authId: user, avatarUrl: `${user}/profile/x.jpg` },
          }),
        ).rejects.toThrow();
        await expect(
          client.userProfile.create({
            data: {
              authId: user,
              avatarUrl: 'https://lh3.googleusercontent.com/a/photo',
              avatarStorageProvider: 'supabase',
            },
          }),
        ).rejects.toThrow();
      });
    });

    describe('failure atomicity and cross-user isolation', () => {
      async function uploadedSession(authId: string) {
        const session = await newSession(authId);
        await makeup.uploadInitialImage(
          authId,
          session.id,
          await photo('jpeg', 5),
        );
        const image = await client.imageAsset.findFirstOrThrow({
          where: { sessionId: session.id },
        });
        return { session, image };
      }

      const expectIntact = async (image: {
        id: string;
        storageKey: string;
      }) => {
        expect(
          await client.imageAsset.findUnique({ where: { id: image.id } }),
        ).not.toBeNull();
        expect(supabase.objects.has(image.storageKey)).toBe(true);
      };

      describe('failed uploads', () => {
        it('cleans up an upload that lands after the client gave up (no orphan, no reference)', async () => {
          const session = await newSession(owner);
          supabase.failNext('upload', {
            kind: 'hang-then-store',
            landAfterMs: 50,
          });

          expect(
            await rejection(
              makeup.uploadInitialImage(owner, session.id, await photo()),
            ),
          ).toMatchObject({ status: 503 });
          await supabase.settle(); // the slow write has now landed

          expect(
            await client.imageAsset.count({ where: { sessionId: session.id } }),
          ).toBe(0);
          const [pending] = await ledger();
          expect(pending).toMatchObject({
            reason: 'UPLOAD_ABANDONED',
            status: 'PENDING',
          });
          expect(bucketKeys()).toEqual([pending.storageKey]);

          await makeDue();
          await expect(lifecycle.processDue()).resolves.toEqual(['DELETED']);
          expect(bucketKeys()).toEqual([]);
          expect(await ledger()).toEqual([]);
        });

        it('does not delete an ambiguous upload right away, before a late write could land', async () => {
          const session = await newSession(owner);
          supabase.failNext('upload', unavailable);

          await rejection(
            makeup.uploadInitialImage(owner, session.id, await photo()),
          );

          const [pending] = await ledger();
          expect(pending.reason).toBe('UPLOAD_ABANDONED');
          expect(pending.nextAttemptAt.getTime()).toBeGreaterThan(
            Date.now() + 5 * 60_000,
          );
          expect(supabase.count('remove')).toBe(0);
          await expect(lifecycle.processDue()).resolves.toEqual([]);
        });

        it('rolls back a photo replacement whose image row cannot be written', async () => {
          const { session, image } = await uploadedSession(owner);
          await injectDbFailure('ImageAsset', 'INSERT');

          expect(
            await rejection(
              makeup.uploadInitialImage(owner, session.id, await photo('png')),
            ),
          ).toMatchObject({
            message: expect.stringContaining(
              'injected database failure',
            ) as string,
          });

          await expectIntact(image);
          expect(bucketKeys()).toEqual([image.storageKey]);
          expect(await ledger()).toEqual([]);
          expect(
            (
              await client.makeupSession.findUniqueOrThrow({
                where: { id: session.id },
              })
            ).status,
          ).toBe('IMAGE_UPLOADED');
        });

        it('rolls back a photo replacement whose old-image deletion cannot be recorded', async () => {
          const { session, image } = await uploadedSession(owner);
          await injectDbFailure(
            'PrivateStorageCleanup',
            'INSERT',
            `NEW.reason = 'IMAGE_REPLACED'`,
          );

          await expect(
            makeup.uploadInitialImage(owner, session.id, await photo('png')),
          ).rejects.toThrow('injected database failure');

          await expectIntact(image);
          expect(bucketKeys()).toEqual([image.storageKey]);
          expect(
            await client.imageAsset.count({ where: { sessionId: session.id } }),
          ).toBe(1);
          expect(await ledger()).toEqual([]);
        });

        it('keeps the reservation when the database is unavailable during rollback, then cleans up later', async () => {
          const { session, image } = await uploadedSession(owner);
          await injectDbFailure('ImageAsset', 'INSERT');
          await injectDbFailure('PrivateStorageCleanup', 'UPDATE');

          await expect(
            makeup.uploadInitialImage(owner, session.id, await photo('png')),
          ).rejects.toThrow('injected database failure');

          const [reservation] = await ledger();
          expect(reservation).toMatchObject({
            reason: 'UPLOAD_PENDING',
            status: 'PENDING',
          });
          expect(bucketKeys().sort()).toEqual(
            [image.storageKey, reservation.storageKey].sort(),
          );
          await expect(lifecycle.processDue()).resolves.toEqual([]);

          await removeInjectedFailures();
          await makeDue();
          await expect(lifecycle.processDue()).resolves.toEqual(['DELETED']);
          expect(bucketKeys()).toEqual([image.storageKey]);
          await expectIntact(image);
        });

        it('refuses a replacement when analysis starts during the upload, keeping the analysed photo', async () => {
          const { session, image } = await uploadedSession(owner);
          supabase.afterUploadStored = async () => {
            await client.makeupSession.update({
              where: { id: session.id },
              data: { status: 'ANALYZING' },
            });
          };

          expect(
            await rejection(
              makeup.uploadInitialImage(owner, session.id, await photo('png')),
            ),
          ).toMatchObject({ status: 409 });

          await expectIntact(image);
          expect(bucketKeys()).toEqual([image.storageKey]);
          expect(await ledger()).toEqual([]);
        });
      });

      describe('failed removals', () => {
        it('never treats a removal that Supabase silently skipped as done', async () => {
          const { session, image } = await uploadedSession(owner);
          supabase.failNext('remove', { kind: 'silent-noop' });

          await makeup.uploadInitialImage(
            owner,
            session.id,
            await photo('png'),
          );

          expect(supabase.objects.has(image.storageKey)).toBe(true);
          expect(await ledger()).toEqual([
            expect.objectContaining({
              storageKey: image.storageKey,
              reason: 'IMAGE_REPLACED',
              status: 'PENDING',
              attempts: 1,
              lastErrorCode: 'DELETE_NOT_APPLIED',
            }),
          ]);

          await makeDue();
          await expect(lifecycle.processDue()).resolves.toEqual(['DELETED']);
          expect(supabase.objects.has(image.storageKey)).toBe(false);
          expect(await ledger()).toEqual([]);
        });

        it('keeps a completed session intact when its image deletions cannot be recorded', async () => {
          const { session, step } = await guideFixture(owner);
          await makeup.saveStepSnapshot(owner, step.id, await photo());
          await client.makeupSession.update({
            where: { id: session.id },
            data: { status: 'COMPLETED' },
          });
          await injectDbFailure(
            'PrivateStorageCleanup',
            'INSERT',
            `NEW.reason = 'SESSION_DELETED'`,
          );

          await expect(makeup.deleteSession(owner, session.id)).rejects.toThrow(
            'injected database failure',
          );

          expect(
            await client.makeupSession.findUnique({
              where: { id: session.id },
            }),
          ).not.toBeNull();
          const [image] = await client.imageAsset.findMany({
            where: { sessionId: session.id },
          });
          await expectIntact(image);
          expect(supabase.count('remove')).toBe(0);
        });

        it('deletes a session exactly once when deletions race', async () => {
          const { session, step } = await guideFixture(owner);
          await makeup.saveStepSnapshot(owner, step.id, await photo('jpeg', 1));
          await makeup.saveStepSnapshot(owner, step.id, await photo('jpeg', 2));
          await client.makeupSession.update({
            where: { id: session.id },
            data: { status: 'COMPLETED' },
          });
          supabase.latencyMs = 10;

          const results = await Promise.allSettled(
            [1, 2, 3].map(() => makeup.deleteSession(owner, session.id)),
          );

          expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(
            1,
          );
          for (const result of results) {
            if (result.status === 'rejected') {
              expect([404, 409]).toContain(
                (result.reason as { status?: number }).status,
              );
            }
          }
          expect(bucketKeys()).toEqual([]);
          expect(supabase.count('remove')).toBe(2);
          expect(await ledger()).toEqual([]);
        });
      });

      describe('avatar replacement and removal', () => {
        let user: string;
        const avatarRow = () =>
          client.userProfile.findUniqueOrThrow({
            where: { authId: user },
            select: { avatarUrl: true, avatarStorageProvider: true },
          });

        beforeEach(async () => {
          user = await createUser(client);
          await profile.updateAvatar(user, await photo('jpeg', 9));
        });

        it('keeps the current avatar when the profile write fails, and removes the new upload', async () => {
          const before = await avatarRow();
          await injectDbFailure('userProfile', 'UPDATE');

          await expect(
            profile.updateAvatar(user, await photo('png')),
          ).rejects.toThrow('injected database failure');

          expect(await avatarRow()).toEqual(before);
          expect(bucketKeys()).toEqual([before.avatarUrl]);
          expect(await ledger()).toEqual([]);
        });

        it('keeps the current avatar when its deletion cannot be recorded', async () => {
          const before = await avatarRow();
          await injectDbFailure(
            'PrivateStorageCleanup',
            'INSERT',
            `NEW.reason = 'AVATAR_REPLACED'`,
          );

          await expect(
            profile.updateAvatar(user, await photo('png')),
          ).rejects.toThrow('injected database failure');

          expect(await avatarRow()).toEqual(before);
          expect(bucketKeys()).toEqual([before.avatarUrl]);
          expect(await ledger()).toEqual([]);
        });

        it('keeps the avatar when its removal cannot be recorded', async () => {
          const before = await avatarRow();
          await injectDbFailure(
            'PrivateStorageCleanup',
            'INSERT',
            `NEW.reason = 'AVATAR_REMOVED'`,
          );

          await expect(profile.deleteAvatar(user)).rejects.toThrow(
            'injected database failure',
          );

          expect(await avatarRow()).toEqual(before);
          expect(bucketKeys()).toEqual([before.avatarUrl]);
        });

        it('ends consistent when replacements and removals race', async () => {
          supabase.latencyMs = 10;

          const results = await Promise.allSettled([
            profile.updateAvatar(user, await photo('jpeg', 1)),
            profile.deleteAvatar(user),
            profile.updateAvatar(user, await photo('jpeg', 2)),
            profile.deleteAvatar(user),
            profile.updateAvatar(user, await photo('jpeg', 3)),
          ]);

          expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
          const row = await avatarRow();
          expect(bucketKeys()).toEqual(row.avatarUrl ? [row.avatarUrl] : []);
          expect(row.avatarStorageProvider).toBe(
            row.avatarUrl ? 'supabase' : null,
          );
          expect(await ledger()).toEqual([]);
        });
      });

      describe("other users' images", () => {
        it("are never deleted by another user's replacements, removals or session deletions", async () => {
          const victim = await createUser(client);
          const attacker = await createUser(client);
          const { image: victimPhoto } = await uploadedSession(victim);
          const victimGuide = await guideFixture(victim);
          await makeup.saveStepSnapshot(
            victim,
            victimGuide.step.id,
            await photo(),
          );
          await client.makeupSession.update({
            where: { id: victimGuide.session.id },
            data: { status: 'COMPLETED' },
          });
          await profile.updateAvatar(victim, await photo('png'));
          const victimKeys = bucketKeys();

          const { session: attackerSession } = await uploadedSession(attacker);
          await makeup.uploadInitialImage(
            attacker,
            attackerSession.id,
            await photo('webp'),
          );
          await profile.updateAvatar(attacker, await photo('jpeg', 1));
          await profile.updateAvatar(attacker, await photo('jpeg', 2));
          await profile.deleteAvatar(attacker);
          expect(
            await rejection(
              makeup.deleteSession(attacker, victimGuide.session.id),
            ),
          ).toMatchObject({ status: 404 });
          expect(
            await rejection(
              makeup.uploadInitialImage(
                attacker,
                victimPhoto.sessionId,
                await photo(),
              ),
            ),
          ).toMatchObject({ status: 404 });
          await makeDue();
          await lifecycle.processDue();

          for (const key of victimKeys)
            expect(supabase.objects.has(key)).toBe(true);
          await expectIntact(victimPhoto);
          expect(
            await client.makeupSession.findUnique({
              where: { id: victimGuide.session.id },
            }),
          ).not.toBeNull();
          expect(
            (
              await client.userProfile.findUniqueOrThrow({
                where: { authId: victim },
              })
            ).avatarUrl,
          ).toBe(victimKeys.find((key) => key.includes('/profile/')));
        });

        it("refuses a stray cleanup row that points at another user's referenced image", async () => {
          const { image } = await uploadedSession(owner);
          await client.privateStorageCleanup.create({
            data: {
              provider: 'supabase',
              storageKey: image.storageKey,
              reason: 'SESSION_DELETED',
            },
          });

          await expect(lifecycle.processDue()).resolves.toEqual([
            'SKIPPED_REFERENCED',
          ]);
          await expectIntact(image);
          expect(supabase.count('remove')).toBe(0);
        });

        it.each([
          ['a user folder', (u: string) => u],
          ['a user folder with a slash', (u: string) => `${u}/`],
          ['a session folder', (u: string, s: string) => `${u}/${s}`],
          ['an empty key', () => ''],
        ])(
          'never sends %s to Supabase, so a prefix can never wipe other images',
          async (_label, keyFor) => {
            const { session, image } = await uploadedSession(owner);
            await client.privateStorageCleanup.create({
              data: {
                provider: 'supabase',
                storageKey: keyFor(owner, session.id),
                reason: 'SESSION_DELETED',
              },
            });

            await expect(lifecycle.processDue()).resolves.toEqual(['FAILED']);
            expect(supabase.count('remove')).toBe(0);
            await expectIntact(image);
            expect(await ledger()).toEqual([
              expect.objectContaining({
                status: 'FAILED',
                lastErrorCode: 'INVALID_STORAGE_KEY',
              }),
            ]);
          },
        );
      });
    });

    describe('avatar signed URLs (end to end)', () => {
      let user: string;
      const avatarRow = () =>
        client.userProfile.findUnique({
          where: { authId: user },
          select: { avatarUrl: true, avatarStorageProvider: true },
        });
      const download = (url: string) => supabase.fetch(url);
      const userAvatarObjects = () =>
        bucketKeys().filter((key) => key.startsWith(`${user}/profile/`));

      /**
       * The invariant: a profile either has no private avatar, or points to an
       * object that exists and whose fresh signed URL downloads exactly it.
       */
      async function expectValidAvatarPointer() {
        const row = await avatarRow();
        if (row?.avatarStorageProvider) {
          const key = row.avatarUrl as string;
          expect(supabase.objects.has(key)).toBe(true);
          const signed = await profile.getAvatarSignedUrl(user);
          const response = await download(signed.url);
          expect(response.status).toBe(200);
          expect(Buffer.from(await response.arrayBuffer())).toEqual(
            supabase.objects.get(key)?.bytes,
          );
        }
        return row;
      }

      /** After cleanup, only the referenced avatar (if any) remains. */
      async function expectNoStrayAvatarObjects() {
        await makeDue();
        await lifecycle.processDue();
        const row = await expectValidAvatarPointer();
        expect(userAvatarObjects()).toEqual(
          row?.avatarStorageProvider ? [row.avatarUrl] : [],
        );
      }

      beforeEach(async () => {
        user = await createUser(client);
      });

      it('downloads exactly the uploaded avatar, expires after 60 s, and can be re-issued', async () => {
        const file = await photo('png', 42);
        await profile.updateAvatar(user, file);

        const first = await profile.getAvatarSignedUrl(user);
        expect(first.expiresInSeconds).toBe(60);
        const ok = await download(first.url);
        expect(ok.status).toBe(200);
        expect(Buffer.from(await ok.arrayBuffer())).toEqual(file.buffer);

        supabase.clockOffsetMs = 61_000;
        expect((await download(first.url)).status).not.toBe(200);

        const second = await profile.getAvatarSignedUrl(user);
        expect(second.url).not.toBe(first.url);
        expect((await download(second.url)).status).toBe(200);
      });

      it("keeps every user to their own avatar: URLs are scoped to the caller's object", async () => {
        const other = await createUser(client);
        await profile.updateAvatar(user, await photo('png', 1));
        await profile.updateAvatar(other, await photo('png', 2));
        const mine = await profile.getAvatarSignedUrl(user);
        const theirs = await profile.getAvatarSignedUrl(other);
        const myKey = (await avatarRow())?.avatarUrl as string;

        expect(new URL(mine.url).pathname).toContain(`/${myKey}`);
        expect(new URL(theirs.url).pathname).not.toContain(user);
        // My token cannot be replayed against the other user's object.
        const replay = new URL(mine.url);
        replay.pathname = new URL(theirs.url).pathname;
        expect((await download(replay.toString())).status).not.toBe(200);
      });

      it('keeps external avatars working, unsigned, and never touches storage for them', async () => {
        const google = 'https://lh3.googleusercontent.com/a/photo';
        await client.userProfile.create({
          data: { authId: user, avatarUrl: google },
        });

        expect(await rejection(profile.getAvatarSignedUrl(user))).toMatchObject(
          {
            status: 409,
          },
        );
        await expect(profile.getProfile(user)).resolves.toMatchObject({
          avatarUrl: google,
        });
        expect(supabase.requests).toHaveLength(0);

        await profile.updateAvatar(user, await photo());
        await expectNoStrayAvatarObjects();
        expect(supabase.count('remove')).toBe(0);
      });

      it('after a change, points to the new object and the old URL stops working', async () => {
        await profile.updateAvatar(user, await photo('jpeg', 1));
        const oldUrl = (await profile.getAvatarSignedUrl(user)).url;

        const next = await photo('webp', 2);
        await profile.updateAvatar(user, next);

        const row = await expectValidAvatarPointer();
        expect(supabase.objects.get(row?.avatarUrl as string)?.bytes).toEqual(
          next.buffer,
        );
        expect((await download(oldUrl)).status).not.toBe(200);
        await expectNoStrayAvatarObjects();
      });

      it('after deletion, no URL can be issued and the old one stops working', async () => {
        await profile.updateAvatar(user, await photo());
        const oldUrl = (await profile.getAvatarSignedUrl(user)).url;

        await profile.deleteAvatar(user);

        expect(await rejection(profile.getAvatarSignedUrl(user))).toMatchObject(
          {
            status: 404,
          },
        );
        expect((await download(oldUrl)).status).not.toBe(200);
        await expectNoStrayAvatarObjects();
      });

      it('after a deletion whose object removal fails, the profile is cleared and the object stays tracked', async () => {
        await profile.updateAvatar(user, await photo());
        const key = (await avatarRow())?.avatarUrl as string;
        supabase.failNext('remove', unavailable);

        await profile.deleteAvatar(user);

        expect(await avatarRow()).toEqual({
          avatarUrl: null,
          avatarStorageProvider: null,
        });
        expect(await rejection(profile.getAvatarSignedUrl(user))).toMatchObject(
          {
            status: 404,
          },
        );
        expect(await ledger()).toEqual([
          expect.objectContaining({
            storageKey: key,
            reason: 'AVATAR_REMOVED',
            status: 'PENDING',
          }),
        ]);
        await expectNoStrayAvatarObjects();
      });

      it.each([
        [
          'the upload fails (outage)',
          () => Promise.resolve(supabase.failNext('upload', unavailable)),
        ],
        [
          'the upload times out after storing',
          () =>
            Promise.resolve(
              supabase.failNext('upload', { kind: 'store-then-hang' }),
            ),
        ],
        [
          'the profile write fails',
          () => injectDbFailure('userProfile', 'UPDATE'),
        ],
        [
          "the old avatar's deletion cannot be recorded",
          () =>
            injectDbFailure(
              'PrivateStorageCleanup',
              'INSERT',
              `NEW.reason = 'AVATAR_REPLACED'`,
            ),
        ],
      ])(
        'keeps the profile on the existing, downloadable avatar when %s',
        async (_label, inject) => {
          const original = await photo('jpeg', 3);
          await profile.updateAvatar(user, original);
          const before = await avatarRow();
          const oldUrl = (await profile.getAvatarSignedUrl(user)).url;
          await inject();

          await expect(
            profile.updateAvatar(user, await photo('png', 4)),
          ).rejects.toBeDefined();
          await removeInjectedFailures();

          expect(await avatarRow()).toEqual(before);
          const stillOk = await download(oldUrl);
          expect(stillOk.status).toBe(200);
          expect(Buffer.from(await stillOk.arrayBuffer())).toEqual(
            original.buffer,
          );
          await expectNoStrayAvatarObjects();
        },
      );

      it('leaves the profile untouched when signing fails', async () => {
        await profile.updateAvatar(user, await photo());
        const before = await avatarRow();
        supabase.failNext('sign', unavailable);

        expect(await rejection(profile.getAvatarSignedUrl(user))).toMatchObject(
          {
            status: 503,
          },
        );
        expect(await avatarRow()).toEqual(before);
        await expectValidAvatarPointer();
      });

      it('reports a missing object as 404 without rewriting the profile', async () => {
        await profile.updateAvatar(user, await photo());
        const before = await avatarRow();
        supabase.objects.clear();

        expect(await rejection(profile.getAvatarSignedUrl(user))).toMatchObject(
          {
            status: 404,
          },
        );
        expect(await avatarRow()).toEqual(before);
      });

      it('always leaves a signable avatar or none when changes, deletions and URL requests race', async () => {
        await profile.updateAvatar(user, await photo('jpeg', 100));
        supabase.latencyMs = 10;
        const files = await Promise.all([1, 2, 3].map((n) => photo('jpeg', n)));

        const results = await Promise.allSettled([
          profile.updateAvatar(user, files[0]),
          profile.getAvatarSignedUrl(user),
          profile.deleteAvatar(user),
          profile.getAvatarSignedUrl(user),
          profile.updateAvatar(user, files[1]),
          profile.deleteAvatar(user),
          profile.getAvatarSignedUrl(user),
          profile.updateAvatar(user, files[2]),
          profile.getAvatarSignedUrl(user),
        ]);

        for (const result of results) {
          if (result.status === 'rejected') {
            // A URL request racing a deletion may find no avatar; nothing else fails.
            expect((result.reason as { status?: number }).status).toBe(404);
          }
        }
        supabase.latencyMs = 0;
        await expectNoStrayAvatarObjects();
        expect(await ledger()).toEqual([]);
      });
    });

    describe('signed URL expiry follows the storage provider', () => {
      const claimsOf = (url: string) =>
        JSON.parse(
          Buffer.from(
            (new URL(url).searchParams.get('token') as string).split('.')[1],
            'base64url',
          ).toString(),
        ) as { iat: number; exp: number };

      it('uses the provider expiry when signing takes real time (image and avatar)', async () => {
        const session = await newSession(owner);
        await makeup.uploadInitialImage(owner, session.id, await photo());
        const image = await client.imageAsset.findFirstOrThrow({
          where: { sessionId: session.id },
        });
        const user = await createUser(client);
        await profile.updateAvatar(user, await photo('png'));
        supabase.latencyMs = 1_100;

        for (const sign of [
          () => makeup.getImageSignedUrl(owner, image.id),
          () => profile.getAvatarSignedUrl(user),
        ]) {
          const requestedAt = Date.now();
          const signed = await sign();
          const claims = claimsOf(signed.url);

          expect(Date.parse(signed.expiresAt)).toBe(claims.exp * 1000);
          expect(signed.expiresInSeconds).toBe(claims.exp - claims.iat);
          expect(signed.expiresInSeconds).toBe(60);
          // Supabase signed after the delay, so its expiry is later than the
          // old local estimate (request time + 60 s) would have claimed.
          expect(Date.parse(signed.expiresAt)).toBeGreaterThan(
            requestedAt + 60_000,
          );
        }
      });

      it("reports the provider's clock when it differs from the API's, and the URL works for that window", async () => {
        const user = await createUser(client);
        await profile.updateAvatar(user, await photo('png'));
        supabase.clockOffsetMs = -5 * 60_000; // Storage runs 5 minutes behind

        const before = Date.now();
        const signed = await profile.getAvatarSignedUrl(user);
        const claims = claimsOf(signed.url);

        expect(Date.parse(signed.expiresAt)).toBe(claims.exp * 1000);
        expect(signed.expiresInSeconds).toBe(60);
        expect(Date.parse(signed.expiresAt)).toBeLessThan(before);
        expect((await supabase.fetch(signed.url)).status).toBe(200);
        supabase.clockOffsetMs += 61_000;
        expect((await supabase.fetch(signed.url)).status).not.toBe(200);
      });
    });

    describe('switching the default storage provider', () => {
      const s3 = new FakeS3CompatibleStorage();
      const logger = mock<Logger>();
      const supabaseProvider = () =>
        new SupabaseStorageProvider(
          {
            storageUrl: FAKE_SUPABASE.url,
            serviceKey: FAKE_SUPABASE.serviceKey,
            bucket: FAKE_SUPABASE.bucket,
            timeoutMs: 300,
          },
          supabase.fetch,
        );

      /** The services as a deployment with this registry and default would build them. */
      function stack(
        activeProvider: string,
        providers: PrivateObjectStorageProvider[],
      ) {
        const storageService = new PrivateImageStorageService(
          providers,
          { activeProvider, localRoot: '/nonexistent' },
          logger,
        );
        const lifecycleService = new PrivateImageLifecycleService(
          prisma,
          storageService,
          new ConfigService({ NODE_ENV: 'test' }),
          logger,
        );
        const validation = new ImageValidationService();
        return {
          storage: storageService,
          lifecycle: lifecycleService,
          makeup: new MakeupService(
            prisma,
            queue,
            validation,
            storageService,
            lifecycleService,
            ai,
          ),
          profile: new ProfileService(
            prisma,
            validation,
            storageService,
            lifecycleService,
          ),
          processor: new MakeupJobHandler(
            prisma,
            ai,
            storageService,
            logger,
            new ConfigService(),
            creditsNotUnderTest,
          ),
        };
      }
      const supabaseDefault = () => stack('supabase', [supabaseProvider(), s3]);
      const s3Default = () => stack('fake-s3', [supabaseProvider(), s3]);
      const withoutS3 = () => stack('supabase', [supabaseProvider()]);

      beforeEach(() => s3.reset());

      async function sessionWithPhoto(
        app: ReturnType<typeof stack>,
        authId = owner,
      ) {
        const session = await newSession(authId);
        const file = await photo('jpeg', 30);
        await app.makeup.uploadInitialImage(authId, session.id, file);
        const image = await client.imageAsset.findFirstOrThrow({
          where: { sessionId: session.id },
        });
        return { session, image, file };
      }

      it('stores every new upload with the configured provider and records it', async () => {
        const app = s3Default();
        const { session: photoSession } = await sessionWithPhoto(app);
        const { session: guideSession, step } = await guideFixture(owner);
        await app.makeup.saveStepSnapshot(owner, step.id, await photo('png'));
        await app.makeup.checkStep(
          owner,
          step.id,
          's3-check',
          await photo('webp'),
        );
        const user = await createUser(client);
        await app.profile.updateAvatar(user, await photo('png', 7));

        // Photo, snapshot and check image: every row records the new default.
        const rows = await client.imageAsset.findMany({
          where: { sessionId: { in: [photoSession.id, guideSession.id] } },
        });
        expect(rows.map((row) => row.storageProvider)).toEqual([
          'fake-s3',
          'fake-s3',
          'fake-s3',
        ]);
        expect(
          (
            await client.userProfile.findUniqueOrThrow({
              where: { authId: user },
            })
          ).avatarStorageProvider,
        ).toBe('fake-s3');
        expect(s3.objects.size).toBe(4);
        expect(supabase.count('upload')).toBe(0);

        // The AI worker reads the check image from the provider that stored it.
        const payload = queue.enqueue.mock.calls[0][1];
        const evaluate = jest.spyOn(ai, 'evaluateStep');
        await app.processor.process(job('VISION_CHECK', payload).job);
        expect(s3.calls).toContainEqual({
          op: 'get',
          key: expect.any(String) as string,
        });
        expect(evaluate.mock.calls[0]?.[0].image.bytes).toEqual(
          s3.objects.get(
            (
              await client.imageAsset.findUniqueOrThrow({
                where: { id: payload.imageId },
              })
            ).storageKey,
          )?.bytes,
        );
      });

      it('keeps serving, signing and processing images stored before the switch from their own provider', async () => {
        const before = supabaseDefault();
        const { session, image, file } = await sessionWithPhoto(before);
        const user = await createUser(client);
        await before.profile.updateAvatar(user, await photo('png', 9));
        await before.makeup.savePreferences(owner, session.id, {
          vibe: 'natural',
          timeMinutes: 10,
        });

        const after = s3Default();
        await expect(
          after.makeup.getImageContent(owner, image.id),
        ).resolves.toEqual({
          mimeType: 'image/jpeg',
          bytes: file.buffer,
        });
        const signed = await after.makeup.getImageSignedUrl(owner, image.id);
        expect(signed.url.startsWith(FAKE_SUPABASE.url)).toBe(true);
        expect((await supabase.fetch(signed.url)).status).toBe(200);
        const avatarUrl = await after.profile.getAvatarSignedUrl(user);
        expect((await supabase.fetch(avatarUrl.url)).status).toBe(200);

        const run = await after.makeup.startAnalysis(
          owner,
          session.id,
          'after-switch',
        );
        const personalize = jest.spyOn(ai, 'personalize');
        await after.processor.process(
          job('PERSONALIZATION', {
            runId: run.id,
            authId: owner,
            sessionId: session.id,
          }).job,
        );
        expect(personalize.mock.calls[0]?.[0].image.bytes).toEqual(file.buffer);
        expect(s3.calls).toEqual([]);
      });

      it('removes old-provider images from their own provider when they are replaced or deleted', async () => {
        const before = supabaseDefault();
        const { session, image: oldPhoto } = await sessionWithPhoto(before);
        const user = await createUser(client);
        await before.profile.updateAvatar(user, await photo('png', 1));
        const oldAvatar = (
          await client.userProfile.findUniqueOrThrow({
            where: { authId: user },
          })
        ).avatarUrl as string;

        const after = s3Default();
        await after.makeup.uploadInitialImage(
          owner,
          session.id,
          await photo('png', 2),
        );
        await after.profile.updateAvatar(user, await photo('png', 3));

        expect(supabase.objects.has(oldPhoto.storageKey)).toBe(false);
        expect(supabase.objects.has(oldAvatar)).toBe(false);
        expect(s3.objects.size).toBe(2);
        const [newPhoto] = await client.imageAsset.findMany({
          where: { sessionId: session.id },
        });
        expect(newPhoto.storageProvider).toBe('fake-s3');

        // A session holding images from both providers is deleted from both.
        const { session: mixed, step } = await guideFixture(owner);
        await before.makeup.saveStepSnapshot(
          owner,
          step.id,
          await photo('jpeg', 4),
        );
        await after.makeup.saveStepSnapshot(
          owner,
          step.id,
          await photo('jpeg', 5),
        );
        await client.makeupSession.update({
          where: { id: mixed.id },
          data: { status: 'COMPLETED' },
        });
        const mixedKeys = (
          await client.imageAsset.findMany({ where: { sessionId: mixed.id } })
        ).map((i) => `${i.storageProvider}:${i.storageKey}`);
        expect(mixedKeys.filter((k) => k.startsWith('supabase:'))).toHaveLength(
          1,
        );
        expect(mixedKeys.filter((k) => k.startsWith('fake-s3:'))).toHaveLength(
          1,
        );

        await after.makeup.deleteSession(owner, mixed.id);
        for (const entry of mixedKeys) {
          const [provider, key] = entry.split(/:(.*)/s);
          expect(
            provider === 'supabase'
              ? supabase.objects.has(key)
              : s3.objects.has(key),
          ).toBe(false);
        }
        expect(await ledger()).toEqual([]);
      });

      it('keeps images from the newer provider working after switching back', async () => {
        const { image, file } = await sessionWithPhoto(s3Default());

        const back = supabaseDefault();
        await expect(
          back.makeup.getImageContent(owner, image.id),
        ).resolves.toMatchObject({
          bytes: file.buffer,
        });
        const signed = await back.makeup.getImageSignedUrl(owner, image.id);
        expect(s3.download(signed.url)).toEqual({
          status: 200,
          bytes: file.buffer,
        });
        expect(signed.expiresInSeconds).toBe(60);
      });

      describe('when a provider that still holds images is missing', () => {
        it('fails safely, never treats its deletions as done, and recovers once it is registered again', async () => {
          const { session, image } = await sessionWithPhoto(s3Default());
          const user = await createUser(client);
          await s3Default().profile.updateAvatar(user, await photo('png'));
          const missing = withoutS3();

          expect(await missing.lifecycle.auditReferencedProviders()).toEqual([
            'fake-s3',
          ]);
          expect(
            await rejection(missing.makeup.getImageContent(owner, image.id)),
          ).toMatchObject({
            status: 500,
            message: 'Image storage is unavailable',
          });
          expect(
            await rejection(missing.makeup.getImageSignedUrl(owner, image.id)),
          ).toMatchObject({
            status: 500,
          });
          expect(
            await rejection(missing.profile.getAvatarSignedUrl(user)),
          ).toMatchObject({
            status: 500,
          });

          // New uploads still work (they use the default), and replacing the
          // stranded image records its deletion instead of dropping it.
          await missing.makeup.uploadInitialImage(
            owner,
            session.id,
            await photo('png'),
          );
          expect(s3.objects.has(image.storageKey)).toBe(true);
          expect(await ledger()).toEqual([
            expect.objectContaining({
              provider: 'fake-s3',
              storageKey: image.storageKey,
              status: 'PENDING',
              lastErrorCode: 'UNKNOWN_STORAGE_PROVIDER',
            }),
          ]);

          const restored = s3Default();
          await makeDue();
          await expect(restored.lifecycle.processDue()).resolves.toEqual([
            'DELETED',
          ]);
          expect(s3.objects.has(image.storageKey)).toBe(false);
          expect(await restored.lifecycle.auditReferencedProviders()).toEqual(
            [],
          );
        });

        it('fails the AI run with a safe message instead of reading another provider', async () => {
          const app = s3Default();
          const { step } = await guideFixture(owner);
          await app.makeup.checkStep(
            owner,
            step.id,
            'missing-provider',
            await photo(),
          );
          const payload = queue.enqueue.mock.calls[0][1];
          const { job: vision, discard } = job('VISION_CHECK', payload);
          const downloadsBefore = supabase.count('download');

          expect(
            await rejection(withoutS3().processor.process(vision)),
          ).toMatchObject({
            code: 'IMAGE_STORAGE_FAILED',
          });
          expect(discard).toHaveBeenCalledTimes(1);
          expect(supabase.count('download')).toBe(downloadsBefore);
        });
      });

      describe('failures of the configured provider', () => {
        it('leaves no reference when an upload to it fails, and cleans up later', async () => {
          const app = s3Default();
          const session = await newSession(owner);
          s3.failNext('put', 'STORAGE_UNAVAILABLE');

          expect(
            await rejection(
              app.makeup.uploadInitialImage(owner, session.id, await photo()),
            ),
          ).toMatchObject({ status: 503 });

          expect(
            await client.imageAsset.count({ where: { sessionId: session.id } }),
          ).toBe(0);
          expect(await ledger()).toEqual([
            expect.objectContaining({
              provider: 'fake-s3',
              reason: 'UPLOAD_ABANDONED',
            }),
          ]);
          await makeDue();
          await expect(app.lifecycle.processDue()).resolves.toEqual([
            'DELETED',
          ]);
        });

        it('keeps a failed deletion in the ledger and retries it', async () => {
          const app = s3Default();
          const { session, image } = await sessionWithPhoto(app);
          s3.failNext('delete', 'STORAGE_TIMEOUT');

          await app.makeup.uploadInitialImage(
            owner,
            session.id,
            await photo('png'),
          );

          expect(s3.objects.has(image.storageKey)).toBe(true);
          expect(await ledger()).toEqual([
            expect.objectContaining({
              lastErrorCode: 'STORAGE_TIMEOUT',
              status: 'PENDING',
            }),
          ]);
          await makeDue();
          await expect(app.lifecycle.processDue()).resolves.toEqual([
            'DELETED',
          ]);
          expect(s3.objects.has(image.storageKey)).toBe(false);
        });

        it('maps signing and worker read failures like any other provider', async () => {
          const app = s3Default();
          const { step } = await guideFixture(owner);
          const run = await app.makeup.checkStep(
            owner,
            step.id,
            's3-failure',
            await photo(),
          );
          const payload = queue.enqueue.mock.calls[0][1];
          const imageId = payload.imageId as string;

          s3.failNext('sign', 'STORAGE_UNAVAILABLE');
          expect(
            await rejection(app.makeup.getImageSignedUrl(owner, imageId)),
          ).toMatchObject({
            status: 503,
          });

          s3.failNext('get', 'STORAGE_TIMEOUT');
          const { job: vision, discard } = job('VISION_CHECK', payload);
          expect(await rejection(app.processor.process(vision))).toMatchObject({
            code: 'IMAGE_STORAGE_UNAVAILABLE',
          });
          expect(discard).not.toHaveBeenCalled();
          expect(
            await client.aiRun.findUniqueOrThrow({ where: { id: run.id } }),
          ).toMatchObject({ status: 'QUEUED' });
        });
      });
    });

    describe('AI worker image pipeline (Supabase → preprocessing → OpenRouter)', () => {
      const EVALUATION = {
        result: 'PASS',
        feedback: 'Blended evenly.',
        spokenFeedback: 'That looks nicely blended.',
        confidence: 0.9,
      };
      const OPENROUTER_KEY = 'sk-or-v1-fake-openrouter-key';
      let openRouter: OpenRouterProvider;
      let liveProcessor: MakeupJobHandler;
      let spies: jest.SpyInstance[];
      let openRouterCalls: Array<{ url: string; init?: RequestInit }>;

      beforeEach(() => {
        openRouter = new OpenRouterProvider(
          new ConfigService({
            OPENROUTER_API_KEY: OPENROUTER_KEY,
            OPENROUTER_MODEL: 'vision/model',
          }),
        );
        liveProcessor = new MakeupJobHandler(
          prisma,
          new LiveAiGateway(openRouter),
          storage,
          mock<Logger>(),
          new ConfigService(),
          creditsNotUnderTest,
        );
        openRouterCalls = [];
        spies = [
          jest
            .spyOn(global, 'fetch')
            .mockImplementation(
              (input: RequestInfo | URL, init?: RequestInit) => {
                openRouterCalls.push({
                  url:
                    typeof input === 'string'
                      ? input
                      : input instanceof URL
                        ? input.href
                        : input.url,
                  init,
                });
                return Promise.resolve(
                  new Response(
                    JSON.stringify({
                      id: 'generation-id',
                      model: 'vision/model',
                      choices: [
                        { message: { content: JSON.stringify(EVALUATION) } },
                      ],
                    }),
                    {
                      status: 200,
                      headers: { 'Content-Type': 'application/json' },
                    },
                  ),
                );
              },
            ),
          jest.spyOn(openRouter, 'generateStructured'),
        ];
      });
      afterEach(() => spies.forEach((spy) => spy.mockRestore()));

      /** A large, EXIF-tagged phone photo submitted as a step check. */
      async function submittedCheck(idempotencyKey: string) {
        const { step } = await guideFixture(owner);
        const original = await sharp({
          create: {
            width: 2400,
            height: 1800,
            channels: 3,
            background: '#b08070',
          },
        })
          .withExif({
            IFD0: { Make: 'PhoneMaker', Model: 'Phone 15 Pro' },
            IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' },
          })
          .jpeg()
          .toBuffer();
        const run = await makeup.checkStep(owner, step.id, idempotencyKey, {
          buffer: original,
          size: original.length,
        } as Express.Multer.File);
        const payload = queue.enqueue.mock.calls[0][1];
        const image = await client.imageAsset.findUniqueOrThrow({
          where: { id: payload.imageId as string },
        });
        return { run, payload, image, original };
      }

      const storageDetails = (storageKey: string) => [
        FAKE_SUPABASE.url,
        new URL(FAKE_SUPABASE.url).host,
        FAKE_SUPABASE.serviceKey,
        FAKE_SUPABASE.bucket,
        storageKey,
        'supabase',
      ];

      it('processes the original photo from Supabase and sends OpenRouter only a normalized copy', async () => {
        const { run, payload, image, original } =
          await submittedCheck('pipeline-1');

        await liveProcessor.process(job('VISION_CHECK', payload).job);

        // The worker read the original bytes from the stored provider + key,
        // exactly what the content endpoint serves for the same image.
        expect(supabase.requests).toContainEqual({
          op: 'download',
          key: image.storageKey,
        });
        const received = (
          spies[1].mock.calls[0] as [StructuredGenerationRequest]
        )[0];
        expect(received.image?.bytes).toEqual(original);
        await expect(makeup.getImageContent(owner, image.id)).resolves.toEqual({
          bytes: original,
          mimeType: 'image/jpeg',
        });

        // OpenRouter received one request with a resized, metadata-free JPEG.
        expect(openRouterCalls).toHaveLength(1);
        expect(openRouterCalls[0].url).toBe(
          'https://openrouter.ai/api/v1/chat/completions',
        );
        const body = openRouterCalls[0].init?.body as string;
        const dataUrl = /data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/.exec(body);
        const sent = await sharp(
          Buffer.from(dataUrl?.[1] ?? '', 'base64'),
        ).metadata();
        expect(sent).toMatchObject({
          format: 'jpeg',
          width: 1600,
          height: 1200,
        });
        expect(sent.exif).toBeUndefined();

        // Nothing about private storage left the server.
        const outgoing = `${body} ${JSON.stringify(openRouterCalls[0].init?.headers)}`;
        for (const detail of storageDetails(image.storageKey)) {
          expect(outgoing).not.toContain(detail);
        }
        expect(outgoing).not.toContain('PhoneMaker');
        expect(
          new Headers(openRouterCalls[0].init?.headers).get('authorization'),
        ).toBe(`Bearer ${OPENROUTER_KEY}`);

        expect(
          await client.aiRun.findUniqueOrThrow({ where: { id: run.id } }),
        ).toMatchObject({ status: 'COMPLETED' });
        expect(
          await client.stepAttempt.count({ where: { imageId: image.id } }),
        ).toBe(1);
      });

      it.each([
        [
          'the stored object is missing',
          (key: string) => supabase.objects.delete(key),
          'FAILED',
          'The photo for this request is no longer available. Please upload it again.',
        ],
        [
          'the provider times out',
          () => supabase.failNext('download', { kind: 'hang' }),
          'QUEUED',
          null,
        ],
        [
          'the provider is unavailable',
          () => supabase.failNext('download', unavailable),
          'QUEUED',
          null,
        ],
        [
          'the provider rejects the server credentials',
          () => supabase.failNext('download', accessDenied),
          'FAILED',
          'Your photo could not be loaded right now. Please try again.',
        ],
        [
          'the object was replaced by something that is not the photo',
          (key: string) =>
            supabase.objects.set(key, {
              bytes: Buffer.from('<html>gateway error</html>'),
              contentType: 'text/html',
            }),
          'FAILED',
          'Your photo could not be loaded right now. Please try again.',
        ],
      ] as const)(
        'handles it gracefully when %s: no OpenRouter call, no provider details',
        async (_label, inject, status, message) => {
          const { run, payload, image } = await submittedCheck(
            `failure-${randomBytes(4).toString('hex')}`,
          );
          inject(image.storageKey);
          const { job: vision, discard } = job('VISION_CHECK', payload);

          await expect(liveProcessor.process(vision)).rejects.toBeDefined();

          expect(openRouterCalls).toHaveLength(0);
          const stored = await client.aiRun.findUniqueOrThrow({
            where: { id: run.id },
          });
          expect(stored.status).toBe(status);
          if (message) expect(stored.error).toBe(message);
          expect(discard).toHaveBeenCalledTimes(status === 'FAILED' ? 1 : 0);
          const visible = JSON.stringify(stored);
          for (const detail of storageDetails(image.storageKey)) {
            expect(visible).not.toContain(detail);
          }
        },
      );

      describe('complete image flow: retrieval, corrupt data and download failures', () => {
        /** A valid 800x600 image (noisy, so it compresses like a photo). */
        function fullImage(format: 'jpeg' | 'png') {
          return sharp({
            create: {
              width: 800,
              height: 600,
              channels: 3,
              background: '#000000',
              noise: { type: 'gaussian', mean: 128, sigma: 40 },
            },
          })
            .toFormat(format)
            .toBuffer();
        }

        /** The same image cut off mid-data: headers intact, pixels incomplete. */
        async function truncated(format: 'jpeg' | 'png', keep: number) {
          const full = await fullImage(format);
          return {
            full,
            cut: full.subarray(0, Math.floor(full.length * keep)),
          };
        }

        /** Replaces a stored object's bytes, as corruption in storage would. */
        function corruptStoredObject(key: string, bytes: Buffer) {
          const stored = supabase.objects.get(key);
          supabase.objects.set(key, {
            bytes,
            contentType: stored?.contentType ?? 'image/jpeg',
          });
        }

        it('upload validation rejects truncated images on every upload path: nothing stored or recorded', async () => {
          const { cut: jpeg } = await truncated('jpeg', 0.3);
          const { cut: png } = await truncated('png', 0.5);
          const session = await newSession(owner);
          const { step } = await guideFixture(owner);
          const user = await createUser(client);
          const asFile = (buffer: Buffer) =>
            ({ buffer, size: buffer.length }) as Express.Multer.File;
          const objectsBefore = bucketKeys();
          const rowsBefore = await client.imageAsset.count();

          for (const bytes of [jpeg, png]) {
            for (const upload of [
              () => makeup.uploadInitialImage(owner, session.id, asFile(bytes)),
              () => makeup.saveStepSnapshot(owner, step.id, asFile(bytes)),
              () =>
                makeup.checkStep(
                  owner,
                  step.id,
                  `truncated-${randomBytes(4).toString('hex')}`,
                  asFile(bytes),
                ),
              () => profile.updateAvatar(user, asFile(bytes)),
            ]) {
              expect(await rejection(upload())).toMatchObject({
                status: 400,
                message: 'The uploaded file is not a readable image',
              });
            }
          }

          expect(supabase.count('upload')).toBe(0);
          expect(bucketKeys()).toEqual(objectsBefore);
          expect(await client.imageAsset.count()).toBe(rowsBefore);
          expect(await ledger()).toEqual([]);
          expect(queue.enqueue.mock.calls).toHaveLength(0);
        });

        async function checkWith(bytes: Buffer) {
          const { step } = await guideFixture(owner);
          const run = await makeup.checkStep(
            owner,
            step.id,
            `flow-${randomBytes(4).toString('hex')}`,
            { buffer: bytes, size: bytes.length } as Express.Multer.File,
          );
          const payload = queue.enqueue.mock.calls.at(-1)?.[1] as MakeupAiJob;
          const image = await client.imageAsset.findUniqueOrThrow({
            where: { id: payload.imageId as string },
          });
          return { run, payload, image };
        }

        const received = () =>
          spies[1].mock.calls.map(
            (call) => (call as [StructuredGenerationRequest])[0].image?.bytes,
          );

        async function expectFailedSafely(
          runId: string,
          storageKey: string,
          message: string,
        ) {
          const stored = await client.aiRun.findUniqueOrThrow({
            where: { id: runId },
          });
          expect(stored).toMatchObject({ status: 'FAILED', error: message });
          for (const detail of storageDetails(storageKey)) {
            expect(JSON.stringify(stored)).not.toContain(detail);
          }
        }

        it.each(['png', 'webp'] as const)(
          'retrieves the exact stored %s bytes and sends OpenRouter a normalized JPEG',
          async (format) => {
            const original = await sharp({
              create: {
                width: 900,
                height: 700,
                channels: 4,
                background: { r: 90, g: 60, b: 50, alpha: 0.5 },
              },
            })
              .toFormat(format)
              .toBuffer();
            const { run, payload, image } = await checkWith(original);

            await liveProcessor.process(job('VISION_CHECK', payload).job);

            expect(supabase.objects.get(image.storageKey)?.bytes).toEqual(
              original,
            );
            expect(received()).toEqual([original]);
            expect(openRouterCalls).toHaveLength(1);
            const body = openRouterCalls[0].init?.body as string;
            const sent = /data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/.exec(body);
            expect(
              await sharp(Buffer.from(sent?.[1] ?? '', 'base64')).metadata(),
            ).toMatchObject({
              format: 'jpeg',
              width: 900,
              height: 700,
              hasAlpha: false,
            });
            expect(
              await client.aiRun.findUniqueOrThrow({ where: { id: run.id } }),
            ).toMatchObject({ status: 'COMPLETED' });
          },
        );

        it.each([
          ['a JPEG truncated at 30%', 'jpeg', 0.3],
          ['a JPEG truncated at 5%', 'jpeg', 0.05],
          ['a PNG truncated at 50%', 'png', 0.5],
        ] as const)(
          'rejects %s found in storage (corrupted after upload), before any OpenRouter call',
          async (_label, format, keep) => {
            const { full, cut: bytes } = await truncated(format, keep);
            // A valid upload, whose stored object is later cut off (storage
            // corruption, or an object stored before upload decoding existed)...
            const { run, payload, image } = await checkWith(full);
            expect(image).toMatchObject({
              mimeType: `image/${format}`,
              width: 800,
              height: 600,
            });
            corruptStoredObject(image.storageKey, bytes);
            const { job: vision, discard } = job('VISION_CHECK', payload);

            // ...is rejected by the worker once it tries to decode the pixels.
            await expect(liveProcessor.process(vision)).rejects.toMatchObject({
              code: 'AI_IMAGE_INVALID',
              retryable: false,
            });
            expect(received()).toEqual([bytes]); // the stored bytes were retrieved
            expect(openRouterCalls).toHaveLength(0);
            expect(discard).toHaveBeenCalledTimes(1);
            await expectFailedSafely(
              run.id,
              image.storageKey,
              'The photo could not be processed. Please upload it again.',
            );
          },
        );

        it('rejects a corrupted object that keeps a valid image signature', async () => {
          const { run, payload, image } = await checkWith(
            (await photo('jpeg', 44)).buffer,
          );
          const corrupted = Buffer.concat([
            Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
            randomBytes(4_096),
          ]);
          supabase.objects.set(image.storageKey, {
            bytes: corrupted,
            contentType: 'image/jpeg',
          });

          await expect(
            liveProcessor.process(job('VISION_CHECK', payload).job),
          ).rejects.toMatchObject({
            code: 'AI_IMAGE_INVALID',
            retryable: false,
          });
          expect(received()).toEqual([corrupted]);
          expect(openRouterCalls).toHaveLength(0);
          await expectFailedSafely(
            run.id,
            image.storageKey,
            'The photo could not be processed. Please upload it again.',
          );
        });

        it('fails face-photo analysis for a photo truncated in storage without calling OpenRouter', async () => {
          const session = await newSession(owner);
          const { full, cut } = await truncated('jpeg', 0.3);
          await makeup.uploadInitialImage(owner, session.id, {
            buffer: full,
            size: full.length,
          } as Express.Multer.File);
          corruptStoredObject(
            (
              await client.imageAsset.findFirstOrThrow({
                where: { sessionId: session.id },
              })
            ).storageKey,
            cut,
          );
          await makeup.savePreferences(owner, session.id, {
            vibe: 'natural',
            timeMinutes: 10,
          });
          const run = await makeup.startAnalysis(
            owner,
            session.id,
            `analysis-${randomBytes(4).toString('hex')}`,
          );
          const image = await client.imageAsset.findFirstOrThrow({
            where: { sessionId: session.id },
          });

          await expect(
            liveProcessor.process(
              job('PERSONALIZATION', {
                runId: run.id,
                authId: owner,
                sessionId: session.id,
              }).job,
            ),
          ).rejects.toMatchObject({ code: 'AI_IMAGE_INVALID' });

          expect(openRouterCalls).toHaveLength(0);
          await expectFailedSafely(
            run.id,
            image.storageKey,
            'The photo could not be processed. Please upload it again.',
          );
          expect(
            (
              await client.makeupSession.findUniqueOrThrow({
                where: { id: session.id },
              })
            ).status,
          ).toBe('ANALYSIS_FAILED');
        });

        it('never processes a download that breaks mid-transfer, and succeeds on retry', async () => {
          const original = (await photo('jpeg', 66)).buffer;
          const { run, payload } = await checkWith(original);
          supabase.failNext('download', { kind: 'broken-body' });
          const { job: first, discard } = job('VISION_CHECK', payload);

          await expect(liveProcessor.process(first)).rejects.toMatchObject({
            code: 'IMAGE_STORAGE_UNAVAILABLE',
            retryable: true,
          });
          // The partial bytes never reached preprocessing or OpenRouter.
          expect(received()).toEqual([]);
          expect(openRouterCalls).toHaveLength(0);
          expect(discard).not.toHaveBeenCalled();
          expect(
            await client.aiRun.findUniqueOrThrow({ where: { id: run.id } }),
          ).toMatchObject({ status: 'QUEUED', error: null });

          // BullMQ's retry: the next attempt downloads the full photo.
          await liveProcessor.process(job('VISION_CHECK', payload).job);
          expect(received()).toEqual([original]);
          expect(openRouterCalls).toHaveLength(1);
          expect(
            await client.aiRun.findUniqueOrThrow({ where: { id: run.id } }),
          ).toMatchObject({ status: 'COMPLETED' });
        });
      });

      it('fails the run immediately when the image record no longer exists', async () => {
        const { run, payload, image } = await submittedCheck('record-gone');
        await client.imageAsset.delete({ where: { id: image.id } });

        await expect(
          liveProcessor.process(job('VISION_CHECK', payload).job),
        ).rejects.toMatchObject({ code: 'IMAGE_NOT_FOUND', retryable: false });
        expect(openRouterCalls).toHaveLength(0);
        expect(
          await client.aiRun.findUniqueOrThrow({ where: { id: run.id } }),
        ).toMatchObject({ status: 'FAILED' });
      });
    });

    describe('session deletion', () => {
      it('removes every image of a deleted session, and only the owner can delete it', async () => {
        const { session, step } = await guideFixture(owner);
        await makeup.saveStepSnapshot(owner, step.id, await photo('jpeg', 1));
        await makeup.saveStepSnapshot(owner, step.id, await photo('jpeg', 2));
        await client.makeupSession.update({
          where: { id: session.id },
          data: { status: 'COMPLETED' },
        });
        expect(bucketKeys()).toHaveLength(2);

        expect(
          await rejection(makeup.deleteSession(intruder, session.id)),
        ).toMatchObject({
          status: 404,
        });
        expect(bucketKeys()).toHaveLength(2);

        await makeup.deleteSession(owner, session.id);
        expect(bucketKeys()).toEqual([]);
        expect(
          await client.imageAsset.count({ where: { sessionId: session.id } }),
        ).toBe(0);
        expect(await ledger()).toEqual([]);
      });
    });
  },
);
