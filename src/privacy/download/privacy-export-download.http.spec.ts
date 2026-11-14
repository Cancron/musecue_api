import {
  Global,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { DataExport } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Logger } from 'winston';
import { DataExportTable } from '../../../test/support/data-export-table';
import { freezeTime } from '../../../test/support/freeze-time';
import { UserRole } from '../../auth/interfaces/auth.interface';
import { AuthUtilsService } from '../../auth/services/auth-utils.service';
import config from '../../common/config/app.config';
import { AllExceptionsFilter } from '../../common/filters/all-exception.filter';
import { AuthGuard } from '../../common/guards/auth.guard';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { PrismaService } from '../../common/services/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { redactUrl } from '../../common/utils/redact-url';
import { PrivacyExportStorageService } from '../../storage/privacy-export-storage.service';
import { PRIVACY_EXPORT_RETENTION_MS } from '../privacy-export.constants';
import { PrivacyExportController } from '../privacy-export.controller';
import { PrivacyExportService } from '../privacy-export.service';
import { PrivacyExportLifecycleService } from '../queues/privacy-export-lifecycle.service';
import { PrivacyExportQueueService } from '../queues/privacy-export.queue';
import {
  type DownloadLinkView,
  PrivacyExportDownloadService,
} from './privacy-export-download.service';
import { PrivacyExportLinkSigner } from './privacy-export-link.signer';

const OWNER = '0a0a0a0a-0000-4000-8000-00000000000a';
const OTHER = '0b0b0b0b-0000-4000-8000-00000000000b';
const T0 = new Date('2026-09-01T12:00:00.000Z');
const MINUTE = 60_000;
const FIFTEEN_MINUTES = 15 * MINUTE;

const prisma = mockDeep<PrismaService>();
const redis = mock<RedisService>();
const interceptorLogger = mock<Logger>();
const filterLogger = mock<Logger>();

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: prisma },
    { provide: RedisService, useValue: redis },
    { provide: WINSTON_MODULE_PROVIDER, useValue: mock<Logger>() },
  ],
  exports: [PrismaService, RedisService, WINSTON_MODULE_PROVIDER],
})
class TestInfrastructureModule {}

/** Collects a binary response body into a Buffer (supertest parser). */
const binary = (
  response: unknown,
  callback: (error: Error | null, body: Buffer) => void,
) => {
  const stream = response as IncomingMessage;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
};

const linkOf = (response: { body: unknown }) =>
  (response.body as { data: DownloadLinkView }).data;
const messageOf = (response: { body: unknown }) =>
  (response.body as { message: string }).message;

