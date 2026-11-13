import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mock, mockDeep } from 'jest-mock-extended';
import * as jwt from 'jsonwebtoken';
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
import { ImageValidationService } from '../makeup/services/image-validation.service';
import { PrivateImageLifecycleService } from '../storage/private-image-lifecycle.service';
import { PrivateImageStorageService } from '../storage/private-image-storage.service';
import type { SupabaseStorageConfig } from '../storage/private-storage.config';
import { LocalFilesystemStorageProvider } from '../storage/providers/local-filesystem-storage.provider';
import { SupabaseStorageProvider } from '../storage/providers/supabase-storage.provider';
import { ProfileController } from './profile.controller';
import { EXTERNAL_AVATAR_MESSAGE, ProfileService } from './profile.service';

interface ApiBody {
  success?: boolean;
  statusCode: number;
  message: string;
  data: { url: string; expiresAt: string; expiresInSeconds: number };
}
const bodyOf = (response: { body: unknown }) => response.body as ApiBody;

const NOW = new Date('2026-11-12T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const SERVICE_KEY = 'sb_secret_avatar-spec-fake-key';
const SUPABASE: SupabaseStorageConfig = {
  storageUrl: 'https://project-ref.supabase.co/storage/v1',
  serviceKey: SERVICE_KEY,
  bucket: 'musecue-private-images',
  timeoutMs: 200,
};
const GOOGLE = 'https://lh3.googleusercontent.com/a/google-photo';
const keyOf = (user: string) =>
  `${user}/profile/0b7c9a52-8d2f-4d57-9a8c-0d8c1f0a1b2c.webp`;
const signPath = (key: string) =>
  `${SUPABASE.storageUrl}/object/sign/${SUPABASE.bucket}/${key}`;

interface Avatar {
  avatarUrl: string | null;
  avatarStorageProvider: string | null;
}

/** Profiles as stored: private uploads, an external avatar, none, legacy. */
const PROFILES: Record<string, Avatar> = {
  alice: { avatarUrl: keyOf('alice'), avatarStorageProvider: 'supabase' },
  bob: { avatarUrl: keyOf('bob'), avatarStorageProvider: 'supabase' },
  google: { avatarUrl: GOOGLE, avatarStorageProvider: null },
  empty: { avatarUrl: null, avatarStorageProvider: null },
  legacy: { avatarUrl: keyOf('legacy'), avatarStorageProvider: 'local' },
  // Corrupted row: points into another user's folder.
  tampered: { avatarUrl: keyOf('alice'), avatarStorageProvider: 'supabase' },
};

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );

const tokenFor = (key: string, iat: number, exp: number) =>
  [
    Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
    Buffer.from(
      JSON.stringify({ url: `${SUPABASE.bucket}/${key}`, iat, exp }),
    ).toString('base64url'),
    'mock-signature',
  ].join('.');

type Responder = (url: string, init?: RequestInit) => Promise<Response>;

