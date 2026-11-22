import type { userRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { TestApplication } from './infrastructure-flows';

/** A signed-in account: its user ID and an access token from /auth/login. */
export interface SignedInAccount {
  id: string;
  accessToken: string;
}

const PASSWORD = 'admin settings e2e password';

/**
 * Creates an active, verified local account with `role` and signs it in
 * through the real login endpoint, from client address `ip` (per-IP rate
 * limits apply to logins).
 */
export async function signInWithRole(
  ctx: TestApplication,
  role: userRole,
  ip: string,
): Promise<SignedInAccount> {
  const tag = randomBytes(5).toString('hex');
  const email = `${role.toLowerCase()}_${tag}@example.com`;
  const created = await ctx.client.authUser.create({
    data: {
      email,
      username: `${role.toLowerCase()}_${tag}`,
      password: await bcrypt.hash(PASSWORD, 4),
      verified: true,
      role,
    },
  });
  const response = await request(ctx.app.getHttpServer())
    .post('/auth/login')
    .set('X-Forwarded-For', ip)
    .send({ email, password: PASSWORD })
    .expect(201);
  const login = (
    response.body as {
      data: { accessToken: string; user: { role: string } };
    }
  ).data;
  if (login.user.role !== role) {
    throw new Error(`Signed in as ${login.user.role}, expected ${role}`);
  }
  return { id: created.id, accessToken: login.accessToken };
}

/** Invalidates every access token of the account (a security event). */
export async function revokeTokens(
  ctx: TestApplication,
  account: SignedInAccount,
): Promise<void> {
  await ctx.client.authUser.update({
    where: { id: account.id },
    data: { tokenVersion: { increment: 1 } },
  });
}
