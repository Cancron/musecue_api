import { mock } from 'jest-mock-extended';
import request from 'supertest';
import { UserRole } from '../../src/auth/interfaces/auth.interface';
import { AuthUtilsService } from '../../src/auth/services/auth-utils.service';
import { RateLimitStore } from '../../src/infrastructure/rate-limit/rate-limit.store';
import type { FakeOpenRouter } from './fake-openrouter';
import {
  bootApplication,
  eventually,
  photo,
  type TestApplication,
} from './infrastructure-flows';
import { createUser } from './subscription-fixtures';

/**
 * The complete application (AppModule over HTTP, PostgreSQL queue worker)
 * with live AI against a FakeOpenRouter, plus HTTP helpers for the makeup
 * workflow. Spec files import './env-postgres-mode' first.
 */
export async function bootLiveAiApplication(
  openRouter: FakeOpenRouter,
): Promise<TestApplication> {
  const baseUrl = await openRouter.start();
  process.env.AI_MODE = 'live';
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-e2e-test-key';
  process.env.OPENROUTER_BASE_URL = baseUrl;
  process.env.OPENROUTER_MODEL = 'openai/gpt-4.1-mini';
  process.env.AI_QUEUE_RATE_LIMIT_MAX = '1000';
  const ctx = await bootApplication();
  // Listen once: otherwise supertest starts and closes the server for every
  // request, which resets concurrent requests (ECONNRESET).
  await ctx.app.listen(0, '127.0.0.1');
  return ctx;
}

export interface AiUser {
  id: string;
  auth: string;
  ip: string;
}

let users = 0;
const tokens = new AuthUtilsService(mock<RateLimitStore>());
const data = <T>(response: { body: unknown }) =>
  (response.body as { data: T }).data;

export function makeupClient(ctx: TestApplication) {
  const http = () => request(ctx.app.getHttpServer());
  const as = (user: AiUser, req: request.Test) =>
    req.set('Authorization', user.auth).set('X-Forwarded-For', user.ip);

  /** A verified user; `credits` purchased credits set up in PostgreSQL. */
  async function newUser(credits: number | string = 0): Promise<AiUser> {
    users += 1;
    const id = await createUser(ctx.client);
    if (Number(credits) > 0) {
      await ctx.client.$queryRaw`
          SELECT "Credit_grant_manual"(${id}, 'PURCHASE'::"CreditSource", ${`ai-e2e:${id}`}, ${String(credits)}::numeric)`;
    }
    const token = tokens.createAccessToken({
      userId: id,
      role: UserRole.USER,
      tokenVersion: 1,
    });
    return {
      id,
      auth: `Bearer ${token}`,
      ip: `198.19.${Math.floor(users / 250)}.${users % 250}`,
    };
  }

  function createSession(user: AiUser) {
    return as(user, http().post('/v1/sessions'));
  }

  /** A session with a photo and preferences, ready for analysis. */
  async function readySession(user: AiUser): Promise<string> {
    const session = data<{ id: string }>(await createSession(user).expect(201));
    await as(user, http().post(`/v1/sessions/${session.id}/images`))
      .field('purpose', 'INITIAL_ANALYSIS')
      .attach('image', await photo(), {
        filename: 'face.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201);
    await as(user, http().patch(`/v1/sessions/${session.id}/preferences`))
      .send({ vibe: 'natural', timeMinutes: 10 })
      .expect(200);
    return session.id;
  }

  async function analyze(user: AiUser, sessionId: string, key = sessionId) {
    return data<{ id: string }>(
      await as(user, http().post(`/v1/sessions/${sessionId}/analyze`))
        .set('Idempotency-Key', `analysis-${key}`)
        .expect(201),
    ).id;
  }

  async function selectFirstLook(user: AiUser, sessionId: string) {
    const session = data<{ recommendations: { id: string }[] }>(
      await as(user, http().get(`/v1/sessions/${sessionId}`)).expect(200),
    );
    return data<{ id: string }>(
      await as(
        user,
        http().post(
          `/v1/sessions/${sessionId}/recommendations/${session.recommendations[0].id}/select`,
        ),
      )
        .set('Idempotency-Key', `guide-${sessionId}`)
        .expect(201),
    ).id;
  }

  async function currentStep(user: AiUser, sessionId: string): Promise<string> {
    const session = data<{
      guide: { steps: { id: string; status: string }[] };
    }>(await as(user, http().get(`/v1/sessions/${sessionId}`)).expect(200));
    return session.guide.steps.find((step) => step.status === 'CURRENT')!.id;
  }

  async function checkStep(user: AiUser, stepId: string, key: string) {
    return data<{ id: string }>(
      await as(user, http().post(`/v1/guide-steps/${stepId}/check`))
        .set('Idempotency-Key', key)
        .attach('image', await photo(90), {
          filename: 'step.jpg',
          contentType: 'image/jpeg',
        })
        .expect(201),
    ).id;
  }

  async function ask(user: AiUser, stepId: string, key: string) {
    return data<{ id: string }>(
      await as(user, http().post(`/v1/guide-steps/${stepId}/questions`))
        .set('Idempotency-Key', key)
        .send({ question: `Question ${key}?` })
        .expect(201),
    ).id;
  }

  /** Waits until the run is COMPLETED or FAILED. */
  function settled(runId: string) {
    return eventually(
      async () => {
        const run = await ctx.client.aiRun.findUniqueOrThrow({
          where: { id: runId },
        });
        return run.status === 'COMPLETED' || run.status === 'FAILED'
          ? run
          : null;
      },
      90_000,
      `AI run ${runId}`,
    );
  }
  return {
    http,
    newUser,
    createSession,
    readySession,
    analyze,
    selectFirstLook,
    currentStep,
    checkStep,
    ask,
    settled,
  };
}
