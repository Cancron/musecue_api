import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Logger } from 'winston';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exception.filter';
import { TransformInterceptor } from '../../src/common/interceptors/transform.interceptor';
import { EmailService } from '../../src/common/services/email.service';
import { PrismaService } from '../../src/common/services/prisma.service';
import { AccountDeletionRecoveryService } from '../../src/privacy/account-deletion/account-deletion-recovery.service';
import { givenCreditsInPostgres } from './credit-fixtures';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  createSchema,
  dropSchema,
  migrationNames,
} from './migrated-schema';

/**
 * End-to-end flows through the complete application (AppModule, HTTP, the
 * selected infrastructure drivers and real background processing), shared by
 * the PostgreSQL-only and the Redis e2e tests so both modes are held to the
 * same behaviour. Only SMTP is replaced (emails are captured).
 *
 * Spec files import their mode's environment file (REDIS_ENABLED and
 * friends) before this module, which loads the application.
 */

export interface SentEmail {
  kind: 'verification' | 'welcome' | 'account-deletion-code';
  to: string;
  code?: string;
}

/** Stands in for EmailService: records what would have been sent. */
export class CapturingEmailService {
  readonly sent: SentEmail[] = [];

  sendVerificationEmail(to: string, _username: string, code: string) {
    this.sent.push({ kind: 'verification', to, code });
    return Promise.resolve();
  }

  sendWelcomeEmail(to: string) {
    this.sent.push({ kind: 'welcome', to });
    return Promise.resolve();
  }

  sendAccountDeletionCodeEmail(to: string, _username: string, code: string) {
    this.sent.push({ kind: 'account-deletion-code', to, code });
    return Promise.resolve();
  }
}

export interface TestApplication {
  app: INestApplication<App>;
  client: PrismaClient;
  /** The PostgreSQL schema the application runs against. */
  schema: string;
  emails: CapturingEmailService;
  /** Resolves the application's provider for `token`. */
  get<T>(token: unknown): T;
  close(): Promise<void>;
}

export interface BootOptions {
  /**
   * An existing, migrated schema to run against instead of a fresh one, e.g.
   * to boot a second application on the same data as a process restart
   * would. The caller owns it: `close()` does not drop it.
   */
  schema?: string;
  /** Providers replaced by test doubles (e.g. the Stripe client). */
  overrides?: Array<{ provide: unknown; useValue: unknown }>;
}

