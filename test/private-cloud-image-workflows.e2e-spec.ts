import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import type { Job } from 'bullmq';
import { mock } from 'jest-mock-extended';
import sharp from 'sharp';
import type { Logger } from 'winston';
import type { PrismaService } from '../src/common/services/prisma.service';
import { MockAiGateway } from '../src/makeup/ai/mock-ai.gateway';
import { MakeupService } from '../src/makeup/makeup.service';
import { MakeupProcessor } from '../src/makeup/queues/makeup.processor';
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
    let processor: MakeupProcessor;
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
          opts: { attempts: 3 },
          attemptsMade: 0,
          discard,
          updateData: jest.fn(),
        } as unknown as Job<MakeupAiJob>,
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
      processor = new MakeupProcessor(
        prisma,
        ai,
        storage,
        logger,
        new ConfigService(),
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

      it.each([
        ['a provider outage', unavailable, 503],
        ['rejected credentials', accessDenied, 500],
        ['a network failure', { kind: 'network' } as const, 503],
      ])(
        'fails cleanly on %s: nothing stored, nothing recorded',
        async (_label, failure, status) => {
          const session = await newSession(owner);
          supabase.failNext('upload', failure);

          expect(
            await rejection(
              makeup.uploadInitialImage(owner, session.id, await photo()),
            ),
          ).toMatchObject({ status });

          expect(
            await client.imageAsset.count({ where: { sessionId: session.id } }),
          ).toBe(0);
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

        expect(supabase.count('remove')).toBe(1);
        expect(bucketKeys()).toEqual([]);
        expect(await ledger()).toEqual([]);
        expect(
          await client.imageAsset.count({ where: { sessionId: session.id } }),
        ).toBe(0);
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
