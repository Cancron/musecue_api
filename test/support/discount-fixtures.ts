import { userRole } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { AuthUtilsService } from '../../src/auth/services/auth-utils.service';
import type { RateLimitStore } from '../../src/infrastructure/rate-limit/rate-limit.store';
import type { TestApplication } from './infrastructure-flows';

/**
 * Accounts and HTTP helpers for the discount, campaign and daily reward
 * e2e tests. Access tokens are minted by the production token code at call
 * time, so they stay valid while a test moves the clock with freezeTime
 * (the admin permission tests also sign in through the real login route).
 */

export interface TestAccount {
  id: string;
  role: userRole;
}

const tokens = new AuthUtilsService(mock<RateLimitStore>());
let ipCounter = 0;

export const nextTestIp = () => {
  ipCounter += 1;
  return `10.${Math.floor(ipCounter / 65_025) % 255}.${Math.floor(ipCounter / 255) % 255}.${(ipCounter % 255) + 1}`;
};

/** Creates an active, verified account with `role`. */
export async function createAccount(
  ctx: TestApplication,
  role: userRole = userRole.USER,
): Promise<TestAccount> {
  const tag = randomBytes(6).toString('hex');
  const user = await ctx.client.authUser.create({
    data: {
      email: `${role.toLowerCase()}_${tag}@example.com`,
      username: `${role.toLowerCase()}_${tag}`,
      password: 'not-used-tokens-are-minted',
      verified: true,
      role,
    },
  });
  return { id: user.id, role };
}

/** `Bearer <access token>` for the account, valid from the current time. */
export const bearerOf = (account: TestAccount) =>
  `Bearer ${tokens.createAccessToken({
    userId: account.id,
    role: account.role,
    tokenVersion: 1,
  })}`;

export interface Envelope<T> {
  statusCode: number;
  message: string;
  data: T;
}
export const dataOf = <T>(response: { body: unknown }) =>
  (response.body as Envelope<T>).data;
export const messageOf = (response: { body: unknown }) =>
  (response.body as { message: string }).message;

/**
 * Requests as `account` (or anonymously). Every request comes from a new
 * client address, so the per-IP rate limits never interfere.
 */
export function as(ctx: TestApplication, account?: TestAccount) {
  const server = () => request(ctx.app.getHttpServer());
  const prepare = (req: request.Test) => {
    req.set('X-Forwarded-For', nextTestIp());
    return account ? req.set('Authorization', bearerOf(account)) : req;
  };
  return {
    get: (path: string) => prepare(server().get(path)),
    post: (path: string, body?: object, idempotencyKey?: string) => {
      const req = prepare(server().post(path));
      if (idempotencyKey !== undefined)
        req.set('Idempotency-Key', idempotencyKey);
      return req.send(body ?? {});
    },
    patch: (path: string, body: unknown) =>
      prepare(server().patch(path)).send(body as object),
  };
}

/** A unique idempotency key. */
export const newKey = () => `key-${randomBytes(8).toString('hex')}`;

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
/** `ms` from now, as an ISO string. */
export const fromNow = (ms: number) => new Date(Date.now() + ms).toISOString();

/**
 * Starts listening on an ephemeral port. Without this, supertest starts the
 * shared HTTP server for each request and closes it when that request ends,
 * which resets other requests still in flight: concurrency tests need a
 * server that stays up. (Closed by the application's close().)
 */
export async function listen(ctx: TestApplication): Promise<void> {
  const server = ctx.app.getHttpServer() as unknown as {
    listening: boolean;
    listen(port: number, host: string, callback: () => void): void;
  };
  if (server.listening) return;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
}
