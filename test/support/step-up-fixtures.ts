import type { PrismaClient, StepUpAction } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

/**
 * For database-backed suites about something else (e.g. Stripe
 * cancellation) that sign requests with their own access tokens: records a
 * sign-in session and a valid step-up approval for `action`, exactly as
 * POST /auth/step-up would, so the real StepUpGuard accepts the request.
 * Use the returned `sessionId` as the access token's `sid`.
 */
export async function grantStepUp(
  client: Pick<PrismaClient, 'refreshSession' | 'stepUpApproval'>,
  authId: string,
  action: StepUpAction,
  now: Date = new Date(),
): Promise<{ sessionId: string; stepUpToken: string }> {
  const sessionId = randomUUID();
  await client.refreshSession.create({
    data: {
      authId,
      familyId: sessionId,
      tokenId: randomUUID(),
      tokenHash: randomBytes(32).toString('hex'),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 7 * 24 * 3600_000),
    },
  });
  const stepUpToken = `stup_${randomBytes(32).toString('base64url')}`;
  await client.stepUpApproval.create({
    data: {
      authId,
      sessionId,
      action,
      method: 'PASSWORD',
      tokenHash: createHash('sha256').update(stepUpToken).digest('hex'),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 10 * 60_000),
    },
  });
  return { sessionId, stepUpToken };
}

/**
 * For database-backed suites that call administrator routes with their own
 * access tokens: marks MFA as enabled on the account (authenticator app) and
 * records a sign-in session that proved MFA with the authenticator at `now`,
 * exactly as an MFA sign-in would, so the real AdminMfaGuard accepts the
 * request. Use the returned session ID as the access token's `sid`. (The
 * stored secret is a placeholder: the guard never decrypts it.)
 */
export async function grantAdminMfa(
  client: Pick<PrismaClient, 'refreshSession' | 'authSecurity'>,
  authId: string,
  now: Date = new Date(),
): Promise<string> {
  const enabled = {
    mfaEnabled: true,
    mfaMethod: 'totp' as const,
    mfaSecret: 'v1:placeholder-admin-mfa-secret',
  };
  await client.authSecurity.upsert({
    where: { authId },
    create: { authId, ...enabled },
    update: enabled,
  });
  const sessionId = randomUUID();
  await client.refreshSession.create({
    data: {
      authId,
      familyId: sessionId,
      tokenId: randomUUID(),
      tokenHash: randomBytes(32).toString('hex'),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 7 * 24 * 3600_000),
      mfaVerifiedAt: now,
      mfaVerifiedWith: 'totp',
    },
  });
  return sessionId;
}
