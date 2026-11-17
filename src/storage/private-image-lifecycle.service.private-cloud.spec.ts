import { ConfigService } from '@nestjs/config';
import type { PrivateStorageCleanup } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import type { Logger } from 'winston';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import {
  CLEANUP_POLICY,
  PrivateImageLifecycleService,
} from './private-image-lifecycle.service';
import { PrivateImageStorageService } from './private-image-storage.service';
import { PrivateStorageError } from './private-storage.error';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const REF = {
  provider: 'supabase',
  key: 'owner-id/session-id/0b7c9a52-8d2f-4d57-9a8c-0d8c1f0a1b2c.jpg',
};
const BYTES = Buffer.from('jpeg');

function task(overrides: Partial<PrivateStorageCleanup> = {}) {
  return {
    id: 'task-1',
    provider: REF.provider,
    storageKey: REF.key,
    reason: 'IMAGE_REPLACED',
    status: 'PENDING',
    attempts: 0,
    lastErrorCode: null,
    nextAttemptAt: new Date(NOW.getTime() - 1_000),
    lastAttemptAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as PrivateStorageCleanup;
}

describe('PrivateImageLifecycleService (private cloud cleanup ledger)', () => {
  const prisma = mockDeep<PrismaService>();
  const storage = mock<PrivateImageStorageService>();
  const logger = mock<Logger>();
  const lifecycle = new PrivateImageLifecycleService(
    prisma,
    storage,
    new ConfigService({ NODE_ENV: 'test' }),
    logger,
  );
  const ledger = prisma.privateStorageCleanup;
  /** Distinct transaction client: ledger writes must go through it. */
  const tx = mockDeep<PrismaService>();

  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
    storage.createRef.mockReturnValue(REF);
    ledger.create.mockResolvedValue(task({ reason: 'UPLOAD_PENDING' }));
    ledger.updateMany.mockResolvedValue({ count: 1 });
    ledger.deleteMany.mockResolvedValue({ count: 1 });
    ledger.findUnique.mockResolvedValue(task());
    prisma.imageAsset.count.mockResolvedValue(0);
    prisma.userProfile.count.mockResolvedValue(0);
  });
  afterEach(() => jest.useRealTimers());

  it('does not retain an object because an avatar has the same key in another provider', async () => {
    prisma.userProfile.count.mockImplementation(((args?: {
      where?: { avatarStorageProvider?: string };
    }) =>
      Promise.resolve(
        !args?.where?.avatarStorageProvider ||
          args.where.avatarStorageProvider === 'fake-s3'
          ? 1
          : 0,
      )) as never);
    await expect(lifecycle.processRefs([REF])).resolves.toEqual(['DELETED']);
    expect(storage.delete.mock.calls).toEqual([[REF]]);
    expect(prisma.userProfile.count.mock.calls[0]?.[0]).toEqual({
      where: { avatarUrl: REF.key, avatarStorageProvider: REF.provider },
    });
  });

  describe('upload', () => {
    it('records a reservation before any bytes are written', async () => {
      await expect(
        lifecycle.upload('owner-id', 'session-id', 'image/jpeg', BYTES),
      ).resolves.toEqual(REF);

      expect(ledger.create.mock.calls[0]?.[0]).toEqual({
        data: {
          provider: REF.provider,
          storageKey: REF.key,
          reason: 'UPLOAD_PENDING',
          nextAttemptAt: new Date(NOW.getTime() + CLEANUP_POLICY.uploadGraceMs),
        },
      });
      expect(storage.put.mock.calls).toEqual([[REF, BYTES, 'image/jpeg']]);
      expect(ledger.create.mock.invocationCallOrder[0]).toBeLessThan(
        storage.put.mock.invocationCallOrder[0],
      );
    });

    it('does not upload when the reservation cannot be recorded', async () => {
      ledger.create.mockRejectedValue(new Error('database down'));

      await expect(
        lifecycle.upload('owner-id', 'session-id', 'image/jpeg', BYTES),
      ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', retryable: true });
      expect(storage.put.mock.calls).toHaveLength(0);
    });

    it.each(['STORAGE_TIMEOUT', 'STORAGE_UNAVAILABLE'] as const)(
      'treats %s as possibly written: records the deletion for after the settle period, not now',
      async (code) => {
        const failure = new PrivateStorageError(code);
        storage.put.mockRejectedValue(failure);

        await expect(
          lifecycle.upload('owner-id', 'session-id', 'image/jpeg', BYTES),
        ).rejects.toBe(failure);
        expect(ledger.updateMany.mock.calls[0]?.[0]).toEqual({
          where: {
            provider: REF.provider,
            storageKey: REF.key,
            reason: 'UPLOAD_PENDING',
            status: 'PENDING',
          },
          data: {
            reason: 'UPLOAD_ABANDONED',
            nextAttemptAt: new Date(
              NOW.getTime() + CLEANUP_POLICY.ambiguousUploadSettleMs,
            ),
          },
        });
        // A late write could land after an immediate delete: wait instead.
        expect(storage.delete.mock.calls).toHaveLength(0);
        expect(ledger.findUnique.mock.calls).toHaveLength(0);
      },
    );

    it('deletes right away when the upload succeeded but the database write failed', async () => {
      ledger.findUnique.mockResolvedValue(
        task({ reason: 'UPLOAD_ABANDONED', nextAttemptAt: NOW }),
      );

      await expect(lifecycle.abandonUpload(REF)).resolves.toBe('DELETED');
      expect(ledger.updateMany.mock.calls[0]?.[0].data).toEqual({
        reason: 'UPLOAD_ABANDONED',
        nextAttemptAt: NOW,
      });
      expect(storage.delete.mock.calls).toEqual([[REF]]);
    });

    it.each([
      'STORAGE_REJECTED',
      'STORAGE_ACCESS_DENIED',
      'OBJECT_ALREADY_EXISTS',
    ] as const)(
      'forgets the reservation without deleting anything after %s',
      async (code) => {
        storage.put.mockRejectedValue(new PrivateStorageError(code));

        await expect(
          lifecycle.upload('owner-id', 'session-id', 'image/jpeg', BYTES),
        ).rejects.toMatchObject({ code });
        expect(ledger.deleteMany.mock.calls[0]?.[0]).toEqual({
          where: {
            provider: REF.provider,
            storageKey: REF.key,
            reason: 'UPLOAD_PENDING',
          },
        });
        expect(storage.delete.mock.calls).toHaveLength(0);
      },
    );
  });

  describe('confirmUpload', () => {
    it('claims the reservation inside the caller transaction', async () => {
      tx.privateStorageCleanup.deleteMany.mockResolvedValue({ count: 1 });

      await lifecycle.confirmUpload(tx, REF);

      expect(ledger.deleteMany.mock.calls).toHaveLength(0);
      expect(tx.privateStorageCleanup.deleteMany.mock.calls[0]?.[0]).toEqual({
        where: {
          provider: REF.provider,
          storageKey: REF.key,
          reason: 'UPLOAD_PENDING',
          status: 'PENDING',
        },
      });
    });

    it('fails (rolling the transaction back) when the cleaner took over the reservation', async () => {
      tx.privateStorageCleanup.deleteMany.mockResolvedValue({ count: 0 });

      const error = await lifecycle
        .confirmUpload(tx, REF)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).getStatus()).toBe(409);
    });
  });

  describe('abandonUpload', () => {
    it('keeps the reservation for the cleaner when the database is unavailable', async () => {
      ledger.updateMany.mockRejectedValue(new Error('database down'));

      await expect(lifecycle.abandonUpload(REF)).resolves.toBe('NOT_ATTEMPTED');
      expect(storage.delete.mock.calls).toHaveLength(0);
    });
  });

  describe('scheduleDeletion', () => {
    const sqlOf = (call: unknown[]) => (call[0] as string[]).join('?');

    it('records each owned deletion in the given transaction, re-arming existing rows', async () => {
      const other = { provider: 'local', key: 'owner-id/profile/old.png' };

      await expect(
        lifecycle.scheduleDeletion(
          tx,
          [REF, other],
          'SESSION_DELETED',
          'owner-id',
        ),
      ).resolves.toEqual([REF, other]);

      expect(prisma.$executeRaw.mock.calls).toHaveLength(0);
      const calls = tx.$executeRaw.mock.calls;
      expect(calls).toHaveLength(2);
      const sql = sqlOf(calls[0]);
      expect(sql).toContain('INSERT INTO "PrivateStorageCleanup"');
      expect(sql).toContain('ON CONFLICT ("provider", "storageKey") DO UPDATE');
      expect(sql).toContain('"status" = \'PENDING\'');
      expect(sql).toContain('"lastAttemptAt" = NULL');
      expect(calls.map((call) => (call as unknown[]).slice(1, 4))).toEqual([
        ['supabase', REF.key, 'SESSION_DELETED'],
        ['local', other.key, 'SESSION_DELETED'],
      ]);
    });

    it("refuses objects outside the owner's folder and logs it", async () => {
      const foreign = { provider: 'supabase', key: 'victim-id/session/x.jpg' };
      const lookalike = {
        provider: 'supabase',
        key: 'owner-id-2/session/x.jpg',
      };

      await expect(
        lifecycle.scheduleDeletion(
          tx,
          [foreign, REF, lookalike],
          'SESSION_DELETED',
          'owner-id',
        ),
      ).resolves.toEqual([REF]);

      expect(tx.$executeRaw.mock.calls).toHaveLength(1);
      expect(tx.$executeRaw.mock.calls[0].slice(1, 3)).toEqual([
        'supabase',
        REF.key,
      ]);
      expect(
        (logger.error.mock.calls[0] as unknown[] | undefined)?.[1],
      ).toMatchObject({ refused: 2 });
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
        'victim-id',
      );
    });

    it('does nothing for an empty list', async () => {
      await expect(
        lifecycle.scheduleDeletion(tx, [], 'IMAGE_REPLACED', 'owner-id'),
      ).resolves.toEqual([]);
      expect(tx.$executeRaw.mock.calls).toHaveLength(0);
    });
  });

  describe('processing a deletion', () => {
    it('removes the ledger row only after the provider confirms the deletion', async () => {
      await expect(lifecycle.processRefs([REF])).resolves.toEqual(['DELETED']);

      expect(ledger.updateMany.mock.calls[0]?.[0]).toEqual({
        where: {
          id: 'task-1',
          status: 'PENDING',
          nextAttemptAt: task().nextAttemptAt,
        },
        data: {
          reason: 'IMAGE_REPLACED',
          lastAttemptAt: NOW,
          nextAttemptAt: new Date(NOW.getTime() + CLEANUP_POLICY.leaseMs),
        },
      });
      expect(storage.delete.mock.calls).toEqual([[REF]]);
      // Fenced on this attempt's claim: a re-armed row is never removed.
      expect(ledger.deleteMany.mock.calls).toEqual([
        [{ where: { id: 'task-1', status: 'PENDING', lastAttemptAt: NOW } }],
      ]);
      expect(storage.delete.mock.invocationCallOrder[0]).toBeLessThan(
        ledger.deleteMany.mock.invocationCallOrder[0],
      );
    });

    it('keeps a failed deletion pending with its error and a backoff, never as done', async () => {
      storage.delete.mockRejectedValue(
        new PrivateStorageError('STORAGE_TIMEOUT'),
      );
      ledger.findUnique.mockResolvedValue(task({ attempts: 2 }));

      await expect(lifecycle.processRefs([REF])).resolves.toEqual([
        'RETRY_SCHEDULED',
      ]);
      expect(ledger.deleteMany.mock.calls).toHaveLength(0);
      expect(ledger.updateMany.mock.calls[1]?.[0]).toEqual({
        where: { id: 'task-1', status: 'PENDING', lastAttemptAt: NOW },
        data: {
          attempts: 3,
          lastErrorCode: 'STORAGE_TIMEOUT',
          lastAttemptAt: NOW,
          status: 'PENDING',
          nextAttemptAt: new Date(
            NOW.getTime() + CLEANUP_POLICY.baseBackoffMs * 4,
          ),
        },
      });
      expect(logger.warn.mock.calls).toContainEqual([
        'Private image deletion failed; retry scheduled',
        expect.objectContaining({ taskId: 'task-1', code: 'STORAGE_TIMEOUT' }),
      ]);
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(REF.key);
    });

    it('retries for about a day before giving up', () => {
      let total = 0;
      for (let attempt = 1; attempt < CLEANUP_POLICY.maxAttempts; attempt++) {
        total += Math.min(
          CLEANUP_POLICY.baseBackoffMs * 2 ** (attempt - 1),
          CLEANUP_POLICY.maxBackoffMs,
        );
      }
      expect(total).toBeGreaterThan(24 * 60 * 60_000);
    });

    it('caps the retry backoff', async () => {
      storage.delete.mockRejectedValue(
        new PrivateStorageError('STORAGE_UNAVAILABLE'),
      );
      ledger.findUnique.mockResolvedValue(task({ attempts: 11 }));

      await lifecycle.processRefs([REF]);

      expect(ledger.updateMany.mock.calls[1]?.[0].data.nextAttemptAt).toEqual(
        new Date(NOW.getTime() + CLEANUP_POLICY.maxBackoffMs),
      );
    });

    it('keeps an exhausted deletion as FAILED for manual recovery', async () => {
      storage.delete.mockRejectedValue(
        new PrivateStorageError('STORAGE_ACCESS_DENIED'),
      );
      ledger.findUnique.mockResolvedValue(
        task({ attempts: CLEANUP_POLICY.maxAttempts - 1 }),
      );

      await expect(lifecycle.processRefs([REF])).resolves.toEqual(['FAILED']);
      expect(ledger.deleteMany.mock.calls).toHaveLength(0);
      expect(ledger.updateMany.mock.calls[1]?.[0].data).toMatchObject({
        status: 'FAILED',
        attempts: CLEANUP_POLICY.maxAttempts,
        lastErrorCode: 'STORAGE_ACCESS_DENIED',
      });
      expect(logger.error.mock.calls).toContainEqual([
        'Private image deletion failed permanently; manual recovery required',
        expect.objectContaining({ taskId: 'task-1', reason: 'IMAGE_REPLACED' }),
      ]);
    });

    it('fails an invalid key permanently on the first attempt', async () => {
      storage.delete.mockRejectedValue(
        new PrivateStorageError('INVALID_STORAGE_KEY'),
      );

      await expect(lifecycle.processRefs([REF])).resolves.toEqual(['FAILED']);
    });

    it('never deletes an object that is still referenced', async () => {
      prisma.imageAsset.count.mockResolvedValue(1);

      await expect(lifecycle.processRefs([REF])).resolves.toEqual([
        'SKIPPED_REFERENCED',
      ]);
      expect(storage.delete.mock.calls).toHaveLength(0);
      expect(prisma.imageAsset.count.mock.calls[0]?.[0]).toEqual({
        where: { storageKey: REF.key, storageProvider: REF.provider },
      });
      expect(prisma.userProfile.count.mock.calls[0]?.[0]).toEqual({
        where: { avatarUrl: REF.key, avatarStorageProvider: REF.provider },
      });
    });

    it('leaves the row alone when another worker already claimed it', async () => {
      ledger.updateMany.mockResolvedValue({ count: 0 });

      await expect(lifecycle.processRefs([REF])).resolves.toEqual([
        'NOT_ATTEMPTED',
      ]);
      expect(storage.delete.mock.calls).toHaveLength(0);
    });

    it.each([
      ['not yet due', task({ nextAttemptAt: new Date(NOW.getTime() + 1) })],
      ['already FAILED', task({ status: 'FAILED' })],
    ])('does not attempt a row that is %s', async (_label, row) => {
      ledger.findUnique.mockResolvedValue(row);

      await expect(lifecycle.processRefs([REF])).resolves.toEqual([
        'NOT_ATTEMPTED',
      ]);
      expect(ledger.updateMany.mock.calls).toHaveLength(0);
      expect(storage.delete.mock.calls).toHaveLength(0);
    });

    it('never throws when the ledger is unavailable', async () => {
      ledger.findUnique.mockRejectedValue(new Error('database down'));

      await expect(lifecycle.processRefs([REF, REF])).resolves.toEqual([
        'NOT_ATTEMPTED',
        'NOT_ATTEMPTED',
      ]);
    });
  });

  describe('provider outages (circuit breaker)', () => {
    const key = (n: number) => `owner-id/s/${n}.jpg`;
    const rows = (provider: string, n: number) =>
      Array.from({ length: n }, (_, i) =>
        task({ id: `${provider}-${i}`, provider, storageKey: key(i) }),
      );

    it.each(['STORAGE_TIMEOUT', 'STORAGE_UNAVAILABLE'] as const)(
      'after a %s, leaves the rest of that provider for the cleaner instead of waiting on each',
      async (code) => {
        const queued = rows('supabase', 4);
        ledger.findUnique.mockImplementation(((args: {
          where: { provider_storageKey: { storageKey: string } };
        }) =>
          Promise.resolve(
            queued.find(
              (row) =>
                row.storageKey === args.where.provider_storageKey.storageKey,
            ) ?? null,
          )) as never);
        storage.delete.mockRejectedValue(new PrivateStorageError(code));

        await expect(
          lifecycle.processRefs(
            queued.map((row) => ({
              provider: 'supabase',
              key: row.storageKey,
            })),
          ),
        ).resolves.toEqual([
          'RETRY_SCHEDULED',
          'NOT_ATTEMPTED',
          'NOT_ATTEMPTED',
          'NOT_ATTEMPTED',
        ]);
        expect(storage.delete.mock.calls).toHaveLength(1);
        // Skipped rows are untouched: still PENDING and due for the cleaner.
        expect(ledger.findUnique.mock.calls).toHaveLength(1);
      },
    );

    it('keeps processing other providers in the same cleaner pass', async () => {
      ledger.findMany.mockResolvedValue([
        ...rows('supabase', 2),
        ...rows('fake-s3', 2),
      ]);
      storage.delete.mockImplementation((ref) =>
        ref.provider === 'supabase'
          ? Promise.reject(new PrivateStorageError('STORAGE_TIMEOUT'))
          : Promise.resolve(),
      );

      await expect(lifecycle.processDue()).resolves.toEqual([
        'RETRY_SCHEDULED',
        'NOT_ATTEMPTED',
        'DELETED',
        'DELETED',
      ]);
      expect(storage.delete.mock.calls.map(([ref]) => ref.provider)).toEqual([
        'supabase',
        'fake-s3',
        'fake-s3',
      ]);
    });

    it('does not trip on permanent, object-specific failures', async () => {
      ledger.findMany.mockResolvedValue(rows('supabase', 3));
      storage.delete
        .mockRejectedValueOnce(new PrivateStorageError('DELETE_NOT_APPLIED'))
        .mockResolvedValue();

      await expect(lifecycle.processDue()).resolves.toEqual([
        'RETRY_SCHEDULED',
        'DELETED',
        'DELETED',
      ]);
    });
  });

  describe('requeueFailedDeletions (recovery)', () => {
    it('requeues only FAILED rows, keeping provider, key, reason and last error', async () => {
      ledger.updateMany.mockResolvedValue({ count: 2 });

      await expect(
        lifecycle.requeueFailedDeletions({ provider: 'supabase' }),
      ).resolves.toBe(2);

      expect(ledger.updateMany.mock.calls[0]?.[0]).toEqual({
        where: { status: 'FAILED', provider: 'supabase' },
        data: {
          status: 'PENDING',
          attempts: 0,
          nextAttemptAt: NOW,
          lastAttemptAt: null,
        },
      });
    });

    it('can target specific rows', async () => {
      await lifecycle.requeueFailedDeletions({ ids: ['a', 'b'] });

      expect(ledger.updateMany.mock.calls[0]?.[0].where).toEqual({
        status: 'FAILED',
        id: { in: ['a', 'b'] },
      });
    });
  });

  describe('processDue (background cleaner)', () => {
    it('processes due PENDING rows and converts expired reservations to abandoned uploads', async () => {
      ledger.findMany.mockResolvedValue([
        task({ id: 'expired', reason: 'UPLOAD_PENDING' }),
      ]);

      await expect(lifecycle.processDue()).resolves.toEqual(['DELETED']);
      expect(ledger.findMany.mock.calls[0]?.[0]).toEqual({
        where: { status: 'PENDING', nextAttemptAt: { lte: NOW } },
        orderBy: { nextAttemptAt: 'asc' },
        take: CLEANUP_POLICY.batchSize,
      });
      expect(ledger.updateMany.mock.calls[0]?.[0].data).toMatchObject({
        reason: 'UPLOAD_ABANDONED',
      });
    });

    it('isolates a failing row so the rest of the batch is still processed', async () => {
      ledger.findMany.mockResolvedValue([
        task({ id: 'broken' }),
        task({ id: 'healthy', storageKey: 'owner-id/s/ok.jpg' }),
      ]);
      prisma.imageAsset.count
        .mockRejectedValueOnce(new Error('database hiccup'))
        .mockResolvedValue(0);

      await expect(lifecycle.processDue()).resolves.toEqual([
        'NOT_ATTEMPTED',
        'DELETED',
      ]);
      expect(storage.delete.mock.calls).toEqual([
        [{ provider: 'supabase', key: 'owner-id/s/ok.jpg' }],
      ]);
    });

    it('does not overlap passes on the same instance and survives ledger errors', async () => {
      let release: (rows: PrivateStorageCleanup[]) => void = () => undefined;
      ledger.findMany.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }) as never,
      );

      const first = lifecycle.processDue();
      await expect(lifecycle.processDue()).resolves.toEqual([]);
      release([]);
      await expect(first).resolves.toEqual([]);

      ledger.findMany.mockRejectedValueOnce(new Error('database down'));
      await expect(lifecycle.processDue()).resolves.toEqual([]);
    });
  });
});
