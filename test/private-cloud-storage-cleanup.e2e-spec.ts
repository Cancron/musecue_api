import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import type { Logger } from 'winston';
import type { PrismaService } from '../src/common/services/prisma.service';
import {
  CLEANUP_POLICY,
  PrivateImageLifecycleService,
} from '../src/storage/private-image-lifecycle.service';
import { PrivateImageStorageService } from '../src/storage/private-image-storage.service';
import type {
  PrivateObjectRef,
  PrivateObjectStorageProvider,
  SignedObjectUrl,
} from '../src/storage/private-object-storage.provider';
import { PrivateStorageError } from '../src/storage/private-storage.error';
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

/** In-memory private storage whose deletions can be made to fail. */
class MemoryProvider implements PrivateObjectStorageProvider {
  readonly id = 'memory';
  readonly objects = new Map<string, Buffer>();
  readonly deleteCalls: string[] = [];
  failDeletes = false;
  deleteDelayMs = 0;

  isConfigured(): boolean {
    return true;
  }

  put(key: string, bytes: Buffer): Promise<void> {
    if (this.objects.has(key)) {
      return Promise.reject(new PrivateStorageError('OBJECT_ALREADY_EXISTS'));
    }
    this.objects.set(key, bytes);
    return Promise.resolve();
  }

  get(key: string): Promise<Buffer> {
    const bytes = this.objects.get(key);
    return bytes
      ? Promise.resolve(bytes)
      : Promise.reject(new PrivateStorageError('OBJECT_NOT_FOUND'));
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    if (this.deleteDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.deleteDelayMs));
    }
    if (this.failDeletes) throw new PrivateStorageError('STORAGE_UNAVAILABLE');
    this.objects.delete(key);
  }

  createSignedUrl(): Promise<SignedObjectUrl> {
    return Promise.reject(new PrivateStorageError('SIGNED_URL_UNSUPPORTED'));
  }
}

