import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mock, mockDeep } from 'jest-mock-extended';
import * as jwt from 'jsonwebtoken';
import sharp from 'sharp';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Logger } from 'winston';
import { FakeS3CompatibleStorage } from '../../test/support/fake-s3-compatible-storage';
import { UserRole } from '../auth/interfaces/auth.interface';
import { AuthUtilsService } from '../auth/services/auth-utils.service';
import config from '../common/config/app.config';
import { AllExceptionsFilter } from '../common/filters/all-exception.filter';
import { AuthGuard } from '../common/guards/auth.guard';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor';
import { PrismaService } from '../common/services/prisma.service';
import { RedisService } from '../common/services/redis.service';
import { PrivateImageLifecycleService } from '../storage/private-image-lifecycle.service';
import { PrivateImageStorageService } from '../storage/private-image-storage.service';
import type { SupabaseStorageConfig } from '../storage/private-storage.config';
import { SupabaseStorageProvider } from '../storage/providers/supabase-storage.provider';
import { AI_GATEWAY, type AiGateway } from './ai/ai.gateway';
import { MakeupController } from './makeup.controller';
import { MakeupService } from './makeup.service';
import { MakeupQueueService } from './queues/makeup.queue';
import { ImageValidationService } from './services/image-validation.service';

const SECRET = 'image-content-spec-secret';
const SERVICE_KEY = 'sb_secret_content-spec-fake-key';
const SUPABASE: SupabaseStorageConfig = {
  storageUrl: 'https://project-ref.supabase.co/storage/v1',
  serviceKey: SERVICE_KEY,
  bucket: 'musecue-private-images',
  timeoutMs: 200,
};
const OWNER = 'owner-user';
const key = (name: string) => `${OWNER}/session-1/${name}`;

interface StoredImage {
  id: string;
  ownerId: string;
  storageKey: string;
  storageProvider: string;
  mimeType: string;
  source: 'PRIVATE_UPLOAD' | 'MOCK_CAPTURE';
}

/** Strings that must never appear in a response: provider, bucket, keys, secrets. */
const PRIVATE_DETAILS = [
  'supabase',
  'fake-s3',
  SUPABASE.bucket,
  SERVICE_KEY,
  OWNER + '/session-1',
  'storage/v1',
];

type Responder = (url: string, init?: RequestInit) => Promise<Response>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );

