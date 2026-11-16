import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mock, mockDeep } from 'jest-mock-extended';
import * as jwt from 'jsonwebtoken';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Logger } from 'winston';
import { freezeTime } from '../../test/support/freeze-time';
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
import { LocalFilesystemStorageProvider } from '../storage/providers/local-filesystem-storage.provider';
import { SupabaseStorageProvider } from '../storage/providers/supabase-storage.provider';
import { AI_GATEWAY, type AiGateway } from './ai/ai.gateway';
import { MakeupController } from './makeup.controller';
import { MakeupService } from './makeup.service';
import { MakeupQueueService } from './queues/makeup.queue';
import { ImageValidationService } from './services/image-validation.service';

interface ApiResponseBody {
  success?: boolean;
  statusCode: number;
  message: string;
  data: { url: string; expiresAt: string; expiresInSeconds: number };
}
const bodyOf = (response: { body: unknown }) =>
  response.body as ApiResponseBody;

const NOW = new Date('2026-11-12T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const SERVICE_KEY = 'sb_secret_http-spec-service-key';
const SUPABASE: SupabaseStorageConfig = {
  storageUrl: 'https://project-ref.supabase.co/storage/v1',
  serviceKey: SERVICE_KEY,
  bucket: 'musecue-private-images',
  timeoutMs: 200,
};
const OWNER = 'owner-user';
/** JPEG signature + payload: what the stored object really contains. */
const PRIVATE_JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('private-jpeg-bytes'),
]);
const KEY = `${OWNER}/session-1/0b7c9a52-8d2f-4d57-9a8c-0d8c1f0a1b2c.jpg`;
const SIGN_ENDPOINT = `${SUPABASE.storageUrl}/object/sign/${SUPABASE.bucket}/${KEY}`;

interface StoredImage {
  id: string;
  ownerId: string;
  storageKey: string;
  storageProvider: string;
  mimeType: string;
  source: 'PRIVATE_UPLOAD' | 'MOCK_CAPTURE';
}

const IMAGES: StoredImage[] = [
  {
    id: 'owned-image',
    ownerId: OWNER,
    storageKey: KEY,
    storageProvider: 'supabase',
    mimeType: 'image/jpeg',
    source: 'PRIVATE_UPLOAD',
  },
  {
    id: 'legacy-image',
    ownerId: OWNER,
    storageKey: `${OWNER}/session-1/1b7c9a52-8d2f-4d57-9a8c-0d8c1f0a1b2c.jpg`,
    storageProvider: 'local',
    mimeType: 'image/jpeg',
    source: 'PRIVATE_UPLOAD',
  },
  {
    id: 'mock-image',
    ownerId: OWNER,
    storageKey: 'mock',
    storageProvider: 'supabase',
    mimeType: 'image/jpeg',
    source: 'MOCK_CAPTURE',
  },
];

/** Mocked Supabase Storage API answering the provider's real HTTP requests. */
type SupabaseResponder = (url: string, init?: RequestInit) => Promise<Response>;

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );

const tokenFor = (exp: number, nonce: number, iat = NOW_SECONDS) =>
  [
    Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
    Buffer.from(
      JSON.stringify({ url: `${SUPABASE.bucket}/${KEY}`, iat, exp, n: nonce }),
    ).toString('base64url'),
    'mock-signature',
  ].join('.');

