import type { ExecutionContext } from '@nestjs/common';
import { mockDeep } from 'jest-mock-extended';
import * as jwt from 'jsonwebtoken';
import { NoopTokenVersionCache } from '../../infrastructure/token-version/token-version.cache';
import config from '../config/app.config';
import type { PrismaService } from '../services/prisma.service';
import { AuthGuard } from './auth.guard';

const NOW = new Date('2026-11-27T12:00:00.000Z');

/**
 * AuthGuard's session check: an access token of an ended sign-in session
 * (logout, the session list, logout-all, MFA activation) is refused at once.
 */
describe('AuthGuard: sign-in session check (sessions ended by users or MFA)', () => {
  const prisma = mockDeep<PrismaService>();
  const guard = new AuthGuard(new NoopTokenVersionCache(), prisma);
  const original = config.jwt_access_secret;
  const contextOf = (claims: object) => {
    const token = jwt.sign(
      { userId: 'alice', role: 'USER', tokenVersion: 2, ...claims },
      config.jwt_access_secret,
    );
    const request = { headers: { authorization: `Bearer ${token}` } };
    return {
      request,
      context: {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext,
    };
  };

  beforeAll(() => {
    config.jwt_access_secret = 'auth-guard-session-spec-secret';
  });
  afterAll(() => {
    config.jwt_access_secret = original;
  });
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers({ now: NOW });
    prisma.authUser.findUnique.mockResolvedValue({
      tokenVersion: 2,
      status: 'ACTIVE',
    } as never);
  });
  afterEach(() => jest.useRealTimers());

  it('accepts a token whose session is active, looking only at the token user’s session', async () => {
    prisma.refreshSession.count.mockResolvedValue(1);
    const { request, context } = contextOf({ sid: 'session-1' });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(prisma.refreshSession.count.mock.calls).toContainEqual([
      {
        where: {
          authId: 'alice',
          familyId: 'session-1',
          revokedAt: null,
          expiresAt: { gt: NOW },
        },
      },
    ]);
    expect(request).toMatchObject({
      user: { userId: 'alice', sid: 'session-1' },
    });
  });

  it('refuses a token whose session was ended, even with a current token version', async () => {
    prisma.refreshSession.count.mockResolvedValue(0);
    const { request, context } = contextOf({ sid: 'session-1' });

    await expect(guard.canActivate(context)).rejects.toThrow(
      'This session has ended. Please sign in again.',
    );
    expect(request).not.toHaveProperty('user');
  });

  it('checks the token version first (logout-all ends every token)', async () => {
    prisma.authUser.findUnique.mockResolvedValue({
      tokenVersion: 3,
      status: 'ACTIVE',
    } as never);

    await expect(
      guard.canActivate(contextOf({ sid: 'session-1' }).context),
    ).rejects.toThrow('Token has been revoked. Please login again.');
    expect(prisma.refreshSession.count.mock.calls).toHaveLength(0);
  });

  it('tokens issued before sessions were identified (no sid) are ended by the token version only', async () => {
    await expect(guard.canActivate(contextOf({}).context)).resolves.toBe(true);

    expect(prisma.refreshSession.count.mock.calls).toHaveLength(0);
  });

  it('fails closed when the session cannot be checked', async () => {
    prisma.refreshSession.count.mockRejectedValue(new Error('db down'));

    await expect(
      guard.canActivate(contextOf({ sid: 'session-1' }).context),
    ).rejects.toThrow('Authentication failed');
  });
});
