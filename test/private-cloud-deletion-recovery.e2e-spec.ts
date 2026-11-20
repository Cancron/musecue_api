import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import type { Logger } from 'winston';
import type { PrismaService } from '../src/common/services/prisma.service';
import { MockAiGateway } from '../src/makeup/ai/mock-ai.gateway';
import { MakeupService } from '../src/makeup/makeup.service';
import { MakeupJobHandler } from '../src/makeup/queues/makeup-job.handler';
import { MakeupCreditService } from '../src/makeup/makeup-credit.service';
import type {
  MakeupAiJob,
  MakeupQueueService,
} from '../src/makeup/queues/makeup.queue';
import { ImageValidationService } from '../src/makeup/services/image-validation.service';
import { ProfileService } from '../src/profile/profile.service';
import {
  CLEANUP_POLICY,
  PrivateImageLifecycleService,
} from '../src/storage/private-image-lifecycle.service';
import { PrivateImageStorageService } from '../src/storage/private-image-storage.service';
import { SupabaseStorageProvider } from '../src/storage/providers/supabase-storage.provider';
import { FakeS3CompatibleStorage } from './support/fake-s3-compatible-storage';
import {
  FAKE_SUPABASE,
  FakeSupabaseStorage,
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

const STORAGE_TIMEOUT_MS = 300;

describeWithDatabase(
  'Private image deletion and recovery (PostgreSQL + mocked Supabase)',
  () => {
    let schema: string;
    let client: PrismaClient;
    let prisma: PrismaService;
    const supabase = new FakeSupabaseStorage();
    const s3 = new FakeS3CompatibleStorage();
    const queue = mock<MakeupQueueService>();
    const logger = mock<Logger>();
    let storage: PrivateImageStorageService;
    let lifecycle: PrivateImageLifecycleService;
    let makeup: MakeupService;
    let profile: ProfileService;
    let owner: string;
    let other: string;
    const injected: Array<{ name: string; table: string }> = [];

    /** A fresh service instance, as a restarted process would create. */
    const restartedLifecycle = () =>
      new PrivateImageLifecycleService(
        prisma,
        storage,
        new ConfigService({ NODE_ENV: 'test' }),
        mock<Logger>(),
      );
    const ledger = () =>
      client.privateStorageCleanup.findMany({ orderBy: { storageKey: 'asc' } });
    const makeDue = () =>
      client.privateStorageCleanup.updateMany({
        where: { status: 'PENDING' },
        data: { nextAttemptAt: new Date(Date.now() - 1_000) },
      });
    const bucketKeys = () => [...supabase.objects.keys()].sort();
    const keysOf = (user: string) =>
      bucketKeys().filter((key) => key.startsWith(`${user}/`));

    async function photo(shade = 100) {
      const buffer = await sharp({
        create: {
          width: 400,
          height: 400,
          channels: 3,
          background: { r: shade, g: 90, b: 140 },
        },
      })
        .jpeg()
        .toBuffer();
      return { buffer, size: buffer.length } as Express.Multer.File;
    }

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

    /** A COMPLETED session holding `count` private snapshots. */
    async function completedSession(authId: string, count: number) {
      const session = await client.makeupSession.create({
        data: { authId, status: 'IN_PROGRESS' },
      });
      const recommendation = await client.recommendation.create({
        data: {
          sessionId: session.id,
          rank: 1,
          name: 'Look',
          tagline: 'Soft',
          matchScore: 90,
          imageUrl: 'https://example.com/look.jpg',
          palette: [],
          rationale: 'Fits',
          selectedAt: new Date(),
        },
      });
      const guide = await client.guide.create({
        data: {
          sessionId: session.id,
          recommendationId: recommendation.id,
          status: 'IN_PROGRESS',
        },
      });
      const step = await client.guideStep.create({
        data: {
          guideId: guide.id,
          position: 0,
          status: 'CURRENT',
          title: 'Base',
          instruction: 'Apply',
          area: 'face',
          technique: 'blend',
          estimatedSeconds: 60,
          personalizedTip: 'Thin',
          commonMistake: 'Too much',
          successCriteria: 'Even',
        },
      });
      for (let i = 0; i < count; i += 1) {
        await makeup.saveStepSnapshot(authId, step.id, await photo(10 + i));
      }
      await client.makeupSession.update({
        where: { id: session.id },
        data: { status: 'COMPLETED' },
      });
      const images = await client.imageAsset.findMany({
        where: { sessionId: session.id },
        orderBy: { storageKey: 'asc' },
      });
      return { session, step, images, keys: images.map((i) => i.storageKey) };
    }

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
      storage = new PrivateImageStorageService(
        [
          new SupabaseStorageProvider(
            {
              storageUrl: FAKE_SUPABASE.url,
              serviceKey: FAKE_SUPABASE.serviceKey,
              bucket: FAKE_SUPABASE.bucket,
              timeoutMs: STORAGE_TIMEOUT_MS,
            },
            supabase.fetch,
          ),
          s3,
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
        new MockAiGateway(),
      );
      profile = new ProfileService(prisma, validation, storage, lifecycle);
    });

    afterAll(async () => {
      await client?.$disconnect();
      if (schema) await dropSchema(schema);
    });

    beforeEach(async () => {
      supabase.reset();
      s3.reset();
      jest.clearAllMocks();
      queue.enqueue.mockResolvedValue();
      await client.privateStorageCleanup.deleteMany();
      owner = await createUser(client);
      other = await createUser(client);
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      await removeInjectedFailures();
    });

    describe('storage provider crashes', () => {
      it('a provider outage during session deletion costs one timeout, and every object stays recoverable', async () => {
        const { session, keys } = await completedSession(owner, 4);
        supabase.failNext('remove', { kind: 'hang' }, 4);

        const started = Date.now();
        await expect(makeup.deleteSession(owner, session.id)).resolves.toEqual({
          id: session.id,
        });
        const elapsed = Date.now() - started;

        // One attempt hit the crashed provider; the rest were left queued.
        expect(supabase.count('remove')).toBe(1);
        expect(elapsed).toBeLessThan(STORAGE_TIMEOUT_MS * 3);
        expect(
          await client.makeupSession.findUnique({ where: { id: session.id } }),
        ).toBeNull();
        const rows = await ledger();
        expect(rows.map((row) => [row.provider, row.storageKey])).toEqual(
          keys.map((key) => ['supabase', key]),
        );
        expect(rows.every((row) => row.status === 'PENDING')).toBe(true);
        expect(
          rows.filter((row) => row.lastErrorCode === 'STORAGE_TIMEOUT'),
        ).toHaveLength(1);
        expect(keysOf(owner)).toEqual(keys);

        // The provider recovers; a later pass finishes the job.
        supabase.reset();
        for (const key of keys) {
          supabase.objects.set(key, {
            bytes: Buffer.from('x'),
            contentType: 'image/jpeg',
          });
        }
        await makeDue();
        await expect(lifecycle.processDue()).resolves.toEqual(
          keys.map(() => 'DELETED'),
        );
        expect(await ledger()).toEqual([]);
        expect(bucketKeys()).toEqual([]);
      });

      it('the cleaner skips a crashed provider for the rest of its pass but keeps serving another', async () => {
        const supabaseKeys = [1, 2, 3].map((i) => `${owner}/s/${i}.jpg`);
        const s3Keys = [1, 2].map((i) => `${owner}/s/s3-${i}.jpg`);
        for (const key of supabaseKeys) {
          supabase.objects.set(key, {
            bytes: Buffer.from('x'),
            contentType: 'image/jpeg',
          });
        }
        for (const key of s3Keys) {
          s3.objects.set(key, {
            bytes: Buffer.from('x'),
            contentType: 'image/jpeg',
          });
        }
        await client.privateStorageCleanup.createMany({
          data: [
            ...supabaseKeys.map((storageKey) => ({
              provider: 'supabase',
              storageKey,
              reason: 'SESSION_DELETED' as const,
            })),
            ...s3Keys.map((storageKey) => ({
              provider: 'fake-s3',
              storageKey,
              reason: 'SESSION_DELETED' as const,
            })),
          ],
        });
        await makeDue();
        supabase.failNext('remove', unavailable, 3);

        const outcomes = await lifecycle.processDue();

        expect(outcomes.filter((o) => o === 'DELETED')).toHaveLength(2);
        expect(outcomes.filter((o) => o === 'RETRY_SCHEDULED')).toHaveLength(1);
        expect(outcomes.filter((o) => o === 'NOT_ATTEMPTED')).toHaveLength(2);
        expect(supabase.count('remove')).toBe(1);
        expect(s3.objects.size).toBe(0);

        supabase.reset();
        for (const key of supabaseKeys) {
          supabase.objects.set(key, {
            bytes: Buffer.from('x'),
            contentType: 'image/jpeg',
          });
        }
        await makeDue();
        await lifecycle.processDue();
        expect(await ledger()).toEqual([]);
        expect(bucketKeys()).toEqual([]);
      });

      it('a provider that keeps failing ends as FAILED with everything needed to recover', async () => {
        const { session, keys } = await completedSession(owner, 1);
        supabase.failNext('remove', unavailable);
        await makeup.deleteSession(owner, session.id);
        await client.privateStorageCleanup.updateMany({
          data: { attempts: CLEANUP_POLICY.maxAttempts - 1 },
        });
        await makeDue();
        supabase.failNext('remove', unavailable);

        await expect(lifecycle.processDue()).resolves.toEqual(['FAILED']);

        expect(await ledger()).toEqual([
          expect.objectContaining({
            provider: 'supabase',
            storageKey: keys[0],
            reason: 'SESSION_DELETED',
            status: 'FAILED',
            attempts: CLEANUP_POLICY.maxAttempts,
            lastErrorCode: 'STORAGE_UNAVAILABLE',
          }),
        ]);
        expect(keysOf(owner)).toEqual(keys);
      });
    });

    describe('database failures', () => {
      it('object deleted but the ledger row could not be removed: retried idempotently later', async () => {
        const { session, keys } = await completedSession(owner, 1);
        await injectDbFailure('PrivateStorageCleanup', 'DELETE');

        await expect(
          makeup.deleteSession(owner, session.id),
        ).resolves.toBeDefined();

        expect(bucketKeys()).toEqual([]);
        const [leased] = await ledger();
        expect(leased).toMatchObject({
          storageKey: keys[0],
          status: 'PENDING',
        });
        expect(leased.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

        await removeInjectedFailures();
        await expect(lifecycle.processDue()).resolves.toEqual([]); // leased
        await makeDue();
        await expect(lifecycle.processDue()).resolves.toEqual(['DELETED']);
        expect(await ledger()).toEqual([]);
        expect(supabase.count('remove')).toBe(2);
      });

      it('a failed deletion whose failure cannot be recorded is retried after the lease, then recorded', async () => {
        const { session, keys } = await completedSession(owner, 1);
        supabase.failNext('remove', unavailable, 2);
        await injectDbFailure(
          'PrivateStorageCleanup',
          'UPDATE',
          `NEW."lastErrorCode" IS NOT NULL`,
        );

        await makeup.deleteSession(owner, session.id);

        let [row] = await ledger();
        expect(row).toMatchObject({
          storageKey: keys[0],
          status: 'PENDING',
          attempts: 0,
          lastErrorCode: null,
        });

        await removeInjectedFailures();
        await makeDue();
        await expect(lifecycle.processDue()).resolves.toEqual([
          'RETRY_SCHEDULED',
        ]);
        [row] = await ledger();
        expect(row).toMatchObject({
          provider: 'supabase',
          storageKey: keys[0],
          attempts: 1,
          lastErrorCode: 'STORAGE_UNAVAILABLE',
        });

        await makeDue();
        await expect(lifecycle.processDue()).resolves.toEqual(['DELETED']);
        expect(bucketKeys()).toEqual([]);
      });

      it('the ledger cannot be read right after the commit: the request succeeds and the cleaner finishes', async () => {
        const { session, keys } = await completedSession(owner, 2);
        jest
          .spyOn(client.privateStorageCleanup, 'findUnique')
          .mockRejectedValue(new Error('connection reset'));

        await expect(
          makeup.deleteSession(owner, session.id),
        ).resolves.toBeDefined();

        expect(keysOf(owner)).toEqual(keys);
        expect((await ledger()).map((row) => row.storageKey)).toEqual(keys);
        jest.restoreAllMocks();
        await expect(lifecycle.processDue()).resolves.toEqual([
          'DELETED',
          'DELETED',
        ]);
        expect(bucketKeys()).toEqual([]);
      });
    });

    describe('application crashes (recovery after restart)', () => {
      it('crash after the commit, before any deletion was attempted', async () => {
        const { session, keys } = await completedSession(owner, 3);
        jest.spyOn(lifecycle, 'processRefs').mockResolvedValueOnce([]);

        await makeup.deleteSession(owner, session.id);
        expect(keysOf(owner)).toEqual(keys);
        expect(await ledger()).toHaveLength(3);

        await expect(restartedLifecycle().processDue()).resolves.toEqual([
          'DELETED',
          'DELETED',
          'DELETED',
        ]);
        expect(bucketKeys()).toEqual([]);
        expect(await ledger()).toEqual([]);
      });

      it.each([
        ['after claiming a row, before calling the provider', false],
        [
          'after the provider deleted the object, before the ledger was updated',
          true,
        ],
      ])('crash %s', async (_label, objectAlreadyDeleted) => {
        const { session, keys } = await completedSession(owner, 1);
        jest.spyOn(lifecycle, 'processRefs').mockResolvedValueOnce([]);
        await makeup.deleteSession(owner, session.id);
        // What the crashed process left behind: a claimed (leased) row.
        const claimedAt = new Date();
        await client.privateStorageCleanup.updateMany({
          data: {
            lastAttemptAt: claimedAt,
            nextAttemptAt: new Date(
              claimedAt.getTime() + CLEANUP_POLICY.leaseMs,
            ),
          },
        });
        if (objectAlreadyDeleted) supabase.objects.delete(keys[0]);

        const restarted = restartedLifecycle();
        await expect(restarted.processDue()).resolves.toEqual([]); // still leased
        expect(supabase.count('remove')).toBe(0);

        await makeDue(); // the lease has expired
        await expect(restarted.processDue()).resolves.toEqual(['DELETED']);
        expect(bucketKeys()).toEqual([]);
        expect(await ledger()).toEqual([]);
      });
    });

    describe('repeated recovery processing', () => {
      async function failedDeletions(count: number) {
        const { session, keys } = await completedSession(owner, count);
        jest.spyOn(lifecycle, 'processRefs').mockResolvedValueOnce([]);
        await makeup.deleteSession(owner, session.id);
        await client.privateStorageCleanup.updateMany({
          data: {
            status: 'FAILED',
            attempts: CLEANUP_POLICY.maxAttempts,
            lastErrorCode: 'STORAGE_UNAVAILABLE',
          },
        });
        return keys;
      }

      it('requeueing and processing repeatedly and concurrently deletes each object exactly once', async () => {
        const keys = await failedDeletions(5);
        supabase.latencyMs = 10;

        const counts = await Promise.all([
          lifecycle.requeueFailedDeletions(),
          restartedLifecycle().requeueFailedDeletions(),
        ]);
        expect(counts[0] + counts[1]).toBe(5);

        const passes = await Promise.all([
          lifecycle.processDue(),
          restartedLifecycle().processDue(),
          restartedLifecycle().processDue(),
        ]);
        expect(passes.flat().filter((o) => o === 'DELETED')).toHaveLength(5);
        expect(supabase.count('remove')).toBe(5);
        expect(bucketKeys()).toEqual([]);

        // Running recovery again finds nothing and touches nothing.
        await expect(lifecycle.requeueFailedDeletions()).resolves.toBe(0);
        await expect(lifecycle.processDue()).resolves.toEqual([]);
        expect(supabase.count('remove')).toBe(5);
        expect(keys).toHaveLength(5);
      });

      it('recovery while the provider is still down keeps every record', async () => {
        const keys = await failedDeletions(2);
        await lifecycle.requeueFailedDeletions();
        supabase.failNext('remove', unavailable);

        await expect(lifecycle.processDue()).resolves.toEqual([
          'RETRY_SCHEDULED',
          'NOT_ATTEMPTED', // provider known down for the rest of this pass
        ]);
        expect(supabase.count('remove')).toBe(1);

        const rows = await ledger();
        expect(
          rows.map((row) => [row.provider, row.storageKey, row.status]),
        ).toEqual(keys.map((key) => ['supabase', key, 'PENDING']));
        expect(keysOf(owner)).toEqual(keys);
        await makeDue();
        await lifecycle.processDue();
        expect(bucketKeys()).toEqual([]);
      });

      it('requeueing one provider leaves other providers\u2019 FAILED rows alone', async () => {
        await failedDeletions(1);
        await client.privateStorageCleanup.create({
          data: {
            provider: 'fake-s3',
            storageKey: `${owner}/s/elsewhere.jpg`,
            reason: 'SESSION_DELETED',
            status: 'FAILED',
          },
        });

        await expect(
          lifecycle.requeueFailedDeletions({ provider: 'supabase' }),
        ).resolves.toBe(1);
        expect(
          (await ledger()).find((row) => row.provider === 'fake-s3')?.status,
        ).toBe('FAILED');
      });
    });

    describe('repeated and concurrent requests', () => {
      it('a retried session deletion changes nothing once the first succeeded', async () => {
        const { session } = await completedSession(owner, 2);
        const { keys: otherKeys } = await completedSession(other, 1);
        await makeup.deleteSession(owner, session.id);
        const removes = supabase.count('remove');

        await expect(
          makeup.deleteSession(owner, session.id),
        ).rejects.toMatchObject({
          status: 404,
        });
        expect(supabase.count('remove')).toBe(removes);
        expect(keysOf(other)).toEqual(otherKeys);
        expect(await ledger()).toEqual([]);
      });

      it("one user's deletions, retries and cleaner passes never touch another user's files", async () => {
        const { session, keys } = await completedSession(owner, 3);
        const { images: otherImages } = await completedSession(other, 2);
        await profile.updateAvatar(other, await photo(200));
        const otherAvatar = (
          await client.userProfile.findUniqueOrThrow({
            where: { authId: other },
          })
        ).avatarUrl as string;
        supabase.latencyMs = 5;

        const [deletions] = await Promise.all([
          Promise.allSettled([
            makeup.deleteSession(owner, session.id),
            makeup.deleteSession(owner, session.id),
          ]),
          lifecycle.processDue(),
          restartedLifecycle().processDue(),
          profile.getAvatarContent(other),
        ]);
        // Either concurrent deletion may win the session lock; the other
        // finds nothing left to delete.
        expect(
          deletions.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        expect(
          deletions.find((result) => result.status === 'rejected'),
        ).toMatchObject({ reason: { status: 404 } });
        await makeDue();
        await lifecycle.processDue();

        for (const key of keys) expect(supabase.objects.has(key)).toBe(false);
        for (const image of otherImages) {
          expect(supabase.objects.has(image.storageKey)).toBe(true);
          await expect(
            makeup.getImageContent(other, image.id),
          ).resolves.toBeDefined();
        }
        expect(supabase.objects.has(otherAvatar)).toBe(true);
      });

      it('a stale cleanup row never deletes an active image, however often it is processed', async () => {
        const { images } = await completedSession(owner, 1);
        await client.privateStorageCleanup.create({
          data: {
            provider: 'supabase',
            storageKey: images[0].storageKey,
            reason: 'IMAGE_REPLACED',
          },
        });

        await Promise.all([
          lifecycle.processDue(),
          restartedLifecycle().processDue(),
        ]);
        await lifecycle.requeueFailedDeletions();
        await makeDue();
        await lifecycle.processDue();

        expect(supabase.objects.has(images[0].storageKey)).toBe(true);
        expect(supabase.count('remove')).toBe(0);
        await expect(
          makeup.getImageContent(owner, images[0].id),
        ).resolves.toBeDefined();
      });

      it('a deletion recorded while the cleaner is skipping the same image is not lost', async () => {
        // A stale row exists for an image that is still referenced...
        const { images } = await completedSession(owner, 1);
        const image = images[0];
        await client.privateStorageCleanup.create({
          data: {
            provider: 'supabase',
            storageKey: image.storageKey,
            reason: 'IMAGE_REPLACED',
          },
        });
        // ...and exactly while the cleaner checks references, a request
        // removes that reference and records its deletion.
        const count = client.userProfile.count.bind(client.userProfile) as (
          args: object,
        ) => Promise<number>;
        jest.spyOn(client.userProfile, 'count').mockImplementationOnce((async (
          args: object,
        ): Promise<number> => {
          const result = await count(args);
          await client.$transaction(async (tx) => {
            await tx.imageAsset.delete({ where: { id: image.id } });
            await lifecycle.scheduleDeletion(
              tx,
              [{ provider: 'supabase', key: image.storageKey }],
              'IMAGE_DISCARDED',
              owner,
            );
          });
          return result;
        }) as never);

        await expect(lifecycle.processDue()).resolves.toEqual([
          'SKIPPED_REFERENCED',
        ]);

        // The request's deletion record survived the cleaner's stale skip...
        expect(await ledger()).toEqual([
          expect.objectContaining({
            storageKey: image.storageKey,
            reason: 'IMAGE_DISCARDED',
            status: 'PENDING',
          }),
        ]);
        // ...so the now-unreferenced object is deleted, not orphaned.
        await makeDue();
        await expect(lifecycle.processDue()).resolves.toEqual(['DELETED']);
        expect(supabase.objects.has(image.storageKey)).toBe(false);
      });

      it("a corrupted reference into another user's folder never queues that file for deletion", async () => {
        const { images: victimImages } = await completedSession(other, 1);
        const victimKey = victimImages[0].storageKey;
        const { session, images } = await completedSession(owner, 1);
        await client.imageAsset.update({
          where: { id: images[0].id },
          data: { storageKey: victimKey },
        });
        await client.imageAsset.delete({ where: { id: victimImages[0].id } });

        await makeup.deleteSession(owner, session.id);
        await makeDue();
        await lifecycle.processDue();

        expect(supabase.objects.has(victimKey)).toBe(true);
        expect(
          (await ledger()).filter((row) => row.storageKey === victimKey),
        ).toEqual([]);
        expect(
          logger.error.mock.calls.some((call) => {
            const message = (call as unknown[])[0];
            return (
              typeof message === 'string' &&
              message.includes("outside the owner's storage folder")
            );
          }),
        ).toBe(true);
      });

      it('repeated avatar removals and replacements leave exactly the latest avatar', async () => {
        await profile.updateAvatar(owner, await photo(1));
        await profile.updateAvatar(owner, await photo(2));
        await profile.updateAvatar(owner, await photo(3)); // a retried request

        await Promise.all([
          profile.deleteAvatar(owner),
          profile.deleteAvatar(owner),
          profile.deleteAvatar(owner),
        ]);
        await profile.updateAvatar(owner, await photo(4));

        const row = await client.userProfile.findUniqueOrThrow({
          where: { authId: owner },
        });
        expect(keysOf(owner)).toEqual([row.avatarUrl]);
        expect(await ledger()).toEqual([]);
      });
    });

    describe('image processing while storage or the database fails', () => {
      it('uploads keep working while deletions for a crashed provider are pending', async () => {
        const { session } = await completedSession(owner, 2);
        supabase.failNext('remove', { kind: 'hang' });
        await makeup.deleteSession(owner, session.id);
        const pending = await ledger();
        expect(pending).toHaveLength(2);
        expect(supabase.count('remove')).toBe(1);

        const fresh = await client.makeupSession.create({
          data: { authId: owner },
        });
        await makeup.uploadInitialImage(owner, fresh.id, await photo(77));
        const [uploaded] = await client.imageAsset.findMany({
          where: { sessionId: fresh.id },
        });

        expect(supabase.objects.has(uploaded.storageKey)).toBe(true);
        expect((await ledger()).map((row) => row.storageKey)).toEqual(
          pending.map((row) => row.storageKey),
        );
        await makeDue();
        await lifecycle.processDue();
        expect(keysOf(owner)).toEqual([uploaded.storageKey]);
      });

      it('the AI worker keeps a run retryable and its error generic when the database fails while loading the image', async () => {
        const { step } = await completedSession(owner, 0);
        await client.makeupSession.updateMany({
          where: { authId: owner },
          data: { status: 'IN_PROGRESS' },
        });
        const run = await makeup.checkStep(
          owner,
          step.id,
          'db-down',
          await photo(5),
        );
        const payload = queue.enqueue.mock.calls.at(-1)?.[1] as MakeupAiJob;
        jest
          .spyOn(client.imageAsset, 'findFirst')
          .mockRejectedValue(
            new Error("Can't reach database server at `db.internal:5432`"),
          );
        const processor = new MakeupJobHandler(
          prisma,
          new MockAiGateway(),
          storage,
          mock<Logger>(),
          new ConfigService(),
          mock<MakeupCreditService>(),
        );

        await expect(
          processor.process({
            name: 'VISION_CHECK',
            data: payload,
            maxAttempts: 3,
            attemptsMade: 2,
            discard: jest.fn(),
            updateData: jest.fn(),
          } as never),
        ).rejects.toMatchObject({ code: 'IMAGE_LOAD_FAILED', retryable: true });

        const stored = await client.aiRun.findUniqueOrThrow({
          where: { id: run.id },
        });
        expect(stored.status).toBe('FAILED');
        expect(stored.error).toBe(
          'Your photo could not be loaded right now. Please try again.',
        );
        expect(JSON.stringify(stored)).not.toContain('db.internal');
      });
    });
  },
);
