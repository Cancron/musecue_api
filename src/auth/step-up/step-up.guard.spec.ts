import { type ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { mock } from 'jest-mock-extended';
import { createHash } from 'node:crypto';
import { STEP_UP_ACTION, StepUpGuard } from './step-up.guard';
import type { StepUpRepository, StoredApproval } from './step-up.repository';

const TOKEN = 'T'.repeat(43);
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

describe('StepUpGuard', () => {
  const approvals = mock<StepUpRepository>();
  const guard = new StepUpGuard(new Reflector(), approvals);

  const approval = (
    overrides: Partial<StoredApproval> = {},
  ): StoredApproval => ({
    id: 'approval-1',
    authId: 'user-1',
    sessionId: 'session-1',
    action: 'ACCOUNT_DELETION',
    method: 'PASSWORD',
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  });

  /** A request to a handler protected for ACCOUNT_DELETION (or `action`). */
  function contextFor(
    headers: Record<string, string>,
    // null: absent (explicit undefined would take the default).
    user: object | null = { userId: 'user-1', sid: 'session-1' },
    action: string | null = 'ACCOUNT_DELETION',
  ) {
    const handler = () => undefined;
    if (action) Reflect.defineMetadata(STEP_UP_ACTION, action, handler);
    const request: Record<string, unknown> = {
      headers: Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      user: user ?? undefined,
    };
    const context = {
      getHandler: () => handler,
      getClass: () => class Controller {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { context, request };
  }

  async function statusOf(promise: Promise<unknown>) {
    try {
      await promise;
      return 200;
    } catch (error) {
      return error instanceof HttpException ? error.getStatus() : 500;
    }
  }

  beforeEach(() => {
    jest.resetAllMocks();
    approvals.findApproval.mockResolvedValue(approval());
    approvals.isSessionActive.mockResolvedValue(true);
  });

  it('lets unprotected handlers through without looking anything up', async () => {
    const { context } = contextFor({}, null, null);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(approvals.findApproval.mock.calls).toHaveLength(0);
  });

  it('accepts an approval for this user, session and action, and records its use', async () => {
    const { context, request } = contextFor({ 'X-Step-Up-Token': TOKEN });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(approvals.findApproval.mock.calls).toEqual([[sha256(TOKEN)]]);
    expect(approvals.touchApproval.mock.calls[0][0]).toBe('approval-1');
    expect(request.stepUp).toEqual({
      approvalId: 'approval-1',
      action: 'ACCOUNT_DELETION',
      method: 'PASSWORD',
    });
  });

  it.each([
    ['no header', {}, {}],
    ['a malformed token', { 'X-Step-Up-Token': 'short' }, {}],
    ['an unknown token', { 'X-Step-Up-Token': TOKEN }, { unknown: true }],
    ['another user', { 'X-Step-Up-Token': TOKEN }, { authId: 'user-2' }],
    [
      'another session',
      { 'X-Step-Up-Token': TOKEN },
      { sessionId: 'session-2' },
    ],
    [
      'another action',
      { 'X-Step-Up-Token': TOKEN },
      { action: 'PRIVACY_EXPORT' },
    ],
    [
      'an expired approval',
      { 'X-Step-Up-Token': TOKEN },
      { expiresAt: new Date(Date.now() - 1) },
    ],
  ])('refuses %s with 403', async (_name, headers, change: object) => {
    if ('unknown' in change) approvals.findApproval.mockResolvedValue(null);
    else approvals.findApproval.mockResolvedValue(approval(change));
    const { context, request } = contextFor(headers as Record<string, string>);
    expect(await statusOf(guard.canActivate(context))).toBe(403);
    expect(approvals.touchApproval.mock.calls).toHaveLength(0);
    expect(request.stepUp).toBeUndefined();
  });

  it('refuses once the session was signed out', async () => {
    approvals.isSessionActive.mockResolvedValue(false);
    const { context } = contextFor({ 'X-Step-Up-Token': TOKEN });
    expect(await statusOf(guard.canActivate(context))).toBe(403);
  });

  it('refuses access tokens without a session (sid)', async () => {
    const { context } = contextFor(
      { 'X-Step-Up-Token': TOKEN },
      { userId: 'user-1' },
    );
    expect(await statusOf(guard.canActivate(context))).toBe(403);
    expect(approvals.findApproval.mock.calls).toHaveLength(0);
  });

  it('requires AuthGuard to have run (401 without a user)', async () => {
    const { context } = contextFor({ 'X-Step-Up-Token': TOKEN }, null);
    expect(await statusOf(guard.canActivate(context))).toBe(401);
  });
});