describe('GET /v1/profile/avatar/signed-url (HTTP, mocked Supabase)', () => {
  const prisma = mockDeep<PrismaService>();
  const redis = mock<RedisService>();
  const logger = mock<Logger>();
  const tokens = new AuthUtilsService(mock<RedisService>());
  const supabaseRequests: Array<{ url: string; init?: RequestInit }> = [];
  let respond: Responder;
  let app: INestApplication<App>;
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

  /** Mocked Supabase: signs exactly the requested lifetime for any key. */
  const healthySupabase: Responder = (url, init) => {
    const signPrefix = `${SUPABASE.storageUrl}/object/sign/${SUPABASE.bucket}/`;
    if (url.startsWith(signPrefix) && init?.method === 'POST') {
      const key = url.slice(signPrefix.length);
      const { expiresIn } = JSON.parse(init.body as string) as {
        expiresIn: number;
      };
      const iat = Math.floor(Date.now() / 1000);
      return json({
        signedURL: `/object/sign/${SUPABASE.bucket}/${key}?token=${tokenFor(key, iat, iat + expiresIn)}`,
      });
    }
    if (url.includes(`/object/${SUPABASE.bucket}/`)) {
      return Promise.resolve(
        new Response(Buffer.from('avatar-bytes'), { status: 200 }),
      );
    }
    return json({ statusCode: '400', error: 'unexpected' }, 400);
  };

  const bearer = (userId: string) =>
    `Bearer ${tokens.createAccessToken({ userId, role: UserRole.USER, tokenVersion: 1 })}`;
  const get = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).get(`/v1/profile${path}`);
    return userId ? req.set('Authorization', bearer(userId)) : req;
  };
  const getSignedUrl = (userId?: string) => get('/avatar/signed-url', userId);
  const signRequests = () =>
    supabaseRequests.filter((r) => r.url.includes('/object/sign/'));

  beforeAll(async () => {
    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'avatar-signed-url-spec-secret';
    const storage = new PrivateImageStorageService(
      [
        new SupabaseStorageProvider(SUPABASE, supabaseFetch),
        new LocalFilesystemStorageProvider('/nonexistent', { writable: false }),
      ],
      { activeProvider: 'supabase', localRoot: '/nonexistent' },
      logger,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [ProfileController],
      providers: [
        ProfileService,
        AuthGuard,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: PrivateImageStorageService, useValue: storage },
        {
          provide: PrivateImageLifecycleService,
          useValue: mock<PrivateImageLifecycleService>(),
        },
        {
          provide: ImageValidationService,
          useValue: mock<ImageValidationService>(),
        },
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
    freezeTime(NOW);
    supabaseRequests.length = 0;
    respond = healthySupabase;
    redis.get.mockResolvedValue(1 as never);
    prisma.userProfile.findUnique.mockImplementation(((args: {
      where: { authId: string };
    }) => Promise.resolve(PROFILES[args.where.authId] ?? null)) as never);
    prisma.authUser.findUnique.mockImplementation(((args: {
      where: { id: string };
    }) =>
      Promise.resolve({
        id: args.where.id,
        email: `${args.where.id}@example.com`,
        username: args.where.id,
        userProfile: PROFILES[args.where.id]
          ? { ...PROFILES[args.where.id], updatedAt: NOW }
          : null,
      })) as never);
  });

  afterEach(() => jest.useRealTimers());

  describe('authenticated access', () => {
    it('rejects requests without a token before any lookup or signing', async () => {
      await getSignedUrl().expect(401);

      expect(prisma.userProfile.findUnique.mock.calls).toHaveLength(0);
      expect(supabaseRequests).toHaveLength(0);
    });

    it.each([
      [
        'a token signed with another secret',
        () =>
          jwt.sign({ userId: 'alice', role: 'USER', tokenVersion: 1 }, 'wrong'),
      ],
      [
        'an expired token',
        () =>
          jwt.sign(
            {
              userId: 'alice',
              role: 'USER',
              tokenVersion: 1,
              exp: NOW_SECONDS - 10,
            },
            'avatar-signed-url-spec-secret',
          ),
      ],
    ])('rejects %s', async (_label, makeToken) => {
      await getSignedUrl()
        .set('Authorization', `Bearer ${makeToken()}`)
        .expect(401);
      expect(supabaseRequests).toHaveLength(0);
    });

    it('rejects a revoked token (token version changed)', async () => {
      redis.get.mockResolvedValue(2 as never);

      await getSignedUrl('alice').expect(401);
      expect(supabaseRequests).toHaveLength(0);
    });
  });

  describe('ownership', () => {
    it("signs only the caller's own avatar, derived from the access token", async () => {
      const alice = await getSignedUrl('alice').expect(200);
      const bob = await getSignedUrl('bob').expect(200);

      expect(new URL(bodyOf(alice).data.url).pathname).toBe(
        `/storage/v1/object/sign/${SUPABASE.bucket}/${keyOf('alice')}`,
      );
      expect(new URL(bodyOf(bob).data.url).pathname).toBe(
        `/storage/v1/object/sign/${SUPABASE.bucket}/${keyOf('bob')}`,
      );
      expect(
        prisma.userProfile.findUnique.mock.calls.map(([a]) => a.where),
      ).toEqual([{ authId: 'alice' }, { authId: 'bob' }]);
    });

    it('ignores attempts to select another user through the query string', async () => {
      const response = await get(
        '/avatar/signed-url?authId=bob&userId=bob&key=bob/profile/x.webp',
        'alice',
      ).expect(200);

      expect(bodyOf(response).data.url).toContain(keyOf('alice'));
      expect(bodyOf(response).data.url).not.toContain('bob');
      expect(signRequests().map((r) => r.url)).toEqual([
        signPath(keyOf('alice')),
      ]);
    });

    it("refuses a profile row that points into another user's folder", async () => {
      const response = await getSignedUrl('tampered').expect(404);

      expect(bodyOf(response).message).toBe('Avatar image is unavailable');
      expect(supabaseRequests).toHaveLength(0);
      await get('/avatar/content', 'tampered').expect(404);
      expect(supabaseRequests).toHaveLength(0);
    });

    it('answers 404 for a user without an avatar', async () => {
      const response = await getSignedUrl('empty').expect(404);

      expect(bodyOf(response).message).toBe('Avatar image is unavailable');
      expect(supabaseRequests).toHaveLength(0);
    });
  });

  describe('expiration', () => {
    it('returns a URL valid for exactly 60 seconds with caching disabled', async () => {
      const response = await getSignedUrl('alice').expect(200);

      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(bodyOf(response)).toEqual({
        statusCode: 200,
        message: 'Success',
        data: {
          url: expect.stringContaining(
            `${signPath(keyOf('alice'))}?token=`,
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
    });

    it('issues a fresh URL on every request and persists nothing', async () => {
      const first = await getSignedUrl('alice').expect(200);
      freezeTime(new Date(NOW.getTime() + 61_000));
      const second = await getSignedUrl('alice').expect(200);

      expect(signRequests()).toHaveLength(2);
      expect(bodyOf(second).data.url).not.toBe(bodyOf(first).data.url);
      expect(bodyOf(second).data.expiresAt).toBe('2026-11-12T12:02:01.000Z');
      for (const write of [
        prisma.userProfile.update.mock,
        prisma.userProfile.upsert.mock,
        prisma.userProfile.create.mock,
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
            signedURL: `/object/sign/${SUPABASE.bucket}/${keyOf('alice')}?token=${tokenFor(keyOf('alice'), NOW_SECONDS, NOW_SECONDS + lifetime)}`,
          });

        const response = await getSignedUrl('alice').expect(500);

        expect(bodyOf(response).message).toBe('Image storage is unavailable');
        expect(JSON.stringify(bodyOf(response))).not.toContain('token');
      },
    );
  });

  describe('external avatars', () => {
    it('are never replaced by a signed URL and never reach storage', async () => {
      const signed = await getSignedUrl('google').expect(409);
      const profile = await get('', 'google').expect(200);

      expect(bodyOf(signed).message).toBe(EXTERNAL_AVATAR_MESSAGE);
      expect(
        (profile.body as { data: { avatarUrl: string } }).data.avatarUrl,
      ).toBe(GOOGLE);
      await get('/avatar/content', 'google').expect(404);
      expect(supabaseRequests).toHaveLength(0);
    });
  });

  describe('storage errors', () => {
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
        'Avatar image is unavailable',
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

        const response = await getSignedUrl('alice').expect(status);

        expect(bodyOf(response)).toMatchObject({
          success: false,
          statusCode: status,
          message,
        });
        const exposed = JSON.stringify(bodyOf(response));
        expect(exposed).not.toContain(SERVICE_KEY);
        expect(exposed).not.toContain('supabase.co');
        expect(exposed).not.toContain(keyOf('alice'));
      },
    );

    it('points legacy filesystem avatars to the content endpoint', async () => {
      const response = await getSignedUrl('legacy').expect(409);

      expect(bodyOf(response).message).toBe(
        'A signed URL is not available for this image. Use the image content endpoint instead.',
      );
      expect(supabaseRequests).toHaveLength(0);
    });
  });

  describe('security', () => {
    it('never exposes server credentials and never logs the signed URL', async () => {
      const response = await getSignedUrl('alice').expect(200);

      const body = JSON.stringify(bodyOf(response));
      expect(body).not.toContain(SERVICE_KEY);
      expect(body).not.toContain('apikey');
      const url = new URL(bodyOf(response).data.url);
      expect(url.protocol).toBe('https:');
      expect([...url.searchParams.keys()]).toEqual(['token']);
      const logged = JSON.stringify([
        ...logger.info.mock.calls,
        ...logger.warn.mock.calls,
        ...logger.error.mock.calls,
      ]);
      expect(logged).not.toContain(url.searchParams.get('token') as string);
      expect(logged).not.toContain(SERVICE_KEY);
    });

    it('leaves the existing avatar content endpoint unchanged', async () => {
      const response = await get('/avatar/content', 'alice')
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(response.body).toEqual(Buffer.from('avatar-bytes'));
      expect(response.headers['content-type']).toBe('image/webp');
      expect(response.headers['cache-control']).toBe('private, no-cache');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(signRequests()).toHaveLength(0);
    });
  });
});
