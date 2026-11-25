import { StepUpGuard } from '../auth/step-up/step-up.guard';
import { STEP_UP_APPROVED } from '../../test/support/step-up-approved';
import {
  Global,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { DataExport } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { randomUUID } from 'node:crypto';
import { DataExportTable } from '../../test/support/data-export-table';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Logger } from 'winston';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { UserRole } from '../auth/interfaces/auth.interface';
import { AuthUtilsService } from '../auth/services/auth-utils.service';
import config from '../common/config/app.config';
import { AllExceptionsFilter } from '../common/filters/all-exception.filter';
import { AuthGuard } from '../common/guards/auth.guard';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor';
import { PrismaService } from '../common/services/prisma.service';
import { RateLimitStore } from '../infrastructure/rate-limit/rate-limit.store';
import { TokenVersionCache } from '../infrastructure/token-version/token-version.cache';
import { PrivacyExportStorageService } from '../storage/privacy-export-storage.service';
import type { DataExportView } from './interfaces/privacy-export.interface';
import {
  PRIVACY_EXPORT_FAILURES,
  PRIVACY_EXPORT_RETENTION_MS,
} from './privacy-export.constants';
import { PrivacyExportDownloadService } from './download/privacy-export-download.service';
import { PrivacyExportController } from './privacy-export.controller';
import { PrivacyExportService } from './privacy-export.service';
import { PrivacyExportLifecycleService } from './queues/privacy-export-lifecycle.service';
import { PrivacyExportQueueService } from './queues/privacy-export.queue';

const USER_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const USER_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const anyString: unknown = expect.any(String);

/** The enveloped `data` of a successful response. */
const dataOf = (response: { body: unknown }) =>
  (response.body as { data: DataExportView }).data;
const messageOf = (response: { body: unknown }) =>
  (response.body as { message: string }).message;

/** Marks an export as published, as the worker would. */
function complete(table: DataExportTable, id: string, completedAt: Date) {
  Object.assign(table.get(id), {
    status: 'COMPLETED',
    progress: 100,
    storageKey: `${USER_A}/${id}/archive.zip`,
    sizeBytes: BigInt(2048),
    sha256: 'f'.repeat(64),
    photoCount: 4,
    missingPhotoCount: 0,
    startedAt: completedAt,
    completedAt,
    expiresAt: new Date(completedAt.getTime() + PRIVACY_EXPORT_RETENTION_MS),
  } satisfies Partial<DataExport>);
}

const prisma = mockDeep<PrismaService>();
const tokenVersions = mock<TokenVersionCache>();
const queue = mock<PrivacyExportQueueService>();
const storage = mock<PrivacyExportStorageService>();

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: prisma },
    { provide: TokenVersionCache, useValue: tokenVersions },
    { provide: WINSTON_MODULE_PROVIDER, useValue: mock<Logger>() },
  ],
  exports: [PrismaService, TokenVersionCache, WINSTON_MODULE_PROVIDER],
})
class TestInfrastructureModule {}