/** Boots AppModule against a freshly migrated (or the given) schema. */
export async function bootApplication(
  options: BootOptions = {},
): Promise<TestApplication> {
  const ownsSchema = options.schema === undefined;
  const schema = options.schema ?? (await createSchema());
  if (ownsSchema) await applyMigrations(schema, migrationNames());
  const root = await mkdtemp(join(tmpdir(), 'infrastructure-e2e-'));
  process.env.PRIVATE_UPLOAD_DIR = join(root, 'images');
  process.env.PRIVATE_EXPORT_DIR = join(root, 'exports');
  process.env.DATABASE_URL = TEST_DATABASE_URL;

  const client = new PrismaClient({
    adapter: new PrismaPg(
      {
        connectionString: TEST_DATABASE_URL as string,
        options: `-c search_path=${schema}`,
      },
      { schema },
    ),
  });
  const emails = new CapturingEmailService();

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(client)
    .overrideProvider(EmailService)
    .useValue(emails);
  for (const override of options.overrides ?? []) {
    builder = builder
      .overrideProvider(override.provide)
      .useValue(override.useValue);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({
    rawBody: true,
  });
  // Each simulated user gets its own client address (X-Forwarded-For), so
  // the per-IP limits of one flow do not affect another.
  (
    app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void }
  ).set('trust proxy', true);
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
  await app.init();

  return {
    app,
    client,
    schema,
    emails,
    get: <T>(token: unknown) =>
      moduleRef.get<T>(token as string, { strict: false }),
    close: async () => {
      await app.close();
      await client.$disconnect();
      if (ownsSchema) await dropSchema(schema);
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Polls `check` until it returns a value (or fails after `timeoutMs`). */
export async function eventually<T>(
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
  what = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A real image, validated by sharp like production uploads. */
export async function photo(shade = 120): Promise<Buffer> {
  return sharp({
    create: {
      width: 400,
      height: 400,
      channels: 3,
      background: { r: shade, g: 80, b: 160 },
    },
  })
    .jpeg()
    .toBuffer();
}

interface Envelope<T> {
  statusCode: number;
  message: string;
  data: T;
}
const data = <T>(response: { body: unknown }) =>
  (response.body as Envelope<T>).data;

export interface SignedInUser {
  id: string;
  email: string;
  ip: string;
  accessToken: string;
  refreshToken: string;
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

interface AiRunView {
  id: string;
  status: string;
  operation: string;
  error: string | null;
}

/**
 * Registration with the emailed code, password login, refresh-token rotation
 * (including concurrent reuse) and sign-out, all over HTTP.
 */
export async function authenticationFlow(
  ctx: TestApplication,
): Promise<SignedInUser> {
  const tag = randomBytes(5).toString('hex');
  const email = `user_${tag}@example.com`;
  const password = 'correct horse battery staple';
  const ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
  const http = () => request(ctx.app.getHttpServer());

  await http()
    .post('/auth')
    .set('X-Forwarded-For', ip)
    .send({ username: `user_${tag}`, email, password })
    .expect(201);

  // The verification email is sent by the background worker.
  const sent = await eventually(
    () =>
      Promise.resolve(
        ctx.emails.sent.find(
          (item) => item.kind === 'verification' && item.to === email,
        ),
      ),
    30_000,
    'the verification email',
  );
  const code = sent.code as string;
  const user = await ctx.client.authUser.findUniqueOrThrow({
    where: { email },
    include: { authChallenges: true },
  });
  // Only a keyed hash of the code is stored.
  expect(user.authChallenges).toHaveLength(1);
  expect(JSON.stringify(user.authChallenges)).not.toContain(code);
  await eventually(
    async () =>
      (await ctx.client.emailHistory.findFirst({
        where: { authId: user.id, emailStatus: 'sent' },
      })) !== null,
    30_000,
    'the email history update',
  );

  // Password login requires the verified email.
  await http()
    .post('/auth/login')
    .set('X-Forwarded-For', ip)
    .send({ email, password })
    .expect(403);
  const wrong = code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
  const invalid = await http()
    .post('/auth/verify-email')
    .set('X-Forwarded-For', ip)
    .send({ email, code: wrong })
    .expect(400);
  expect((invalid.body as { message: string }).message).toBe(
    'Invalid verification code',
  );
  await http()
    .post('/auth/verify-email')
    .set('X-Forwarded-For', ip)
    .send({ email, code })
    .expect(201);
  // Single use.
  await http()
    .post('/auth/verify-email')
    .set('X-Forwarded-For', ip)
    .send({ email, code })
    .expect(400);
  await eventually(
    () =>
      Promise.resolve(
        ctx.emails.sent.find(
          (item) => item.kind === 'welcome' && item.to === email,
        ),
      ),
    30_000,
    'the welcome email',
  );

  const login = data<Tokens & { user: { id: string } }>(
    await http()
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password })
      .expect(201),
  );
  expect(login.user.id).toBe(user.id);
  const bearer = (token: string) => `Bearer ${token}`;
  await http()
    .get('/v1/sessions')
    .set('Authorization', bearer(login.accessToken))
    .expect(200);

  // Refresh-token rotation: the old token works exactly once.
  const rotated = data<Tokens>(
    await http()
      .post('/auth/refresh-token')
      .set('X-Forwarded-For', ip)
      .send({ refreshToken: login.refreshToken })
      .expect(201),
  );
  await http()
    .post('/auth/refresh-token')
    .set('X-Forwarded-For', ip)
    .send({ refreshToken: login.refreshToken })
    .expect(401);
  // Concurrent reuse of one token: exactly one request succeeds.
  const concurrent = await Promise.all(
    Array.from({ length: 4 }, () =>
      http()
        .post('/auth/refresh-token')
        .set('X-Forwarded-For', ip)
        .send({ refreshToken: rotated.refreshToken }),
    ),
  );
  const winners = concurrent.filter((response) => response.status === 201);
  expect(winners).toHaveLength(1);
  expect(
    concurrent
      .filter((response) => response.status !== 201)
      .map((response) => response.status),
  ).toEqual([401, 401, 401]);
  const current = data<Tokens>(winners[0]);

  const sessions = await ctx.client.refreshSession.findMany({
    where: { authId: user.id },
    orderBy: { createdAt: 'asc' },
  });
  expect(sessions.map((session) => session.revokedReason)).toEqual([
    'ROTATED',
    'ROTATED',
    null,
  ]);
  expect(JSON.stringify(sessions)).not.toContain(current.refreshToken);

  // Signing out everywhere revokes every token at once.
  const second = data<Tokens>(
    await http()
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password })
      .expect(201),
  );
  await http()
    .post('/auth/logout-all')
    .set('Authorization', bearer(second.accessToken))
    .expect(201);
  await http()
    .get('/v1/sessions')
    .set('Authorization', bearer(current.accessToken))
    .expect(401);
  await http()
    .post('/auth/refresh-token')
    .set('X-Forwarded-For', ip)
    .send({ refreshToken: second.refreshToken })
    .expect(401);

  const fresh = data<Tokens>(
    await http()
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password })
      .expect(201),
  );
  return { id: user.id, email, ip, ...fresh };
}

