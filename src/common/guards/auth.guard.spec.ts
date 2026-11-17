import type { ExecutionContext } from '@nestjs/common';
import { mockDeep } from 'jest-mock-extended';
import * as jwt from 'jsonwebtoken';
import { NoopTokenVersionCache } from '../../infrastructure/token-version/token-version.cache';
import config from '../config/app.config';
import type { PrismaService } from '../services/prisma.service';
import { AuthGuard } from './auth.guard';

describe('AuthGuard without a token-version cache (REDIS_ENABLED=false)', () => {
  const prisma = mockDeep<PrismaService>();
  const guard = new AuthGuard(new NoopTokenVersionCache(), prisma);
  const original = config.jwt_access_secret;
  const context = (token: string) => {
    const request = { headers: { authorization: `Bearer ${token}` } };
    return {
      request,
      context: {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext,
    };
  };
  const token = (tokenVersion: number) =>
    jwt.sign(
      { userId: 'user-1', role: 'USER', tokenVersion },
      config.jwt_access_secret,
    );

  beforeAll(() => {
    config.jwt_access_secret = 'auth-guard-spec-secret';
  });
  afterAll(() => {
    config.jwt_access_secret = original;
  });
  beforeEach(() => jest.resetAllMocks());

  it('checks the current token version in the database on every request', async () => {
    prisma.authUser.findUnique.mockResolvedValue({
      tokenVersion: 3,
      status: 'ACTIVE',
    } as never);

    const { request, context: ctx } = context(token(3));
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    expect(prisma.authUser.findUnique.mock.calls).toHaveLength(2);
    expect(request).toMatchObject({ user: { userId: 'user-1' } });
  });

  it('rejects a token revoked by a security event at once', async () => {
    prisma.authUser.findUnique.mockResolvedValue({
      tokenVersion: 4,
      status: 'ACTIVE',
    } as never);

    await expect(guard.canActivate(context(token(3)).context)).rejects.toThrow(
      'Token has been revoked. Please login again.',
    );
  });

  it('rejects a blocked account even with a current token version', async () => {
    prisma.authUser.findUnique.mockResolvedValue({
      tokenVersion: 3,
      status: 'PENDING_DELETION',
    } as never);

    await expect(guard.canActivate(context(token(3)).context)).rejects.toThrow(
      'User account is not active',
    );
  });
});