describe('Privacy export downloads (HTTP, time-controlled)', () => {
  let app: INestApplication<App>;
  let table: DataExportTable;
  let storage: PrivacyExportStorageService;
  let root: string;
  let originalSecret: string;
  const originalExportDir = process.env.PRIVATE_EXPORT_DIR;
  const tokens = new AuthUtilsService(mock<RedisService>());

  /** An access token minted at the current (frozen) time. */
  const bearer = (userId: string) =>
    `Bearer ${tokens.createAccessToken({ userId, role: UserRole.USER, tokenVersion: 1 })}`;
  const http = () => request(app.getHttpServer());
  const requestLink = (exportId: string, userId: string | null = OWNER) => {
    const req = http().get(`/v1/privacy/exports/${exportId}/download`);
    return userId ? req.set('Authorization', bearer(userId)) : req;
  };
  const download = (url: string, userId: string | null = OWNER) => {
    const req = http().get(url).buffer(true).parse(binary);
    return userId ? req.set('Authorization', bearer(userId)) : req;
  };

  /** A COMPLETED export of `authId` with a real archive in private storage. */
  async function completedExport(
    authId = OWNER,
    completedAt = new Date(T0.getTime() - 60 * MINUTE),
  ) {
    const row = await table.create({
      data: { authId, idempotencyKey: randomUUID() },
    });
    const bytes = Buffer.from(`PK-archive-of-${authId}-${row.id}`);
    const target = await storage.createArchive(authId, row.id);
    await new Promise<void>((resolve) => target.stream.end(bytes, resolve));
    await storage.commitArchive(target.storageKey);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    Object.assign(row, {
      status: 'COMPLETED',
      progress: 100,
      storageKey: target.storageKey,
      sizeBytes: BigInt(bytes.length),
      sha256,
      photoCount: 1,
      missingPhotoCount: 0,
      startedAt: completedAt,
      completedAt,
      expiresAt: new Date(completedAt.getTime() + PRIVACY_EXPORT_RETENTION_MS),
    } satisfies Partial<DataExport>);
    return { id: row.id, bytes, sha256, storageKey: target.storageKey };
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'privacy-download-'));
    process.env.PRIVATE_EXPORT_DIR = root;
    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'privacy-download-spec-secret';
    storage = new PrivacyExportStorageService();

    const moduleRef = await Test.createTestingModule({
      imports: [TestInfrastructureModule],
      controllers: [PrivacyExportController],
      providers: [
        PrivacyExportService,
        PrivacyExportDownloadService,
        PrivacyExportLinkSigner,
        AuthGuard,
        // Reads process.env, so tests can change the download settings.
        { provide: ConfigService, useValue: new ConfigService() },
        { provide: PrivacyExportStorageService, useValue: storage },
        {
          provide: PrivacyExportQueueService,
          useValue: mock<PrivacyExportQueueService>(),
        },
        {
          provide: PrivacyExportLifecycleService,
          useValue: mock<PrivacyExportLifecycleService>(),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter(filterLogger));
    app.useGlobalInterceptors(new TransformInterceptor(interceptorLogger));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    config.jwt_access_secret = originalSecret;
    if (originalExportDir === undefined) delete process.env.PRIVATE_EXPORT_DIR;
    else process.env.PRIVATE_EXPORT_DIR = originalExportDir;
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    freezeTime(T0);
    table = new DataExportTable().attach(prisma);
    redis.get.mockResolvedValue(1 as never);
    delete process.env.PRIVACY_EXPORT_DOWNLOAD_TTL_SECONDS;
    delete process.env.PRIVACY_EXPORT_DOWNLOAD_SECRET;
  });

  afterEach(() => jest.useRealTimers());

  describe('GET /v1/privacy/exports/:exportId/download (link)', () => {
    it('gives the owner a signed link that expires after exactly 15 minutes', async () => {
      const created = await completedExport();

      const response = await requestLink(created.id).expect(200);

      const link = linkOf(response);
      const expires = (T0.getTime() + FIFTEEN_MINUTES) / 1000;
      expect(link).toEqual({
        url: expect.stringMatching(
          new RegExp(
            `^/v1/privacy/exports/${created.id}/archive\\?expires=${expires}&signature=[A-Za-z0-9_-]{43}$`,
          ),
        ) as unknown,
        method: 'GET',
        expiresAt: new Date(T0.getTime() + FIFTEEN_MINUTES).toISOString(),
        fileName: 'musecue-data-export-2026-09-01.zip',
        sizeBytes: created.bytes.length,
        sha256: created.sha256,
      });
      expect(response.headers['cache-control']).toBe('private, no-store');
      // The response never reveals where the archive is stored.
      expect(JSON.stringify(response.body)).not.toContain(created.storageKey);
    });

    it.each([
      ['120', 2 * MINUTE],
      ['3600', FIFTEEN_MINUTES],
      ['10', MINUTE],
      ['not-a-number', FIFTEEN_MINUTES],
    ])(
      'honors PRIVACY_EXPORT_DOWNLOAD_TTL_SECONDS=%s within 1-15 minutes',
      async (setting, lifetimeMs) => {
        process.env.PRIVACY_EXPORT_DOWNLOAD_TTL_SECONDS = setting;
        const created = await completedExport();

        const link = linkOf(await requestLink(created.id).expect(200));

        expect(new Date(link.expiresAt).getTime() - T0.getTime()).toBe(
          lifetimeMs,
        );
      },
    );

    it('never lets a link outlive the archive itself', async () => {
      // The archive expires 5 minutes from now.
      const created = await completedExport(
        OWNER,
        new Date(T0.getTime() - PRIVACY_EXPORT_RETENTION_MS + 5 * MINUTE),
      );

      const link = linkOf(await requestLink(created.id).expect(200));

      expect(link.expiresAt).toBe(
        new Date(T0.getTime() + 5 * MINUTE).toISOString(),
      );
    });

    it('requires authentication', async () => {
      const created = await completedExport();

      await requestLink(created.id, null).expect(401);
      await http()
        .get(`/v1/privacy/exports/${created.id}/download`)
        .set('Authorization', 'Bearer not-a-jwt')
        .expect(401);
    });

    it('does not issue links for another user’s export, answering like a missing one', async () => {
      const theirs = await completedExport(OTHER);

      const foreign = await requestLink(theirs.id, OWNER).expect(404);
      const missing = await requestLink(randomUUID(), OWNER).expect(404);

      expect(messageOf(foreign)).toBe('Data export not found');
      expect(messageOf(missing)).toBe(messageOf(foreign));
      expect(JSON.stringify(foreign.body)).not.toContain('signature');
    });

    it.each([
      ['QUEUED', 409, 'The export is not ready yet'],
      ['PROCESSING', 409, 'The export is not ready yet'],
      ['FAILED', 409, 'The export failed and cannot be downloaded'],
      ['EXPIRED', 410, 'The export has expired'],
    ] as const)(
      'refuses a link for a %s export (%i)',
      async (status, code, message) => {
        const row = await table.create({
          data: { authId: OWNER, idempotencyKey: randomUUID() },
        });
        Object.assign(row, {
          status,
          ...(status === 'FAILED'
            ? {
                error: 'failed',
                errorCode: 'GENERATION_FAILED',
                completedAt: T0,
              }
            : {}),
        });

        const response = await requestLink(row.id).expect(code);

        expect(messageOf(response)).toBe(message);
      },
    );

    it('refuses a link once the completed archive has reached its 24-hour expiry', async () => {
      const created = await completedExport(
        OWNER,
        new Date(T0.getTime() - PRIVACY_EXPORT_RETENTION_MS),
      );

      const response = await requestLink(created.id).expect(410);

      expect(messageOf(response)).toBe('The export has expired');
    });

    it('rejects a malformed export ID', async () => {
      await requestLink('not-a-uuid').expect(400);
    });
  });

  describe('GET /v1/privacy/exports/:exportId/archive (signed link)', () => {
    it('streams the archive to its owner with private, non-cacheable headers', async () => {
      const created = await completedExport();
      const link = linkOf(await requestLink(created.id).expect(200));

      const response = await download(link.url).expect(200);

      expect(response.body).toEqual(created.bytes);
      expect(
        createHash('sha256')
          .update(response.body as Buffer)
          .digest('hex'),
      ).toBe(link.sha256);
      expect(response.headers).toMatchObject({
        'content-type': 'application/zip',
        'content-length': String(created.bytes.length),
        'content-disposition':
          'attachment; filename="musecue-data-export-2026-09-01.zip"',
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
    });

    it('can be used again while it is valid', async () => {
      const created = await completedExport();
      const link = linkOf(await requestLink(created.id).expect(200));

      await download(link.url).expect(200);
      await download(link.url).expect(200);
    });

    describe('unauthorized access', () => {
      it('rejects the link without the owner’s access token', async () => {
        const created = await completedExport();
        const link = linkOf(await requestLink(created.id).expect(200));

        const response = await download(link.url, null).expect(401);

        expect(response.body).not.toEqual(created.bytes);
      });

      it('rejects a revoked access token (token version changed)', async () => {
        const created = await completedExport();
        const link = linkOf(await requestLink(created.id).expect(200));
        redis.get.mockResolvedValue(2 as never);

        await download(link.url).expect(401);
      });

      it('rejects the owner’s link when another signed-in user uses it', async () => {
        const created = await completedExport();
        const link = linkOf(await requestLink(created.id).expect(200));

        const response = await download(link.url, OTHER).expect(403);

        expect(response.body).not.toEqual(created.bytes);
        expect(
          (
            JSON.parse((response.body as Buffer).toString()) as {
              message: string;
            }
          ).message,
        ).toBe('This download link is invalid');
      });

      it('does not let a user download another user’s export with their own link or a guessed signature', async () => {
        const theirs = await completedExport(OTHER);
        const mine = await completedExport(OWNER);
        const myLink = linkOf(await requestLink(mine.id).expect(200));
        const query = myLink.url.split('?')[1];

        // Re-using my valid signature with their export ID.
        await download(
          `/v1/privacy/exports/${theirs.id}/archive?${query}`,
          OWNER,
        ).expect(403);
        // A made-up signature.
        await download(
          `/v1/privacy/exports/${theirs.id}/archive?expires=${
            T0.getTime() / 1000 + 60
          }&signature=${'A'.repeat(43)}`,
          OWNER,
        ).expect(403);
      });

      it.each([
        [
          'a later expiry',
          (url: string) =>
            url.replace(
              /expires=(\d+)/,
              (_m, v: string) => `expires=${Number(v) + 3600}`,
            ),
        ],
        [
          'an earlier expiry',
          (url: string) =>
            url.replace(
              /expires=(\d+)/,
              (_m, v: string) => `expires=${Number(v) - 1}`,
            ),
        ],
        [
          'an altered signature',
          (url: string) =>
            url.replace(
              /signature=(.)/,
              (_m, c: string) => `signature=${c === 'A' ? 'B' : 'A'}`,
            ),
        ],
      ])('rejects a link with %s', async (_label, tamper) => {
        const created = await completedExport();
        const link = linkOf(await requestLink(created.id).expect(200));

        await download(tamper(link.url)).expect(403);
      });

      it('rejects a link for another export of the same owner', async () => {
        const first = await completedExport();
        const second = await completedExport();
        const link = linkOf(await requestLink(first.id).expect(200));

        await download(link.url.replace(first.id, second.id)).expect(403);
      });

      it.each([
        ['no query', ''],
        ['no signature', '?expires=1790000000'],
        [
          'a malformed signature',
          `?expires=1790000000&signature=${'!'.repeat(43)}`,
        ],
        [
          'an extra parameter',
          `?expires=1790000000&signature=${'A'.repeat(43)}&as=other`,
        ],
      ])('rejects a request with %s', async (_label, query) => {
        const created = await completedExport();

        await download(
          `/v1/privacy/exports/${created.id}/archive${query}`,
        ).expect(400);
      });
    });

    describe('expired download links (time-controlled)', () => {
      it('works until the last millisecond of its 15 minutes and is refused from then on', async () => {
        const created = await completedExport();
        const link = linkOf(await requestLink(created.id).expect(200));

        jest.setSystemTime(T0.getTime() + FIFTEEN_MINUTES - 1);
        await download(link.url).expect(200);

        jest.setSystemTime(T0.getTime() + FIFTEEN_MINUTES);
        const expired = await download(link.url).expect(410);
        expect(
          (
            JSON.parse((expired.body as Buffer).toString()) as {
              message: string;
            }
          ).message,
        ).toBe('This download link has expired');

        jest.setSystemTime(T0.getTime() + 2 * FIFTEEN_MINUTES);
        await download(link.url).expect(410);
      });

      it('issues a fresh link after the old one expired', async () => {
        const created = await completedExport();
        const old = linkOf(await requestLink(created.id).expect(200));

        jest.setSystemTime(T0.getTime() + 20 * MINUTE);
        await download(old.url).expect(410);
        const fresh = linkOf(await requestLink(created.id).expect(200));

        expect(fresh.url).not.toBe(old.url);
        await download(fresh.url).expect(200);
      });

      it('stops working when the archive reaches its 24-hour expiry, even inside the 15 minutes', async () => {
        const created = await completedExport(
          OWNER,
          new Date(T0.getTime() - PRIVACY_EXPORT_RETENTION_MS + 5 * MINUTE),
        );
        const link = linkOf(await requestLink(created.id).expect(200));

        jest.setSystemTime(T0.getTime() + 5 * MINUTE);

        await download(link.url).expect(410);
      });

      it('stops working once the export has been marked EXPIRED', async () => {
        const created = await completedExport();
        const link = linkOf(await requestLink(created.id).expect(200));
        Object.assign(table.get(created.id), { status: 'EXPIRED' });

        await download(link.url).expect(410);
      });
    });

    describe('archive integrity and availability', () => {
      it('refuses a link issued for an archive that was since replaced', async () => {
        const created = await completedExport();
        const link = linkOf(await requestLink(created.id).expect(200));
        Object.assign(table.get(created.id), { sha256: 'c'.repeat(64) });

        await download(link.url).expect(403);
      });

      it('answers 410 when the archive file is gone', async () => {
        const created = await completedExport();
        const link = linkOf(await requestLink(created.id).expect(200));
        await storage.delete(created.storageKey);

        await download(link.url).expect(410);
      });

      it('refuses to serve a file whose size no longer matches the export', async () => {
        const created = await completedExport();
        const link = linkOf(await requestLink(created.id).expect(200));
        await writeFile(join(root, created.storageKey), 'tampered-content');

        await download(link.url).expect(410);
      });

      it('stops honoring links after the signing secret is rotated', async () => {
        process.env.PRIVACY_EXPORT_DOWNLOAD_SECRET = 'first-secret-'.padEnd(
          40,
          'x',
        );
        const created = await completedExport();
        const link = linkOf(await requestLink(created.id).expect(200));
        await download(link.url).expect(200);

        process.env.PRIVACY_EXPORT_DOWNLOAD_SECRET = 'second-secret-'.padEnd(
          40,
          'y',
        );

        await download(link.url).expect(403);
      });
    });

    it('never writes the link signature to the logs', async () => {
      const created = await completedExport();
      const link = linkOf(await requestLink(created.id).expect(200));
      const signature = new URLSearchParams(link.url.split('?')[1]).get(
        'signature',
      )!;

      await download(link.url).expect(200);
      await download(link.url, OTHER).expect(403);
      jest.setSystemTime(T0.getTime() + FIFTEEN_MINUTES);
      await download(link.url).expect(410);

      const logged = JSON.stringify([
        interceptorLogger.info.mock.calls,
        interceptorLogger.warn.mock.calls,
        interceptorLogger.error.mock.calls,
        filterLogger.info.mock.calls,
        filterLogger.warn.mock.calls,
        filterLogger.error.mock.calls,
      ]);
      expect(logged).toContain(`/v1/privacy/exports/${created.id}/archive`);
      expect(logged).not.toContain(signature);
      expect(logged).toContain('signature=%5BREDACTED%5D');
    });
  });

  describe('private storage', () => {
    it('keeps archives owner-only on disk (0700 directories, 0600 files) and never as .partial once published', async () => {
      if (process.platform === 'win32') return; // POSIX permissions only
      const created = await completedExport();
      const file = join(root, created.storageKey);

      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(file))).mode & 0o777).toBe(0o700);
      expect((await stat(dirname(dirname(file)))).mode & 0o777).toBe(0o700);
      expect(await readdir(dirname(file))).toEqual([
        created.storageKey.split('/').pop(),
      ]);
    });
  });

  describe('redactUrl', () => {
    it.each([
      ['/a?expires=1&signature=abc', '/a?expires=1&signature=%5BREDACTED%5D'],
      [
        '/a?token=x&access_token=y',
        '/a?token=%5BREDACTED%5D&access_token=%5BREDACTED%5D',
      ],
      ['/a?Signature=abc', '/a?Signature=%5BREDACTED%5D'],
      ['/a?scope=all', '/a?scope=all'],
      ['/a', '/a'],
    ])('redacts %s', (url, expected) => {
      expect(redactUrl(url)).toBe(expected);
    });
  });
});