describeWithDatabase('Private storage cleanup ledger (PostgreSQL)', () => {
  let schema: string;
  let client: PrismaClient;
  let prisma: PrismaService;
  let provider: MemoryProvider;
  let storage: PrivateImageStorageService;
  let lifecycle: PrivateImageLifecycleService;
  let authId: string;
  let sessionId: string;

  const newLifecycle = () =>
    new PrivateImageLifecycleService(
      prisma,
      storage,
      new ConfigService({ NODE_ENV: 'test' }),
      mock<Logger>(),
    );
  const ledger = () =>
    client.privateStorageCleanup.findMany({ orderBy: { createdAt: 'asc' } });
  const upload = () =>
    lifecycle.upload(authId, sessionId, 'image/jpeg', Buffer.from('jpeg'));
  const imageData = (ref: PrivateObjectRef) => ({
    sessionId,
    purpose: 'STEP_CHECK' as const,
    source: 'PRIVATE_UPLOAD' as const,
    storageKey: ref.key,
    storageProvider: ref.provider,
    mimeType: 'image/jpeg',
    width: 640,
    height: 640,
    sizeBytes: 4,
  });
  /** Makes rows due now, as if their scheduled time had passed. */
  const makeDue = () =>
    client.privateStorageCleanup.updateMany({
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });

  beforeAll(async () => {
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    client = new PrismaClient({
      adapter: new PrismaPg(
        {
          connectionString: TEST_DATABASE_URL as string,
          // Raw SQL (deletion scheduling) resolves through search_path.
          options: `-c search_path=${schema}`,
        },
        { schema },
      ),
    });
    prisma = client as unknown as PrismaService;
    authId = await createUser(client);
    sessionId = (await client.makeupSession.create({ data: { authId } })).id;
  });

  afterAll(async () => {
    await client?.$disconnect();
    if (schema) await dropSchema(schema);
  });

  beforeEach(async () => {
    await client.privateStorageCleanup.deleteMany();
    await client.imageAsset.deleteMany();
    provider = new MemoryProvider();
    storage = new PrivateImageStorageService(
      [provider],
      { activeProvider: 'memory', localRoot: '/unused' },
      mock<Logger>(),
    );
    lifecycle = newLifecycle();
  });

  it('leaves no ledger row once an upload is committed', async () => {
    const ref = await upload();
    const [reservation] = await ledger();
    expect(reservation).toMatchObject({
      reason: 'UPLOAD_PENDING',
      status: 'PENDING',
    });
    expect(reservation.nextAttemptAt.getTime()).toBeGreaterThan(
      Date.now() + CLEANUP_POLICY.uploadGraceMs - 60_000,
    );

    await client.$transaction(async (tx) => {
      await tx.imageAsset.create({ data: imageData(ref) });
      await lifecycle.confirmUpload(tx, ref);
    });

    expect(await ledger()).toEqual([]);
    expect(provider.objects.has(ref.key)).toBe(true);
  });

  it('deletes an upload whose database write failed, keeping the reservation through the rollback', async () => {
    const ref = await upload();

    await expect(
      client.$transaction(async (tx) => {
        await tx.imageAsset.create({ data: imageData(ref) });
        await lifecycle.confirmUpload(tx, ref);
        throw new Error('later write failed');
      }),
    ).rejects.toThrow('later write failed');
    // The rollback restored the reservation removed by confirmUpload.
    expect(await ledger()).toHaveLength(1);

    await expect(lifecycle.abandonUpload(ref)).resolves.toBe('DELETED');
    expect(provider.objects.has(ref.key)).toBe(false);
    expect(await ledger()).toEqual([]);
    expect(await client.imageAsset.count()).toBe(0);
  });

  it('keeps a failed deletion recorded with its error, then completes it on a later pass', async () => {
    const ref = await upload();
    provider.failDeletes = true;

    await expect(lifecycle.abandonUpload(ref)).resolves.toBe('RETRY_SCHEDULED');

    const [pending] = await ledger();
    expect(pending).toMatchObject({
      provider: 'memory',
      storageKey: ref.key,
      reason: 'UPLOAD_ABANDONED',
      status: 'PENDING',
      attempts: 1,
      lastErrorCode: 'STORAGE_UNAVAILABLE',
    });
    expect(pending.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(provider.objects.has(ref.key)).toBe(true);
    // Not due yet: the cleaner leaves it alone.
    await expect(lifecycle.processDue()).resolves.toEqual([]);

    provider.failDeletes = false;
    await makeDue();
    await expect(lifecycle.processDue()).resolves.toEqual(['DELETED']);
    expect(provider.objects.has(ref.key)).toBe(false);
    expect(await ledger()).toEqual([]);
  });

  it('cleans up after a crash between upload and commit, and rejects the late commit', async () => {
    const ref = await upload();
    // Reservations are not touched while the upload may still commit.
    await expect(lifecycle.processDue()).resolves.toEqual([]);

    await makeDue(); // the grace period has passed
    provider.failDeletes = true; // keep the row around to race the commit
    await expect(lifecycle.processDue()).resolves.toEqual(['RETRY_SCHEDULED']);
    expect((await ledger())[0]?.reason).toBe('UPLOAD_ABANDONED');

    await expect(
      client.$transaction(async (tx) => {
        await tx.imageAsset.create({ data: imageData(ref) });
        await lifecycle.confirmUpload(tx, ref);
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await client.imageAsset.count()).toBe(0);

    provider.failDeletes = false;
    await makeDue();
    await expect(lifecycle.processDue()).resolves.toEqual(['DELETED']);
    expect(provider.objects.size).toBe(0);
  });

  it('records a replaced image atomically with the new reference and deletes it after commit', async () => {
    const oldRef = await upload();
    const oldImage = await client.$transaction(async (tx) => {
      const image = await tx.imageAsset.create({ data: imageData(oldRef) });
      await lifecycle.confirmUpload(tx, oldRef);
      return image;
    });
    const newRef = await upload();

    await client.$transaction(async (tx) => {
      await tx.imageAsset.delete({ where: { id: oldImage.id } });
      await tx.imageAsset.create({ data: imageData(newRef) });
      await lifecycle.confirmUpload(tx, newRef);
      await lifecycle.scheduleDeletion(tx, [oldRef], 'IMAGE_REPLACED', authId);
    });
    await expect(lifecycle.processRefs([oldRef])).resolves.toEqual(['DELETED']);

    expect(provider.objects.has(oldRef.key)).toBe(false);
    expect(provider.objects.has(newRef.key)).toBe(true);
    expect(await ledger()).toEqual([]);
  });

  it('records nothing when the transaction removing a reference rolls back', async () => {
    const ref = await upload();
    const image = await client.$transaction(async (tx) => {
      const created = await tx.imageAsset.create({ data: imageData(ref) });
      await lifecycle.confirmUpload(tx, ref);
      return created;
    });

    await expect(
      client.$transaction(async (tx) => {
        await tx.imageAsset.delete({ where: { id: image.id } });
        await lifecycle.scheduleDeletion(tx, [ref], 'SESSION_DELETED', authId);
        throw new Error('session delete failed');
      }),
    ).rejects.toThrow('session delete failed');

    expect(await ledger()).toEqual([]);
    expect(await client.imageAsset.count()).toBe(1);
    expect(provider.objects.has(ref.key)).toBe(true);
  });

  it('keeps exhausted deletions as FAILED for manual recovery and never drops them', async () => {
    const ref = await upload();
    provider.failDeletes = true;
    await lifecycle.abandonUpload(ref);
    await client.privateStorageCleanup.updateMany({
      data: { attempts: CLEANUP_POLICY.maxAttempts - 1 },
    });
    await makeDue();

    await expect(lifecycle.processDue()).resolves.toEqual(['FAILED']);
    const [failed] = await ledger();
    expect(failed).toMatchObject({
      provider: 'memory',
      storageKey: ref.key,
      reason: 'UPLOAD_ABANDONED',
      status: 'FAILED',
      attempts: CLEANUP_POLICY.maxAttempts,
      lastErrorCode: 'STORAGE_UNAVAILABLE',
    });

    const callsBefore = provider.deleteCalls.length;
    await makeDue();
    await expect(lifecycle.processDue()).resolves.toEqual([]);
    expect(provider.deleteCalls).toHaveLength(callsBefore);

    // Documented recovery: requeue the row once the cause is fixed.
    provider.failDeletes = false;
    await client.privateStorageCleanup.updateMany({
      where: { status: 'FAILED' },
      data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(0) },
    });
    await expect(lifecycle.processDue()).resolves.toEqual(['DELETED']);
    expect(await ledger()).toEqual([]);
  });

  it('never deletes an object that a record still references', async () => {
    const ref = await upload();
    await client.$transaction(async (tx) => {
      await tx.imageAsset.create({ data: imageData(ref) });
      await lifecycle.confirmUpload(tx, ref);
    });
    await client.$transaction((tx) =>
      lifecycle.scheduleDeletion(tx, [ref, ref], 'IMAGE_DISCARDED', authId),
    );
    expect(await ledger()).toHaveLength(1);

    await expect(lifecycle.processRefs([ref])).resolves.toEqual([
      'SKIPPED_REFERENCED',
    ]);
    expect(provider.objects.has(ref.key)).toBe(true);
    expect(provider.deleteCalls).toEqual([]);
    expect(await ledger()).toEqual([]);
  });

  it('lets concurrent cleaners delete each object exactly once', async () => {
    const refs: PrivateObjectRef[] = [];
    for (let i = 0; i < 5; i += 1) refs.push(await upload());
    await client.privateStorageCleanup.updateMany({
      data: { reason: 'UPLOAD_ABANDONED' },
    });
    await makeDue();
    provider.deleteDelayMs = 20;

    const [first, second] = await Promise.all([
      lifecycle.processDue(),
      newLifecycle().processDue(),
    ]);

    expect([...first, ...second].filter((o) => o === 'DELETED')).toHaveLength(
      5,
    );
    expect([...provider.deleteCalls].sort()).toEqual(
      refs.map((ref) => ref.key).sort(),
    );
    expect(provider.objects.size).toBe(0);
    expect(await ledger()).toEqual([]);
  });
});