describe('GET /v1/images/:imageId/signed-url (HTTP, mocked Supabase)', () => {
  const prisma = mockDeep<PrismaService>();
  const redis = mock<RedisService>();
  const lifecycle = mock<PrivateImageLifecycleService>();
  const logger = mock<Logger>();
  const tokens = new AuthUtilsService(mock<RedisService>());
  const supabaseRequests: Array<{ url: string; init?: RequestInit }> = [];
  let respond: SupabaseResponder;
  let signed = 0;
  let app: INestApplication<App>;
  let localRoot: string;
  let originalSecret: string;

  const supabaseFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    supabaseRequests.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;

  /** Default mocked Supabase: signs for exactly the requested lifetime. */
  const healthySupabase: SupabaseResponder = (url, init) => {
    if (url === SIGN_ENDPOINT && init?.method === 'POST') {
      const { expiresIn } = JSON.parse(init.body as string) as {
        expiresIn: number;
      };
      signed += 1;
      const iat = Math.floor(Date.now() / 1000);
      return json({
        signedURL: `/object/sign/${SUPABASE.bucket}/${KEY}?token=${tokenFor(iat + expiresIn, signed, iat)}`,
      });
    }
    if (url.endsWith(`/object/${SUPABASE.bucket}/${KEY}`)) {
      return Promise.resolve(new Response(PRIVATE_JPEG, { status: 200 }));
    }
    return json({ statusCode: '400', error: 'unexpected' }, 400);
  };

  const bearer = (userId: string) =>
    `Bearer ${tokens.createAccessToken({ userId, role: UserRole.USER, tokenVersion: 1 })}`;
  const getSignedUrl = (imageId: string, userId?: string) => {
    const req = request(app.getHttpServer()).get(
      `/v1/images/${imageId}/signed-url`,
    );
    return userId ? req.set('Authorization', bearer(userId)) : req;
  };
  const signRequests = () =>
    supabaseRequests.filter((r) => r.url === SIGN_ENDPOINT);

  beforeAll(async () => {
    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'signed-url-spec-secret';
    localRoot = await mkdtemp(join(tmpdir(), 'musecue-signed-url-'));
    const storage = new PrivateImageStorageService(
      [
        new SupabaseStorageProvider(SUPABASE, supabaseFetch, () => Date.now()),
        new LocalFilesystemStorageProvider(localRoot),
      ],
      { activeProvider: 'supabase', localRoot, supabase: SUPABASE },
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
        { provide: PrivateImageLifecycleService, useValue: lifecycle },
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
    await rm(localRoot, { recursive: true, force: true });
    config.jwt_access_secret = originalSecret;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    freezeTime(NOW);
    supabaseRequests.length = 0;
    signed = 0;
    respond = healthySupabase;
    redis.get.mockResolvedValue(1 as never);
    // Ownership is enforced in the query: only the owner's images match.
    prisma.imageAsset.findFirst.mockImplementation(((args: {
      where: { id: string; session: { authId: string } };
    }) =>
      Promise.resolve(
        IMAGES.find(
          (image) =>
            image.id === args.where.id &&
            image.ownerId === args.where.session.authId,
        ) ?? null,
      )) as never);
  });

  afterEach(() => jest.useRealTimers());

  describe('authorization', () => {
    it('rejects requests without a token before any lookup or signing', async () => {
      await getSignedUrl('owned-image').expect(401);

      expect(prisma.imageAsset.findFirst.mock.calls).toHaveLength(0);
      expect(supabaseRequests).toHaveLength(0);
    });

    it.each([
      [
        'a token signed with another secret',
        () =>
          jwt.sign(
            { userId: OWNER, role: 'USER', tokenVersion: 1 },
            'wrong-secret',
          ),
      ],
      [
        'an expired token',
        () =>
          jwt.sign(
            {
              userId: OWNER,
              role: 'USER',
              tokenVersion: 1,
              exp: NOW_SECONDS - 10,
            },
            'signed-url-spec-secret',
          ),
      ],
    ])('rejects %s', async (_label, makeToken) => {
      await getSignedUrl('owned-image')
        .set('Authorization', `Bearer ${makeToken()}`)
        .expect(401);
      expect(supabaseRequests).toHaveLength(0);
    });

    it('rejects a revoked token (token version changed)', async () => {
      redis.get.mockResolvedValue(2 as never);

      await getSignedUrl('owned-image', OWNER).expect(401);
      expect(supabaseRequests).toHaveLength(0);
    });

    it("answers another user's image exactly like a missing one, without signing", async () => {
      const foreign = await getSignedUrl('owned-image', 'intruder').expect(404);
      const missing = await getSignedUrl('no-such-image', OWNER).expect(404);

      expect(bodyOf(foreign).message).toBe('Image not found');
      expect(bodyOf(missing).message).toBe(bodyOf(foreign).message);
      expect(prisma.imageAsset.findFirst.mock.calls[0]?.[0]).toMatchObject({
        where: { id: 'owned-image', session: { authId: 'intruder' } },
      });
      expect(supabaseRequests).toHaveLength(0);
    });

    it('does not sign images that were never uploaded privately', async () => {
      const response = await getSignedUrl('mock-image', OWNER).expect(404);

      expect(bodyOf(response).message).toBe('Image content is unavailable');
      expect(supabaseRequests).toHaveLength(0);
    });
  });

  describe('expiration', () => {
    it('returns a URL valid for 60 seconds, signed for the stored provider and key', async () => {
      const response = await getSignedUrl('owned-image', OWNER).expect(200);

      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(bodyOf(response)).toEqual({
        statusCode: 200,
        message: 'Success',
        data: {
          url: expect.stringMatching(
            new RegExp(`^${SIGN_ENDPOINT.replace(/[.?]/g, '\\$&')}\\?token=`),
          ) as string,
          expiresAt: '2026-11-12T12:01:00.000Z',
          expiresInSeconds: 60,
        },
      });
      const [sign] = signRequests();
      expect(JSON.parse(sign.init?.body as string)).toEqual({ expiresIn: 60 });
      const token = new URL(bodyOf(response).data.url).searchParams.get(
        'token',
      ) as string;
      const claims = JSON.parse(
        Buffer.from(token.split('.')[1], 'base64url').toString(),
      ) as { iat: number; exp: number };
      expect(claims.exp - claims.iat).toBe(60);
      expect(claims.exp).toBe(NOW_SECONDS + 60);
    });

    it.each([
      ['signs 3 s after the request (slow provider)', 3],
      ['runs 10 minutes ahead of the API', 600],
      ['runs 10 minutes behind the API', -600],
    ])(
      "reports Supabase's own expiry when Supabase %s",
      async (_label, offsetSeconds) => {
        respond = (url, init) => {
          const { expiresIn } = JSON.parse(init?.body as string) as {
            expiresIn: number;
          };
          const iat = NOW_SECONDS + offsetSeconds;
          return json({
            signedURL: `/object/sign/${SUPABASE.bucket}/${KEY}?token=${tokenFor(iat + expiresIn, 1, iat)}`,
          });
        };

        const response = await getSignedUrl('owned-image', OWNER).expect(200);

        const { data } = bodyOf(response);
        const claims = JSON.parse(
          Buffer.from(
            (new URL(data.url).searchParams.get('token') as string).split(
              '.',
            )[1],
            'base64url',
          ).toString(),
        ) as { iat: number; exp: number };
        expect(data.expiresAt).toBe(new Date(claims.exp * 1000).toISOString());
        expect(data.expiresInSeconds).toBe(claims.exp - claims.iat);
        expect(data.expiresInSeconds).toBe(60);
        expect(Date.parse(data.expiresAt) - claims.iat * 1000).toBe(
          data.expiresInSeconds * 1000,
        );
        // Not the local-clock estimate (request time + 60 s).
        expect(data.expiresAt).not.toBe(
          new Date(NOW.getTime() + 60_000).toISOString(),
        );
      },
    );

    it('issues a fresh URL on every request and persists nothing', async () => {
      const first = await getSignedUrl('owned-image', OWNER).expect(200);
      freezeTime(new Date(NOW.getTime() + 61_000));
      const second = await getSignedUrl('owned-image', OWNER).expect(200);

      expect(signRequests()).toHaveLength(2);
      expect(bodyOf(second).data.url).not.toBe(bodyOf(first).data.url);
      expect(bodyOf(second).data.expiresAt).toBe('2026-11-12T12:02:01.000Z');
      for (const write of [
        prisma.imageAsset.create.mock,
        prisma.imageAsset.update.mock,
        prisma.imageAsset.updateMany.mock,
        prisma.imageAsset.upsert.mock,
        prisma.privateStorageCleanup.create.mock,
        prisma.$transaction.mock,
        prisma.$executeRaw.mock,
      ]) {
        expect(write.calls).toHaveLength(0);
      }
    });

    it.each([61, 90, 3600])(
      'refuses a provider URL valid for %i s (strict 60 s maximum)',
      async (lifetime) => {
        respond = () =>
          json({
            signedURL: `/object/sign/${SUPABASE.bucket}/${KEY}?token=${tokenFor(NOW_SECONDS + lifetime, 1)}`,
          });

        const response = await getSignedUrl('owned-image', OWNER).expect(500);

        expect(bodyOf(response).message).toBe('Image storage is unavailable');
        expect(JSON.stringify(bodyOf(response))).not.toContain('token');
      },
    );

    it('refuses a token without iat, whose lifetime cannot be verified', async () => {
      respond = () =>
        json({
          signedURL: `/object/sign/${SUPABASE.bucket}/${KEY}?token=${[
            Buffer.from('{"alg":"HS256"}').toString('base64url'),
            Buffer.from(JSON.stringify({ exp: NOW_SECONDS + 60 })).toString(
              'base64url',
            ),
            'sig',
          ].join('.')}`,
        });

      await getSignedUrl('owned-image', OWNER).expect(500);
    });

    it('refuses a provider URL that would stay valid longer than requested', async () => {
      respond = () =>
        json({
          signedURL: `/object/sign/${SUPABASE.bucket}/${KEY}?token=${tokenFor(NOW_SECONDS + 3600, 1)}`,
        });

      const response = await getSignedUrl('owned-image', OWNER).expect(500);

      expect(bodyOf(response).message).toBe('Image storage is unavailable');
      expect(JSON.stringify(bodyOf(response))).not.toContain('token');
    });
  });

  describe('provider error handling', () => {
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
        () =>
          json(
            { statusCode: '503', error: 'unavailable', message: 'down' },
            503,
          ),
        503,
        'Image storage is temporarily unavailable. Please try again.',
      ],
      [
        'rate limiting',
        () =>
          json(
            { statusCode: '429', error: 'slow down', message: 'slow down' },
            429,
          ),
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
              message: `invalid signature for ${SERVICE_KEY}`,
            },
            400,
          ),
        500,
        'Image storage is unavailable',
      ],
      [
        'a missing bucket',
        () =>
          json(
            {
              statusCode: '404',
              error: 'Bucket not found',
              message: 'Bucket not found',
            },
            400,
          ),
        500,
        'Image storage is unavailable',
      ],
      [
        'a network failure',
        () => Promise.reject(new TypeError('fetch failed')),
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
    ] as const)(
      'maps %s to the expected status with a safe message',
      async (_label, responder, status, message) => {
        respond = responder;

        const response = await getSignedUrl('owned-image', OWNER).expect(
          status,
        );

        expect(bodyOf(response)).toMatchObject({
          success: false,
          statusCode: status,
          message,
        });
        const exposed = JSON.stringify(bodyOf(response));
        expect(exposed).not.toContain(SERVICE_KEY);
        expect(exposed).not.toContain('supabase.co');
        expect(exposed).not.toContain(KEY);
      },
    );

    it('asks clients to use the content endpoint for images on the local filesystem', async () => {
      const response = await getSignedUrl('legacy-image', OWNER).expect(409);

      expect(bodyOf(response).message).toBe(
        'A signed URL is not available for this image. Use the image content endpoint instead.',
      );
      expect(supabaseRequests).toHaveLength(0);
    });
  });

  describe('security', () => {
    it('never exposes server credentials and never logs the signed URL', async () => {
      const response = await getSignedUrl('owned-image', OWNER).expect(200);

      const body = JSON.stringify(bodyOf(response));
      expect(body).not.toContain(SERVICE_KEY);
      expect(body).not.toContain('apikey');
      const url = new URL(bodyOf(response).data.url);
      expect(url.protocol).toBe('https:');
      expect([...url.searchParams.keys()]).toEqual(['token']);
      const [sign] = signRequests();
      expect(new Headers(sign.init?.headers).get('authorization')).toBe(
        `Bearer ${SERVICE_KEY}`,
      );

      const logged = JSON.stringify([
        ...logger.info.mock.calls,
        ...logger.warn.mock.calls,
        ...logger.error.mock.calls,
      ]);
      expect(logged).not.toContain(url.searchParams.get('token') as string);
      expect(logged).not.toContain(SERVICE_KEY);
    });

    it("never returns bucket-level or other users' access: the URL is scoped to this object", async () => {
      const response = await getSignedUrl('owned-image', OWNER).expect(200);

      expect(new URL(bodyOf(response).data.url).pathname).toBe(
        `/storage/v1/object/sign/${SUPABASE.bucket}/${KEY}`,
      );
    });
  });

  describe('existing content endpoint', () => {
    const getContent = (imageId: string, userId?: string) => {
      const req = request(app.getHttpServer()).get(
        `/v1/images/${imageId}/content`,
      );
      return userId ? req.set('Authorization', bearer(userId)) : req;
    };

    it('still streams owned image bytes with the same headers', async () => {
      const response = await getContent('owned-image', OWNER)
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(response.body).toEqual(PRIVATE_JPEG);
      expect(response.headers['content-type']).toBe('image/jpeg');
      expect(response.headers['cache-control']).toBe(
        'private, no-store, max-age=0',
      );
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(signRequests()).toHaveLength(0);
    });

    it('still rejects unauthenticated, foreign and missing images', async () => {
      await getContent('owned-image').expect(401);
      await getContent('owned-image', 'intruder').expect(404);
      await getContent('no-such-image', OWNER).expect(404);
    });

    it('still maps a missing stored object to 404', async () => {
      respond = () =>
        json(
          {
            statusCode: '404',
            error: 'not_found',
            message: 'Object not found',
          },
          400,
        );

      const response = await getContent('owned-image', OWNER).expect(404);
      expect(bodyOf(response).message).toBe('Image content is unavailable');
    });
  });
});
