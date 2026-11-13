import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { mock, mockDeep } from 'jest-mock-extended';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'winston';
import { PrismaService } from '../common/services/prisma.service';
import { PrivateImageLifecycleService } from './private-image-lifecycle.service';
import { PrivateImageStorageService } from './private-image-storage.service';
import { StorageModule } from './storage.module';

const SERVICE_KEY = 'sb_secret_loopback-test-key';
const BUCKET = 'musecue-private-images';
const AUTH_ID = '5f0c8a3e-2b4d-4c6e-8f10-123456789abc';
const SESSION_ID = '9a8b7c6d-5e4f-4a3b-8c2d-0123456789ab';

interface SeenRequest {
  method: string;
  path: string;
  apikey?: string;
  authorization?: string;
  contentType?: string;
  upsert?: string;
}

/** Minimal in-memory emulation of the Supabase Storage REST API. */
class FakeSupabaseStorage {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();
  readonly requests: SeenRequest[] = [];
  bucketIsPublic = false;
  /** Simulated server clock, so expiry can be tested without waiting. */
  clockOffsetMs = 0;
  baseUrl = '';
  private readonly tokens = new Map<string, { key: string; exp: number }>();

  private nowSeconds(): number {
    return Math.floor((Date.now() + this.clockOffsetMs) / 1000);
  }
  private server?: Server;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(({ status, body, contentType }) => {
        res.writeHead(status, { 'content-type': contentType });
        res.end(body);
      });
    });
    await new Promise<void>((resolve) =>
      this.server?.listen(0, '127.0.0.1', resolve),
    );
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
    return this.baseUrl;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(req: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const path = decodeURIComponent(
      new URL(req.url ?? '/', 'http://x').pathname,
    );
    this.requests.push({
      method: req.method ?? '',
      path,
      apikey: req.headers.apikey as string | undefined,
      authorization: req.headers.authorization,
      contentType: req.headers['content-type'],
      upsert: req.headers['x-upsert'] as string | undefined,
    });

    const json = (status: number, value: unknown) => ({
      status,
      body: JSON.stringify(value),
      contentType: 'application/json',
    });

    // Signed downloads authenticate with the URL token only.
    const signPrefix = `/storage/v1/object/sign/${BUCKET}/`;
    if (req.method === 'GET' && path.startsWith(signPrefix)) {
      const token = new URL(req.url ?? '/', 'http://x').searchParams.get(
        'token',
      );
      const grant = token ? this.tokens.get(token) : undefined;
      const key = path.slice(signPrefix.length);
      if (!grant || grant.key !== key) {
        return json(400, {
          statusCode: '400',
          error: 'InvalidSignature',
          message: 'invalid signature',
        });
      }
      if (this.nowSeconds() >= grant.exp) {
        return json(400, {
          statusCode: '400',
          error: 'InvalidJWT',
          message: 'jwt expired',
        });
      }
      const object = this.objects.get(key);
      return object
        ? { status: 200, body: object.bytes, contentType: object.contentType }
        : json(400, {
            statusCode: '404',
            error: 'not_found',
            message: 'Object not found',
          });
    }

    if (
      req.headers.apikey !== SERVICE_KEY ||
      req.headers.authorization !== `Bearer ${SERVICE_KEY}`
    ) {
      return json(400, {
        statusCode: '403',
        error: 'Unauthorized',
        message: 'invalid signature',
      });
    }

    const bucketPrefix = `/storage/v1/bucket/${BUCKET}`;
    const objectPrefix = `/storage/v1/object/${BUCKET}`;
    if (req.method === 'GET' && path === bucketPrefix) {
      return json(200, {
        id: BUCKET,
        name: BUCKET,
        public: this.bucketIsPublic,
      });
    }
    if (req.method === 'POST' && path.startsWith(signPrefix)) {
      const key = path.slice(signPrefix.length);
      if (!this.objects.has(key)) {
        return json(400, {
          statusCode: '404',
          error: 'not_found',
          message: 'Object not found',
        });
      }
      const { expiresIn } = JSON.parse(body.toString()) as {
        expiresIn: number;
      };
      const iat = this.nowSeconds();
      const token = [
        Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
        Buffer.from(
          JSON.stringify({
            url: `${BUCKET}/${key}`,
            iat,
            exp: iat + expiresIn,
            jti: randomUUID(),
          }),
        ).toString('base64url'),
        'loopback-signature',
      ].join('.');
      this.tokens.set(token, { key, exp: iat + expiresIn });
      return json(200, {
        signedURL: `/object/sign/${BUCKET}/${key}?token=${token}`,
      });
    }
    const infoPrefix = `/storage/v1/object/info/${BUCKET}/`;
    if (req.method === 'GET' && path.startsWith(infoPrefix)) {
      const key = path.slice(infoPrefix.length);
      return this.objects.has(key)
        ? json(200, { name: key })
        : json(400, {
            statusCode: '404',
            error: 'not_found',
            message: 'Object not found',
          });
    }
    if (req.method === 'DELETE' && path === objectPrefix) {
      const { prefixes } = JSON.parse(body.toString()) as {
        prefixes: string[];
      };
      const removed = prefixes.filter((key) => this.objects.delete(key));
      return json(
        200,
        removed.map((name) => ({ name })),
      );
    }
    if (path.startsWith(`${objectPrefix}/`)) {
      const key = path.slice(objectPrefix.length + 1);
      if (req.method === 'POST') {
        if (this.objects.has(key)) {
          return json(400, {
            statusCode: '409',
            error: 'Duplicate',
            message: 'The resource already exists',
          });
        }
        this.objects.set(key, {
          bytes: body,
          contentType: req.headers['content-type'] ?? '',
        });
        return json(200, { Key: `${BUCKET}/${key}`, Id: 'id' });
      }
      if (req.method === 'GET') {
        const object = this.objects.get(key);
        if (!object) {
          return json(400, {
            statusCode: '404',
            error: 'not_found',
            message: 'Object not found',
          });
        }
        return {
          status: 200,
          body: object.bytes,
          contentType: object.contentType,
        };
      }
    }
    return json(400, {
      statusCode: '400',
      error: 'unexpected',
      message: 'unexpected',
    });
  }
}

