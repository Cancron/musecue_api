import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { mock } from 'jest-mock-extended';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'winston';
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
    return `http://127.0.0.1:${port}`;
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
    ],
    exports: [ConfigService, WINSTON_MODULE_PROVIDER],
  })
  class TestInfrastructureModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [TestInfrastructureModule, StorageModule],
  }).compile();
  return moduleRef.get(PrivateImageStorageService);
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

    const ref = await storage.save(AUTH_ID, SESSION_ID, 'image/webp', bytes);

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
    const legacy = await (
      await compileStorage({
        PRIVATE_STORAGE_PROVIDER: 'local',
        PRIVATE_UPLOAD_DIR: localRoot,
      })
    ).save(AUTH_ID, SESSION_ID, 'image/jpeg', Buffer.from('legacy-jpeg'));

    const storage = await compileStorage(supabaseEnv());
    const fresh = await storage.save(
      AUTH_ID,
      SESSION_ID,
      'image/jpeg',
      Buffer.from('new-jpeg'),
    );

    expect(legacy.provider).toBe('local');
    expect(fresh.provider).toBe('supabase');
    await expect(storage.read(legacy)).resolves.toEqual(
      Buffer.from('legacy-jpeg'),
    );
    await expect(storage.read(fresh)).resolves.toEqual(Buffer.from('new-jpeg'));
  });

  it('refuses uploads when the bucket is public', async () => {
    fake.bucketIsPublic = true;
    const storage = await compileStorage(supabaseEnv());

    await expect(
      storage.save(AUTH_ID, SESSION_ID, 'image/jpeg', Buffer.from('x')),
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
      storage.save(AUTH_ID, SESSION_ID, 'image/jpeg', Buffer.from('x')),
    ).rejects.toMatchObject({ code: 'STORAGE_ACCESS_DENIED' });
  });

  it('fails application startup when Supabase is active but not configured', async () => {
    await expect(
      compileStorage({ PRIVATE_STORAGE_PROVIDER: 'supabase' }),
    ).rejects.toThrow('Supabase private storage requires');
  });
});