describe('GET /v1/images/:imageId/content (HTTP, mocked providers)', () => {
  const prisma = mockDeep<PrismaService>();
  const redis = mock<RedisService>();
  const logger = mock<Logger>();
  const tokens = new AuthUtilsService(mock<RedisService>());
  const s3 = new FakeS3CompatibleStorage();
  const supabaseObjects = new Map<string, Buffer>();
  const supabaseRequests: string[] = [];
  let respond: Responder;
  let app: INestApplication<App>;
  let originalSecret: string;
  let images: StoredImage[];
  const bytes: Record<string, Buffer> = {};

  const supabaseFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    supabaseRequests.push(url);
    return respond(url, init);
  }) as typeof fetch;

  const healthySupabase: Responder = (url) => {
    const prefix = `${SUPABASE.storageUrl}/object/${SUPABASE.bucket}/`;
    const object = supabaseObjects.get(url.slice(prefix.length));
    return object
      ? Promise.resolve(new Response(new Uint8Array(object), { status: 200 }))
      : json(
          {
            statusCode: '404',
            error: 'not_found',
            message: 'Object not found',
          },
          400,
        );
  };

  const bearer = (userId: string) =>
    `Bearer ${tokens.createAccessToken({ userId, role: UserRole.USER, tokenVersion: 1 })}`;
  const getContent = (imageId: string, userId?: string) => {
    const req = request(app.getHttpServer())
      .get(`/v1/images/${imageId}/content`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    return userId ? req.set('Authorization', bearer(userId)) : req;
  };
  const jsonBody = (response: { body: unknown }) =>
    JSON.parse((response.body as Buffer).toString('utf8')) as {
      statusCode: number;
      message: string;
    };
  const expectNoPrivateDetails = (response: {
    body: unknown;
    headers: Record<string, unknown>;
  }) => {
    const exposed = `${JSON.stringify(response.headers)} ${
      Buffer.isBuffer(response.body) ? response.body.toString('latin1') : ''
    }`.toLowerCase();
    for (const detail of PRIVATE_DETAILS) {
      expect(exposed).not.toContain(detail.toLowerCase());
    }
  };

  beforeAll(async () => {
    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = SECRET;
    for (const format of ['jpeg', 'png', 'webp'] as const) {
      bytes[format] = await sharp({
        create: {
          width: 40,
          height: 30,
          channels: 3,
          background: { r: 200, g: 120, b: 90 },
        },
      })
        .toFormat(format)
        .toBuffer();
    }
    const storage = new PrivateImageStorageService(
      [new SupabaseStorageProvider(SUPABASE, supabaseFetch), s3],
      { activeProvider: 'supabase', localRoot: '/unused' },
      logger,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [MakeupController],
      providers: [
        MakeupService,
        AuthGuard,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: PrivateImageStorageService, useValue: storage },
        {
          provide: PrivateImageLifecycleService,
          useValue: mock<PrivateImageLifecycleService>(),
        },
        { provide: MakeupQueueService, useValue: mock<MakeupQueueService>() },
        {
          provide: ImageValidationService,
          useValue: mock<ImageValidationService>(),
        },
        { provide: AI_GATEWAY, useValue: mock<AiGateway>() },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter(logger));
    app.useGlobalInterceptors(new TransformInterceptor(logger));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    config.jwt_access_secret = originalSecret;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    s3.reset();
    supabaseObjects.clear();
    supabaseRequests.length = 0;
    respond = healthySupabase;
    redis.get.mockResolvedValue(1 as never);
    images = [
      ['jpeg-image', 'a.jpg', 'image/jpeg', 'supabase'],
      ['png-image', 'b.png', 'image/png', 'supabase'],
      ['webp-image', 'c.webp', 'image/webp', 'supabase'],
      ['s3-image', 'd.jpg', 'image/jpeg', 'fake-s3'],
    ].map(([id, name, mimeType, provider]) => ({
      id,
      ownerId: OWNER,
      storageKey: key(name),
      storageProvider: provider,
      mimeType,
      source: 'PRIVATE_UPLOAD' as const,
    }));
    images.push({
      id: 'mock-image',
      ownerId: OWNER,
      storageKey: 'mock',
      storageProvider: 'supabase',
      mimeType: 'image/jpeg',
      source: 'MOCK_CAPTURE',
    });
    supabaseObjects.set(key('a.jpg'), bytes.jpeg);
    supabaseObjects.set(key('b.png'), bytes.png);
    supabaseObjects.set(key('c.webp'), bytes.webp);
    s3.objects.set(key('d.jpg'), {
      bytes: bytes.jpeg,
      contentType: 'image/jpeg',
    });
    prisma.imageAsset.findFirst.mockImplementation(((args: {
      where: { id: string; session: { authId: string } };
    }) =>
      Promise.resolve(
        images.find(
          (image) =>
            image.id === args.where.id &&
            image.ownerId === args.where.session.authId,
        ) ?? null,
      )) as never);
  });

  describe('image content', () => {
    it.each([
      ['jpeg-image', 'jpeg', 'image/jpeg'],
      ['png-image', 'png', 'image/png'],
      ['webp-image', 'webp', 'image/webp'],
      ['s3-image', 'jpeg', 'image/jpeg'],
    ] as const)(
      'serves %s byte-for-byte with its stored content type',
      async (imageId, format, contentType) => {
        const response = await getContent(imageId, OWNER).expect(200);

        expect(response.body).toEqual(bytes[format]);
        expect(response.headers['content-type']).toBe(contentType);
        expect(response.headers['content-length']).toBe(
          String(bytes[format].length),
        );
      },
    );

    it('reads each image from the provider stored with it', async () => {
      await getContent('jpeg-image', OWNER).expect(200);
      await getContent('s3-image', OWNER).expect(200);

      expect(supabaseRequests).toEqual([
        `${SUPABASE.storageUrl}/object/${SUPABASE.bucket}/${key('a.jpg')}`,
      ]);
      expect(s3.calls).toEqual([{ op: 'get', key: key('d.jpg') }]);
    });
  });

  describe('response headers', () => {
    it('forbid every cache and expose nothing about storage', async () => {
      const response = await getContent('jpeg-image', OWNER).expect(200);

      expect(response.headers).toMatchObject({
        'cache-control': 'private, no-store, max-age=0',
        pragma: 'no-cache',
        expires: '0',
        vary: expect.stringContaining('Authorization') as string,
        'x-content-type-options': 'nosniff',
        'content-disposition': 'inline',
      });
      expect(response.headers.etag).toBeUndefined();
      expect(response.headers['set-cookie']).toBeUndefined();
      expectNoPrivateDetails(response);
    });

    it.each([
      ['a missing image (404)', 'no-such-image', 404],
      ['a storage outage (503)', 'jpeg-image', 503],
    ])(
      'are also set on error responses for %s',
      async (_label, imageId, status) => {
        respond = () => json({ statusCode: '503', error: 'down' }, 503);

        const response = await getContent(imageId, OWNER).expect(status);

        expect(response.headers['cache-control']).toBe(
          'private, no-store, max-age=0',
        );
        expect(response.headers.pragma).toBe('no-cache');
      },
    );

    it('answers HEAD with the same headers and no body', async () => {
      const response = await request(app.getHttpServer())
        .head('/v1/images/png-image/content')
        .set('Authorization', bearer(OWNER))
        .expect(200);

      expect(response.headers['content-type']).toBe('image/png');
      expect(response.headers['content-length']).toBe(String(bytes.png.length));
      expect(response.headers['cache-control']).toBe(
        'private, no-store, max-age=0',
      );
      expect(response.text ?? '').toBe('');
    });
  });

  describe('authentication from the mobile app', () => {
    it('accepts the bearer access token the app sends with image requests', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/images/jpeg-image/content')
        .set('authorization', bearer(OWNER))
        .set('User-Agent', 'okhttp/4.12.0')
        .set('Accept', 'image/webp,image/*,*/*;q=0.8')
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(response.body).toEqual(bytes.jpeg);
    });

    it.each([
      ['no token', () => getContent('jpeg-image')],
      [
        'a token in the query string (never accepted)',
        () =>
          request(app.getHttpServer()).get(
            `/v1/images/jpeg-image/content?access_token=${bearer(OWNER).slice(7)}&token=${bearer(OWNER).slice(7)}`,
          ),
      ],
      [
        'a token signed with another secret',
        () =>
          getContent('jpeg-image').set(
            'Authorization',
            `Bearer ${jwt.sign({ userId: OWNER, role: 'USER', tokenVersion: 1 }, 'wrong')}`,
          ),
      ],
    ])(
      'rejects %s with 401 before any storage access',
      async (_label, send) => {
        await send().expect(401);

        expect(prisma.imageAsset.findFirst.mock.calls).toHaveLength(0);
        expect(supabaseRequests).toHaveLength(0);
      },
    );

    it('answers an expired token with a JSON 401 the app can use to refresh', async () => {
      const expired = jwt.sign(
        {
          userId: OWNER,
          role: 'USER',
          tokenVersion: 1,
          exp: Math.floor(Date.now() / 1000) - 5,
        },
        SECRET,
      );

      const response = await getContent('jpeg-image')
        .set('Authorization', `Bearer ${expired}`)
        .expect(401);

      expect(response.headers['content-type']).toContain('application/json');
      expect(jsonBody(response)).toMatchObject({
        statusCode: 401,
        message: 'Token has expired',
      });
      expect(supabaseRequests).toHaveLength(0);
    });

    it('rejects a revoked token (signed out everywhere)', async () => {
      redis.get.mockResolvedValue(2 as never);

      await getContent('jpeg-image', OWNER).expect(401);
      expect(supabaseRequests).toHaveLength(0);
    });
  });

  describe('ownership', () => {
    it("answers another user's image exactly like a missing one, without reading storage", async () => {
      const foreign = await getContent('jpeg-image', 'intruder').expect(404);
      const missing = await getContent('no-such-image', OWNER).expect(404);

      expect(jsonBody(foreign).message).toBe('Image not found');
      expect(jsonBody(missing).message).toBe(jsonBody(foreign).message);
      expect(prisma.imageAsset.findFirst.mock.calls[0]?.[0]).toMatchObject({
        where: { id: 'jpeg-image', session: { authId: 'intruder' } },
      });
      expect(supabaseRequests).toHaveLength(0);
      expect(s3.calls).toHaveLength(0);
    });

    it('does not serve images that were never uploaded privately', async () => {
      const response = await getContent('mock-image', OWNER).expect(404);

      expect(jsonBody(response).message).toBe('Image content is unavailable');
      expect(supabaseRequests).toHaveLength(0);
    });
  });

  describe('provider failures', () => {
    it.each([
      [
        'a missing object',
        () =>
          json(
            {
              statusCode: '404',
              error: 'not_found',
              message: 'Object not found',
            },
            400,
          ),
        404,
        'Image content is unavailable',
      ],
      [
        'a provider outage',
        () => json({ statusCode: '503', error: 'down', message: 'down' }, 503),
        503,
        'Image storage is temporarily unavailable. Please try again.',
      ],
      [
        'rate limiting',
        () => json({ statusCode: '429', error: 'slow', message: 'slow' }, 429),
        503,
        'Image storage is temporarily unavailable. Please try again.',
      ],
      [
        'a timeout',
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(init.signal?.reason as Error),
            );
          }),
        503,
        'Image storage is temporarily unavailable. Please try again.',
      ],
      [
        'a network failure',
        () => Promise.reject(new TypeError('fetch failed: supabase.co')),
        503,
        'Image storage is temporarily unavailable. Please try again.',
      ],
      [
        'rejected server credentials',
        () =>
          json(
            {
              statusCode: '403',
              error: 'Unauthorized',
              message: `bad ${SERVICE_KEY}`,
            },
            400,
          ),
        500,
        'Image storage is unavailable',
      ],
      [
        'a provider error page instead of the image',
        () =>
          Promise.resolve(
            new Response('<html><body>supabase gateway error</body></html>', {
              status: 200,
              headers: { 'content-type': 'text/html' },
            }),
          ),
        500,
        'Image storage is unavailable',
      ],
      [
        'an object of another type than recorded',
        () =>
          Promise.resolve(
            new Response(new Uint8Array(bytes.png), { status: 200 }),
          ),
        500,
        'Image storage is unavailable',
      ],
    ] as const)(
      'handles %s gracefully without revealing the provider',
      async (_label, responder, status, message) => {
        respond = responder;

        const response = await getContent('jpeg-image', OWNER).expect(status);

        expect(response.headers['content-type']).toContain('application/json');
        expect(jsonBody(response)).toMatchObject({
          statusCode: status,
          message,
        });
        expectNoPrivateDetails(response);
      },
    );

    it('handles a second provider failing the same way', async () => {
      s3.failNext('get', 'STORAGE_TIMEOUT');

      const response = await getContent('s3-image', OWNER).expect(503);

      expect(jsonBody(response).message).toBe(
        'Image storage is temporarily unavailable. Please try again.',
      );
      expectNoPrivateDetails(response);
    });

    it('handles an image whose provider is no longer configured', async () => {
      images[0].storageProvider = 'retired-provider';

      const response = await getContent('jpeg-image', OWNER).expect(500);

      expect(jsonBody(response).message).toBe('Image storage is unavailable');
      expect(JSON.stringify(jsonBody(response))).not.toContain('retired');
    });
  });
});