describe('Privacy export endpoints (HTTP)', () => {
  let app: INestApplication<App>;
  let table: DataExportTable;
  let originalSecret: string;
  const tokens = new AuthUtilsService(mock<RateLimitStore>());
  const bearer = (userId: string) =>
    `Bearer ${tokens.createAccessToken({ userId, role: UserRole.USER, tokenVersion: 1 })}`;
  const http = () => request(app.getHttpServer());
  const requestExport = (userId: string, key?: string) => {
    const req = http()
      .post('/v1/privacy/exports')
      .set('Authorization', bearer(userId));
    return key ? req.set('Idempotency-Key', key) : req;
  };

  beforeAll(async () => {
    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'privacy-export-spec-secret';
    const moduleRef = await Test.createTestingModule({
      imports: [TestInfrastructureModule],
      controllers: [PrivacyExportController],
      providers: [
        PrivacyExportService,
        AuthGuard,
        { provide: PrivacyExportQueueService, useValue: queue },
        PrivacyExportLifecycleService,
        {
          provide: PrivacyExportDownloadService,
          useValue: mock<PrivacyExportDownloadService>(),
        },
        { provide: PrivacyExportStorageService, useValue: storage },
      ],
    })
      .overrideGuard(StepUpGuard)
      .useValue(STEP_UP_APPROVED)
      .compile();
    app = moduleRef.createNestApplication();
    const logger = mock<Logger>();
    app.useGlobalFilters(new AllExceptionsFilter(logger));
    app.useGlobalInterceptors(new TransformInterceptor(logger));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    // Listen once so concurrent supertest requests share one server.
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    config.jwt_access_secret = originalSecret;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    table = new DataExportTable();
    // AuthGuard: the token version cached for every user is 1.
    tokenVersions.get.mockResolvedValue(1);
    table.attach(prisma);
    // Owners are active unless a test says otherwise.
    prisma.authUser.findUnique.mockResolvedValue({ status: 'ACTIVE' } as never);
    queue.enqueue.mockResolvedValue();
    storage.deleteExportScope.mockResolvedValue();
  });

  describe('authentication', () => {
    it.each([
      ['post', '/v1/privacy/exports'],
      ['get', '/v1/privacy/exports'],
      ['get', `/v1/privacy/exports/${randomUUID()}`],
    ] as const)('rejects %s %s without a token', async (method, path) => {
      await http()[method](path).expect(401);
      expect(prisma.dataExport.create.mock.calls).toHaveLength(0);
    });

    it('rejects a token signed with another secret', async () => {
      const forged = new AuthUtilsService(mock<RateLimitStore>());
      config.jwt_access_secret = 'attacker-secret';
      const token = forged.createAccessToken({
        userId: USER_A,
        role: UserRole.USER,
        tokenVersion: 1,
      });
      config.jwt_access_secret = 'privacy-export-spec-secret';

      await http()
        .post('/v1/privacy/exports')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
      expect(table.rows).toHaveLength(0);
    });

    it('rejects a revoked token (token version changed)', async () => {
      tokenVersions.get.mockResolvedValue(2);

      await requestExport(USER_A).expect(401);
      expect(table.rows).toHaveLength(0);
    });
  });

  describe('POST /v1/privacy/exports', () => {
    it('queues an export for the token owner and returns 202 with its status', async () => {
      const response = await requestExport(USER_A).expect(202);
      const body = response.body as {
        statusCode: number;
        data: DataExportView;
      };

      expect(body.statusCode).toBe(202);
      expect(body.data).toEqual({
        id: anyString,
        status: 'QUEUED',
        progress: 0,
        requestedAt: anyString,
        startedAt: null,
        completedAt: null,
        expiresAt: null,
        sizeBytes: null,
        sha256: null,
        photoCount: null,
        missingPhotoCount: null,
        attempts: 0,
        error: null,
        errorCode: null,
      });
      expect(table.rows).toEqual([
        expect.objectContaining({ id: body.data.id, authId: USER_A }),
      ]);
      expect(queue.enqueue.mock.calls).toContainEqual([
        {
          exportId: body.data.id,
          authId: USER_A,
        },
      ]);
    });

    it.each([
      [{ userId: USER_B }],
      [{ authId: USER_B }],
      [{ anything: true }],
      [[USER_B]],
    ])(
      'rejects a request body (%j) instead of letting it choose the owner',
      async (body) => {
        await requestExport(USER_A).send(body).expect(400);
        expect(table.rows).toHaveLength(0);
        expect(queue.enqueue.mock.calls).toHaveLength(0);
      },
    );

    it.each(['has space', 'x'.repeat(129), 'semi;colon', 'a/b'])(
      'rejects an invalid Idempotency-Key (%s)',
      async (key) => {
        await requestExport(USER_A, key).expect(400);
        expect(table.rows).toHaveLength(0);
      },
    );

    it('returns the same export for a repeated Idempotency-Key', async () => {
      const key = randomUUID();
      const first = await requestExport(USER_A, key).expect(202);
      complete(table, dataOf(first).id, new Date());
      const retry = await requestExport(USER_A, key).expect(202);

      expect(dataOf(retry).id).toBe(dataOf(first).id);
      expect(dataOf(retry).status).toBe('COMPLETED');
      expect(queue.enqueue.mock.calls).toHaveLength(1);
    });

    it('scopes Idempotency-Keys per user', async () => {
      const key = 'shared-key-123';
      const a = await requestExport(USER_A, key).expect(202);
      const b = await requestExport(USER_B, key).expect(202);

      expect(dataOf(b).id).not.toBe(dataOf(a).id);
      expect(table.rows.map((row) => row.authId)).toEqual([USER_A, USER_B]);
    });

    it('returns the waiting export instead of starting a second one', async () => {
      const first = await requestExport(USER_A).expect(202);
      const second = await requestExport(USER_A).expect(202);

      expect(dataOf(second).id).toBe(dataOf(first).id);
      expect(table.rows).toHaveLength(1);
      expect(queue.enqueue.mock.calls).toHaveLength(1);
    });

    it('converges concurrent requests on a single export', async () => {
      // Barrier: all five requests see "no active export" before any of them
      // creates one, so four must lose the database uniqueness race.
      const racers = 5;
      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      prisma.dataExport.findFirst.mockImplementation((async (
        args: Parameters<DataExportTable['findFirst']>[0],
      ) => {
        if (arrived < racers) {
          arrived += 1;
          const result = await table.findFirst(args);
          if (arrived === racers) release();
          await gate;
          return result;
        }
        return table.findFirst(args);
      }) as never);

      const responses = await Promise.all(
        Array.from({ length: racers }, () => requestExport(USER_A)),
      );

      expect(responses.map((response) => response.status)).toEqual(
        Array(racers).fill(202),
      );
      expect(prisma.dataExport.create.mock.calls).toHaveLength(racers);
      expect(
        new Set(responses.map((response) => dataOf(response).id)).size,
      ).toBe(1);
      expect(table.rows).toHaveLength(1);
      expect(queue.enqueue.mock.calls).toHaveLength(1);
    });

    it('allows a new export once the previous one has finished', async () => {
      const first = await requestExport(USER_A).expect(202);
      complete(table, dataOf(first).id, new Date());

      const second = await requestExport(USER_A).expect(202);

      expect(dataOf(second).id).not.toBe(dataOf(first).id);
      expect(queue.enqueue.mock.calls).toHaveLength(2);
    });

    it('does not let another user’s active export block or leak into the request', async () => {
      const other = await requestExport(USER_B).expect(202);
      const mine = await requestExport(USER_A).expect(202);

      expect(dataOf(mine).id).not.toBe(dataOf(other).id);
    });

    it('refuses to start an export for an account that is no longer active (e.g. pending deletion)', async () => {
      prisma.authUser.findUnique.mockResolvedValue({
        status: 'PENDING_DELETION',
      } as never);

      await requestExport(USER_A).expect(401);

      expect(table.rows).toHaveLength(0);
      expect(queue.enqueue.mock.calls).toHaveLength(0);
    });

    it('returns 503 and records a failed export when the queue is unavailable', async () => {
      queue.enqueue.mockRejectedValueOnce(new Error('redis down'));

      const response = await requestExport(USER_A).expect(503);

      expect(JSON.stringify(response.body)).not.toContain('redis');
      expect(table.rows).toEqual([
        expect.objectContaining({
          status: 'FAILED',
          error: PRIVACY_EXPORT_FAILURES.QUEUE_UNAVAILABLE,
          errorCode: 'QUEUE_UNAVAILABLE',
        }),
      ]);
      // The failed export no longer blocks a retry.
      await requestExport(USER_A).expect(202);
      expect(table.rows).toHaveLength(2);
    });
  });

  describe('failed, repeated and retried requests', () => {
    const fail = (id: string) =>
      table.updateMany({
        where: { id },
        data: {
          status: 'FAILED',
          error: PRIVACY_EXPORT_FAILURES.GENERATION_FAILED,
          errorCode: 'GENERATION_FAILED',
          completedAt: new Date(),
          attempts: 3,
        },
      });

    it('shows a failed export with its reason and code', async () => {
      const created = await requestExport(USER_A).expect(202);
      await fail(dataOf(created).id);

      const response = await http()
        .get(`/v1/privacy/exports/${dataOf(created).id}`)
        .set('Authorization', bearer(USER_A))
        .expect(200);

      expect(dataOf(response)).toMatchObject({
        status: 'FAILED',
        attempts: 3,
        error: PRIVACY_EXPORT_FAILURES.GENERATION_FAILED,
        errorCode: 'GENERATION_FAILED',
        sha256: null,
        sizeBytes: null,
      });
    });

    it('answers a retried request (same Idempotency-Key) with the failed export instead of queueing again', async () => {
      const key = randomUUID();
      const created = await requestExport(USER_A, key).expect(202);
      await fail(dataOf(created).id);

      const retried = await requestExport(USER_A, key).expect(202);

      expect(dataOf(retried)).toMatchObject({
        id: dataOf(created).id,
        status: 'FAILED',
        errorCode: 'GENERATION_FAILED',
      });
      expect(table.rows).toHaveLength(1);
      expect(queue.enqueue.mock.calls).toHaveLength(1);
    });

    it('starts exactly one new export when the user asks again after a failure', async () => {
      const created = await requestExport(USER_A).expect(202);
      await fail(dataOf(created).id);

      const [again, repeated] = [
        await requestExport(USER_A).expect(202),
        await requestExport(USER_A).expect(202),
      ];

      expect(dataOf(again).id).not.toBe(dataOf(created).id);
      expect(dataOf(repeated).id).toBe(dataOf(again).id);
      expect(table.rows.map((row) => row.status)).toEqual(['FAILED', 'QUEUED']);
      expect(queue.enqueue.mock.calls.map(([job]) => job.exportId)).toEqual([
        dataOf(created).id,
        dataOf(again).id,
      ]);
    });

    it.each(['QUEUED', 'PROCESSING'] as const)(
      'does not queue a second job while the export is %s',
      async (status) => {
        const created = await requestExport(USER_A).expect(202);
        await table.updateMany({
          where: { id: dataOf(created).id },
          data: { status, progress: status === 'PROCESSING' ? 40 : 0 },
        });

        for (let i = 0; i < 3; i += 1) {
          const repeated = await requestExport(USER_A).expect(202);
          expect(dataOf(repeated)).toMatchObject({
            id: dataOf(created).id,
            status,
          });
        }
        expect(table.rows).toHaveLength(1);
        expect(queue.enqueue.mock.calls).toHaveLength(1);
      },
    );

    it('records a queueing failure with its reason and removes any export files', async () => {
      queue.enqueue.mockRejectedValueOnce(new Error('redis down'));

      await requestExport(USER_A).expect(503);

      const [failed] = table.rows;
      expect(failed).toMatchObject({
        status: 'FAILED',
        errorCode: 'QUEUE_UNAVAILABLE',
        error: PRIVACY_EXPORT_FAILURES.QUEUE_UNAVAILABLE,
        completedAt: expect.any(Date) as unknown,
        filesDeletedAt: expect.any(Date) as unknown,
      });
      expect(storage.deleteExportScope.mock.calls).toEqual([
        [USER_A, failed.id],
      ]);
    });
  });

  describe('GET /v1/privacy/exports/:exportId', () => {
    it('returns the owner’s export status and progress', async () => {
      const created = await requestExport(USER_A).expect(202);
      const id = dataOf(created).id;
      await table.updateMany({
        where: { id },
        data: { status: 'PROCESSING', progress: 40, startedAt: new Date() },
      });

      const response = await http()
        .get(`/v1/privacy/exports/${id}`)
        .set('Authorization', bearer(USER_A))
        .expect(200);

      expect(dataOf(response)).toMatchObject({
        id,
        status: 'PROCESSING',
        progress: 40,
      });
    });

    it('answers another user’s export exactly like a missing one', async () => {
      const created = await requestExport(USER_A).expect(202);

      const foreign = await http()
        .get(`/v1/privacy/exports/${dataOf(created).id}`)
        .set('Authorization', bearer(USER_B))
        .expect(404);
      const missing = await http()
        .get(`/v1/privacy/exports/${randomUUID()}`)
        .set('Authorization', bearer(USER_B))
        .expect(404);

      expect(messageOf(foreign)).toBe('Data export not found');
      expect(messageOf(missing)).toBe(messageOf(foreign));
    });

    it('rejects a malformed export id', async () => {
      await http()
        .get('/v1/privacy/exports/not-a-uuid')
        .set('Authorization', bearer(USER_A))
        .expect(400);
      expect(prisma.dataExport.findFirst.mock.calls).toHaveLength(0);
    });

    it('describes a completed export without exposing its storage location', async () => {
      const created = await requestExport(USER_A).expect(202);
      const id = dataOf(created).id;
      const completedAt = new Date();
      complete(table, id, completedAt);

      const response = await http()
        .get(`/v1/privacy/exports/${id}`)
        .set('Authorization', bearer(USER_A))
        .expect(200);

      expect(dataOf(response)).toMatchObject({
        status: 'COMPLETED',
        progress: 100,
        sizeBytes: 2048,
        sha256: 'f'.repeat(64),
        photoCount: 4,
        completedAt: completedAt.toISOString(),
        expiresAt: new Date(
          completedAt.getTime() + PRIVACY_EXPORT_RETENTION_MS,
        ).toISOString(),
      });
      const raw = JSON.stringify(response.body);
      expect(raw).not.toContain('archive.zip');
      expect(raw).not.toContain('storageKey');
      expect(raw).not.toContain('idempotencyKey');
      expect(raw).not.toContain('authId');
    });

    it('reports a completed export as EXPIRED once its retention has passed', async () => {
      const created = await requestExport(USER_A).expect(202);
      const id = dataOf(created).id;
      complete(
        table,
        id,
        new Date(Date.now() - PRIVACY_EXPORT_RETENTION_MS - 1_000),
      );

      const response = await http()
        .get(`/v1/privacy/exports/${id}`)
        .set('Authorization', bearer(USER_A))
        .expect(200);

      expect(dataOf(response)).toMatchObject({
        status: 'EXPIRED',
        sha256: null,
      });
    });
  });

  describe('GET /v1/privacy/exports', () => {
    it('lists only the caller’s exports, newest first', async () => {
      const first = await requestExport(USER_A).expect(202);
      complete(table, dataOf(first).id, new Date());
      await requestExport(USER_B).expect(202);
      const second = await requestExport(USER_A).expect(202);

      const response = await http()
        .get('/v1/privacy/exports')
        .set('Authorization', bearer(USER_A))
        .expect(200);

      expect(
        (response.body as { data: DataExportView[] }).data.map(
          (item) => item.id,
        ),
      ).toEqual([dataOf(second).id, dataOf(first).id]);
      expect(prisma.dataExport.findMany.mock.calls).toContainEqual([
        expect.objectContaining({ where: { authId: USER_A } }),
      ]);
    });
  });
});