/**
 * The makeup workflow: analysis, guide generation, a visual step check and a
 * coach question, each processed by the AI worker (mock gateway).
 */
export async function makeupFlow(
  ctx: TestApplication,
  user: SignedInUser,
): Promise<{ runIds: string[] }> {
  const auth = `Bearer ${user.accessToken}`;
  const http = () => request(ctx.app.getHttpServer());
  const waitForRun = (runId: string) =>
    eventually(
      async () => {
        const run = data<AiRunView>(
          await http().get(`/v1/jobs/${runId}`).set('Authorization', auth),
        );
        if (run.status === 'FAILED') {
          throw new Error(`AI run failed: ${run.error ?? ''}`);
        }
        return run.status === 'COMPLETED' ? run : null;
      },
      30_000,
      `AI run ${runId}`,
    );
  const runIds: string[] = [];

  // Creating a session requires credits; free sign-ups have none. Purchased
  // credits are set up directly in PostgreSQL (not issued by the API yet).
  await givenCreditsInPostgres(ctx.client, user.id, 'PURCHASE', '100');
  const session = data<{ id: string }>(
    await http().post('/v1/sessions').set('Authorization', auth).expect(201),
  );
  await http()
    .post(`/v1/sessions/${session.id}/images`)
    .set('Authorization', auth)
    .field('purpose', 'INITIAL_ANALYSIS')
    .attach('image', await photo(), {
      filename: 'face.jpg',
      contentType: 'image/jpeg',
    })
    .expect(201);
  await http()
    .patch(`/v1/sessions/${session.id}/preferences`)
    .set('Authorization', auth)
    .send({ vibe: 'natural', timeMinutes: 10 })
    .expect(200);

  const analysis = await http()
    .post(`/v1/sessions/${session.id}/analyze`)
    .set('Authorization', auth)
    .set('Idempotency-Key', `analysis-${session.id}`)
    .expect(201);
  const analysisRun = data<AiRunView & Record<string, unknown>>(analysis);
  // The recorded job input is never part of the response.
  expect(analysisRun).not.toHaveProperty('jobInput');
  expect(analysisRun).toMatchObject({
    operation: 'PERSONALIZATION',
    status: 'QUEUED',
  });
  // A retried request is idempotent.
  const retried = data<AiRunView>(
    await http()
      .post(`/v1/sessions/${session.id}/analyze`)
      .set('Authorization', auth)
      .set('Idempotency-Key', `analysis-${session.id}`)
      .expect(201),
  );
  expect(retried.id).toBe(analysisRun.id);
  await waitForRun(analysisRun.id);
  runIds.push(analysisRun.id);

  const ready = data<{
    status: string;
    recommendations: Array<{ id: string }>;
  }>(
    await http()
      .get(`/v1/sessions/${session.id}`)
      .set('Authorization', auth)
      .expect(200),
  );
  expect(ready.status).toBe('RECOMMENDATIONS_READY');

  const guideRun = data<AiRunView>(
    await http()
      .post(
        `/v1/sessions/${session.id}/recommendations/${ready.recommendations[0].id}/select`,
      )
      .set('Authorization', auth)
      .set('Idempotency-Key', `guide-${session.id}`)
      .expect(201),
  );
  await waitForRun(guideRun.id);
  runIds.push(guideRun.id);
  const guided = data<{
    status: string;
    guide: { steps: Array<{ id: string; status: string }> };
  }>(
    await http()
      .get(`/v1/sessions/${session.id}`)
      .set('Authorization', auth)
      .expect(200),
  );
  expect(guided.status).toBe('GUIDE_READY');
  const step = guided.guide.steps.find((item) => item.status === 'CURRENT')!;

  const check = data<AiRunView & Record<string, unknown>>(
    await http()
      .post(`/v1/guide-steps/${step.id}/check`)
      .set('Authorization', auth)
      .set('Idempotency-Key', `check-${step.id}`)
      .attach('image', await photo(90), {
        filename: 'step.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201),
  );
  expect(check).not.toHaveProperty('jobInput');
  await waitForRun(check.id);
  runIds.push(check.id);

  const question = data<AiRunView>(
    await http()
      .post(`/v1/guide-steps/${step.id}/questions`)
      .set('Authorization', auth)
      .set('Idempotency-Key', `question-${step.id}`)
      .send({ question: 'How much blush should I use?' })
      .expect(201),
  );
  await waitForRun(question.id);
  runIds.push(question.id);

  // The operation input is recorded on the runs (immutable) ...
  const [checkRun, questionRun] = await Promise.all([
    ctx.client.aiRun.findUniqueOrThrow({ where: { id: check.id } }),
    ctx.client.aiRun.findUniqueOrThrow({ where: { id: question.id } }),
  ]);
  const attempt = await ctx.client.stepAttempt.findFirstOrThrow({
    where: { stepId: step.id },
  });
  expect(checkRun.jobInput).toEqual({ imageId: attempt.imageId });
  expect(questionRun.jobInput).toEqual({
    question: 'How much blush should I use?',
  });
  // ... and the results are published.
  const answered = await ctx.client.question.findFirstOrThrow({
    where: { stepId: step.id },
  });
  expect(answered.question).toBe('How much blush should I use?');
  expect(answered.answer.length).toBeGreaterThan(0);
  return { runIds };
}

/** A personal data export built by the export worker and downloaded. */
export async function privacyExportFlow(
  ctx: TestApplication,
  user: SignedInUser,
): Promise<{ exportId: string }> {
  const auth = `Bearer ${user.accessToken}`;
  const http = () => request(ctx.app.getHttpServer());

  const requested = data<{ id: string; status: string }>(
    await http()
      .post('/v1/privacy/exports')
      .set('Authorization', auth)
      .set('Idempotency-Key', `export-${user.id}`)
      .expect(202),
  );
  expect(requested.status).toBe('QUEUED');

  const completed = await eventually(
    async () => {
      const view = data<{ status: string; sizeBytes: number | null }>(
        await http()
          .get(`/v1/privacy/exports/${requested.id}`)
          .set('Authorization', auth)
          .expect(200),
      );
      if (view.status === 'FAILED') throw new Error('The export failed');
      return view.status === 'COMPLETED' ? view : null;
    },
    30_000,
    'the export',
  );
  expect(completed.sizeBytes).toBeGreaterThan(0);

  const link = data<{ url: string }>(
    await http()
      .get(`/v1/privacy/exports/${requested.id}/download`)
      .set('Authorization', auth)
      .expect(200),
  );
  const archive = await http()
    .get(link.url)
    .set('Authorization', auth)
    .buffer(true)
    .parse((response, callback) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    })
    .expect(200);
  // A ZIP archive.
  expect((archive.body as Buffer).subarray(0, 2).toString('latin1')).toBe('PK');
  return { exportId: requested.id };
}

/**
 * Account deletion over HTTP: the emailed code (sent by the email worker),
 * approval (every token stops working at once), then erasure (normally the
 * 30-second sweep). Returns what is left of the account in PostgreSQL.
 */
export async function accountDeletionFlow(
  ctx: TestApplication,
  user: SignedInUser,
) {
  const http = () => request(ctx.app.getHttpServer());
  const auth = `Bearer ${user.accessToken}`;

  await http()
    .post('/v1/privacy/account-deletion/confirmation-code')
    .set('Authorization', auth)
    .expect(202);
  const sent = await eventually(
    () =>
      Promise.resolve(
        ctx.emails.sent.find(
          (item) =>
            item.kind === 'account-deletion-code' && item.to === user.email,
        ),
      ),
    30_000,
    'the account deletion code email',
  );
  const challenge = await ctx.client.authChallenge.findFirstOrThrow({
    where: { authId: user.id, purpose: 'ACCOUNT_DELETION' },
  });
  expect(challenge.codeHash).not.toContain(sent.code as string);

  const accepted = data<{ status: string; sessionsRevoked: boolean }>(
    await http()
      .post('/v1/privacy/account-deletion')
      .set('Authorization', auth)
      .send({ password: 'correct horse battery staple', code: sent.code })
      .expect(202),
  );
  expect(accepted).toMatchObject({ status: 'PENDING', sessionsRevoked: true });
  await http().get('/v1/sessions').set('Authorization', auth).expect(401);
  await http()
    .post('/auth/refresh-token')
    .set('X-Forwarded-For', user.ip)
    .send({ refreshToken: user.refreshToken })
    .expect(401);

  const result = await ctx
    .get<AccountDeletionRecoveryService>(AccountDeletionRecoveryService)
    .resume();
  expect(result.completed).toBe(1);

  const where = { where: { authId: user.id } };
  return {
    user: await ctx.client.authUser.count({ where: { id: user.id } }),
    refreshSessions: await ctx.client.refreshSession.count(where),
    authChallenges: await ctx.client.authChallenge.count(where),
    aiRuns: await ctx.client.aiRun.count(where),
    dataExports: await ctx.client.dataExport.count(where),
    infrastructureJobs: await ctx.client.infrastructureJob.count(where),
  };
}