async function compileStorage(env: Record<string, string | undefined>) {
  @Global()
  @Module({
    providers: [
      { provide: ConfigService, useValue: { get: (key: string) => env[key] } },
      { provide: WINSTON_MODULE_PROVIDER, useValue: mock<Logger>() },
      { provide: PrismaService, useValue: mockDeep<PrismaService>() },
    ],
    exports: [ConfigService, WINSTON_MODULE_PROVIDER, PrismaService],
  })
  class TestInfrastructureModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [TestInfrastructureModule, StorageModule],
  }).compile();
  expect(moduleRef.get(PrivateImageLifecycleService)).toBeDefined();
  return moduleRef.get(PrivateImageStorageService);
}

async function save(
  storage: PrivateImageStorageService,
  mimeType: 'image/jpeg' | 'image/webp',
  bytes: Buffer,
) {
  const ref = storage.createRef(AUTH_ID, SESSION_ID, mimeType);
  await storage.put(ref, bytes, mimeType);
  return ref;
}

describe('StorageModule wiring (private cloud storage)', () => {
  const fake = new FakeSupabaseStorage();
  let supabaseUrl: string;
  let localRoot: string;

  beforeAll(async () => {
    supabaseUrl = await fake.start();
  });
  afterAll(() => fake.stop());

  beforeEach(async () => {
    fake.objects.clear();
    fake.requests.length = 0;
    fake.bucketIsPublic = false;
    fake.clockOffsetMs = 0;
    localRoot = await mkdtemp(join(tmpdir(), 'musecue-module-'));
  });
  afterEach(() => rm(localRoot, { recursive: true, force: true }));

  const supabaseEnv = () => ({
    PRIVATE_STORAGE_PROVIDER: 'supabase',
    SUPABASE_URL: supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    SUPABASE_STORAGE_BUCKET: BUCKET,
    PRIVATE_UPLOAD_DIR: localRoot,
  });

  it('stores, reads and deletes images in the private Supabase bucket over HTTP', async () => {
    const storage = await compileStorage(supabaseEnv());
    const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 255, 1, 2, 3]);

    const ref = await save(storage, 'image/webp', bytes);

    expect(ref.provider).toBe('supabase');
    expect(fake.objects.get(ref.key)).toEqual({
      bytes,
      contentType: 'image/webp',
    });
    await expect(storage.read(ref)).resolves.toEqual(bytes);
    await storage.delete(ref);
    expect(fake.objects.size).toBe(0);
    await expect(storage.delete(ref)).resolves.toBeUndefined();
    await expect(storage.read(ref)).rejects.toMatchObject({
      code: 'OBJECT_NOT_FOUND',
    });

    const upload = fake.requests.find((request) => request.method === 'POST');
    expect(upload).toMatchObject({
      path: `/storage/v1/object/${BUCKET}/${ref.key}`,
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      upsert: 'false',
    });
  });

  it('keeps reading legacy filesystem images while new uploads go to Supabase', async () => {
    const legacy = await save(
      await compileStorage({
        PRIVATE_STORAGE_PROVIDER: 'local',
        PRIVATE_UPLOAD_DIR: localRoot,
      }),
      'image/jpeg',
      Buffer.from('legacy-jpeg'),
    );

    const storage = await compileStorage(supabaseEnv());
    const fresh = await save(storage, 'image/jpeg', Buffer.from('new-jpeg'));

    expect(legacy.provider).toBe('local');
    expect(fresh.provider).toBe('supabase');
    await expect(storage.read(legacy)).resolves.toEqual(
      Buffer.from('legacy-jpeg'),
    );
    await expect(storage.read(fresh)).resolves.toEqual(Buffer.from('new-jpeg'));

    // With Supabase active, the filesystem can never receive new images.
    await expect(
      storage.put(
        {
          provider: 'local',
          key: `${AUTH_ID}/${SESSION_ID}/1b7c9a52-8d2f-4d57-9a8c-0d8c1f0a1b2c.jpg`,
        },
        Buffer.from('x'),
        'image/jpeg',
      ),
    ).rejects.toMatchObject({
      code: 'STORAGE_MISCONFIGURED',
      provider: 'local',
    });
  });

  it('issues a 60 s signed URL that downloads the object, expires, and can be re-issued', async () => {
    const storage = await compileStorage(supabaseEnv());
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7]);
    const ref = await save(storage, 'image/jpeg', bytes);

    const first = await storage.createSignedUrl(ref, 60);

    expect(
      first.url.startsWith(`${fake.baseUrl}/storage/v1/object/sign/`),
    ).toBe(true);
    expect(first.url).not.toContain(SERVICE_KEY);
    const download = await fetch(first.url);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);

    fake.clockOffsetMs = 61_000;
    expect((await fetch(first.url)).status).toBe(400);

    const second = await storage.createSignedUrl(ref, 60);
    expect(second.url).not.toBe(first.url);
    expect((await fetch(second.url)).status).toBe(200);
  });

  it('cannot sign images that live on the local filesystem', async () => {
    const storage = await compileStorage(supabaseEnv());
    const legacy = {
      provider: 'local',
      key: `${AUTH_ID}/${SESSION_ID}/0b7c9a52-8d2f-4d57-9a8c-0d8c1f0a1b2c.jpg`,
    };

    await expect(storage.createSignedUrl(legacy, 60)).rejects.toMatchObject({
      code: 'SIGNED_URL_UNSUPPORTED',
    });
  });

  it('refuses uploads when the bucket is public', async () => {
    fake.bucketIsPublic = true;
    const storage = await compileStorage(supabaseEnv());

    await expect(
      save(storage, 'image/jpeg', Buffer.from('x')),
    ).rejects.toMatchObject({
      code: 'STORAGE_MISCONFIGURED',
      retryable: false,
    });
    expect(fake.objects.size).toBe(0);
  });

  it('surfaces rejected credentials as access denied', async () => {
    const storage = await compileStorage({
      ...supabaseEnv(),
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_wrong-key',
    });

    await expect(
      save(storage, 'image/jpeg', Buffer.from('x')),
    ).rejects.toMatchObject({ code: 'STORAGE_ACCESS_DENIED' });
  });

  it('fails application startup when the configured provider is not registered', async () => {
    await expect(
      compileStorage({
        PRIVATE_STORAGE_PROVIDER: 's3',
        PRIVATE_UPLOAD_DIR: localRoot,
      }),
    ).rejects.toThrow('Private storage provider "s3" is not registered');
  });

  it('fails application startup when Supabase is active but not configured', async () => {
    await expect(
      compileStorage({ PRIVATE_STORAGE_PROVIDER: 'supabase' }),
    ).rejects.toThrow('Supabase private storage requires');
  });
});
