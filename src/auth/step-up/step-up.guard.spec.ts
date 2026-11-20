import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { StepUpAction, StepUpMethod } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { PrismaService } from '../../common/services/prisma.service';
import { STEP_UP_ACTION_KEY } from './step-up.constants';
import { StepUpGuard } from './step-up.guard';

const TOKEN = `stup_${'A'.repeat(43)}`;
const NOW = new Date('2026-11-25T10:00:00.000Z');
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

interface StoredApproval {
  tokenHash: string;
  authId: string;
  sessionId: string;
  action: StepUpAction;
  method: StepUpMethod;
  expiresAt: Date;
}

describe('StepUpGuard', () => {
  let approvals: StoredApproval[];
  let activeSessions: Array<{ authId: string; familyId: string }>;
  let mfaEnabled: boolean;
  let guard: StepUpGuard;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    approvals = [
      {
        tokenHash: sha256(TOKEN),
        authId: 'alice',
        sessionId: 'session-1',
        action: 'SUBSCRIPTION_CANCEL',
        method: 'PASSWORD',
        expiresAt: new Date(NOW.getTime() + 60_000),
      },
    ];
    activeSessions = [{ authId: 'alice', familyId: 'session-1' }];
    mfaEnabled = false;
    const prisma = {
      stepUpApproval: {
        findUnique: jest.fn(({ where }: { where: { tokenHash: string } }) =>
          Promise.resolve(
            approvals.find((a) => a.tokenHash === where.tokenHash) ?? null,
          ),
        ),
      },
      refreshSession: {
        count: jest.fn(
          ({ where }: { where: { authId: string; familyId: string } }) =>
            Promise.resolve(
              activeSessions.filter(
                (s) =>
                  s.authId === where.authId && s.familyId === where.familyId,
              ).length,
            ),
        ),
      },
      authSecurity: {
        findUnique: jest.fn(() => Promise.resolve({ mfaEnabled })),
      },
    } as unknown as PrismaService;
    guard = new StepUpGuard(new Reflector(), prisma);
  });

  afterEach(() => jest.useRealTimers());

  /** A request to a route marked with @RequireStepUp(action). */
  function context(
    action: StepUpAction | undefined,
    user: { userId: string; sid?: string } | undefined,
    headers: Record<string, unknown> = {},
  ): ExecutionContext {
    const handler = () => undefined;
    if (action) Reflect.defineMetadata(STEP_UP_ACTION_KEY, action, handler);
    return {
      getHandler: () => handler,
      getClass: () => class Route {},
      switchToHttp: () => ({ getRequest: () => ({ headers, user }) }),
    } as unknown as ExecutionContext;
  }

  const check = (
    headers: Record<string, unknown>,
    user: { userId: string; sid?: string } | undefined = {
      userId: 'alice',
      sid: 'session-1',
    },
    action: StepUpAction = 'SUBSCRIPTION_CANCEL',
  ) => guard.canActivate(context(action, user, headers));

  it('lets routes without @RequireStepUp through', async () => {
    await expect(
      guard.canActivate(context(undefined, { userId: 'alice' })),
    ).resolves.toBe(true);
  });

  it('accepts the approval of this user, session and action', async () => {
    await expect(check({ 'x-step-up-token': TOKEN })).resolves.toBe(true);
  });

  it('answers 403 when no approval is sent', async () => {
    await expect(check({})).rejects.toMatchObject({
      status: 403,
      message:
        'Step-up authentication is required for this action (SUBSCRIPTION_CANCEL)',
    });
    await expect(check({ 'x-step-up-token': '' })).rejects.toMatchObject({
      status: 403,
    });
    // Repeated headers arrive as an array: refused.
    await expect(
      check({ 'x-step-up-token': [TOKEN, TOKEN] }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it.each([
    ['a malformed token', { token: 'not-a-token' }],
    ['an unknown token', { token: `stup_${'B'.repeat(43)}` }],
    ['another user', { userId: 'bob' }],
    ['another session of the same user', { sid: 'session-2' }],
    ['a token without a session (issued before sessions)', { sid: undefined }],
    ['another action', { action: 'ACCOUNT_DELETION' as StepUpAction }],
  ])('answers 403 for %s', async (_, variant) => {
    const user = {
      userId: 'userId' in variant ? variant.userId : 'alice',
      sid: 'sid' in variant ? variant.sid : 'session-1',
    };
    await expect(
      check(
        { 'x-step-up-token': 'token' in variant ? variant.token : TOKEN },
        user,
        'action' in variant ? variant.action : 'SUBSCRIPTION_CANCEL',
      ),
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(
        /missing, expired or not valid for this action/,
      ) as string,
    });
  });

  it('answers 403 once the approval is ten minutes old (expired)', async () => {
    approvals[0].expiresAt = NOW;
    await expect(check({ 'x-step-up-token': TOKEN })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('answers 403 once the session ended (logout, logout-all)', async () => {
    activeSessions = [];
    await expect(check({ 'x-step-up-token': TOKEN })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('answers 403 without an authenticated user', async () => {
    // (Not through check(): its default user would apply.)
    await expect(
      guard.canActivate(
        context('SUBSCRIPTION_CANCEL', undefined, { 'x-step-up-token': TOKEN }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
