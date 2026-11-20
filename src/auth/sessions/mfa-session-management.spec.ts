import type { Prisma } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import type { Logger } from 'winston';
import type { PrismaService } from '../../common/services/prisma.service';
import type { TokenVersionCache } from '../../infrastructure/token-version/token-version.cache';
import type { SecurityEventLog } from '../security-events/security-event.log';
import type {
  ActiveSession,
  RefreshSessionRepository,
} from '../state/refresh-session.repository';
import { SessionsService } from './sessions.service';

const NOW = new Date('2026-11-27T12:00:00.000Z');
const CONTEXT = { ip: '203.0.113.7', userAgent: 'jest', sessionId: 'current' };

const session = (id: string): ActiveSession => ({
  id,
  signedInAt: NOW,
  lastActiveAt: NOW,
  expiresAt: new Date(NOW.getTime() + 7 * 24 * 3600_000),
  ipAddress: '203.0.113.7',
  userAgent: 'jest',
  device: null,
  mfaVerifiedAt: null,
});

/**
 * Active-session management (the session list, ending sessions) and how it
 * is recorded; the routes and PostgreSQL are covered by
 * test/mfa-sessions.e2e-spec.ts.
 */
describe('SessionsService (session management next to MFA)', () => {
  const tx = {
    authUser: {
      update: jest.fn(() => Promise.resolve({ tokenVersion: 8 })),
    },
  };
  const prisma = {
    $transaction: jest.fn(
      (work: (client: Prisma.TransactionClient) => Promise<unknown>) =>
        work(tx as unknown as Prisma.TransactionClient),
    ),
  };
  const repository = mock<RefreshSessionRepository>();
  const events = mock<SecurityEventLog>();
  const tokenVersions = mock<TokenVersionCache>();
  let service: SessionsService;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    jest.clearAllMocks();
    repository.revokeSessions.mockReset();
    events.record.mockReset();
    tokenVersions.publish.mockReset();
    tokenVersions.invalidate.mockReset();
    events.record.mockResolvedValue(undefined);
    tokenVersions.publish.mockResolvedValue(undefined);
    service = new SessionsService(
      prisma as unknown as PrismaService,
      repository,
      events,
      tokenVersions,
      mock<Logger>(),
    );
  });
  afterEach(() => jest.useRealTimers());

  const me = { userId: 'alice', sid: 'current' };

  it('lists the user’s own active sessions and marks the current one', async () => {
    repository.listActive.mockResolvedValue([
      session('other'),
      session('current'),
    ]);

    const views = await service.list(me);

    expect(repository.listActive.mock.calls).toContainEqual(['alice']);
    expect(views.map((v) => [v.id, v.current])).toEqual([
      ['other', false],
      ['current', true],
    ]);
  });

  it('a token without a session has no current session', async () => {
    repository.listActive.mockResolvedValue([session('a')]);

    const [view] = await service.list({ userId: 'alice' });

    expect(view.current).toBe(false);
  });

  describe('ending one session', () => {
    it('revokes only that session of the token user, and records it in the same transaction', async () => {
      repository.revokeSessions.mockResolvedValue(['other']);

      await expect(service.revokeOne(me, 'other', CONTEXT)).resolves.toEqual({
        revoked: 1,
        sessionIds: ['other'],
      });

      expect(repository.revokeSessions.mock.calls).toContainEqual([
        'alice',
        { only: 'other' },
        'USER_REVOKED',
        NOW,
        tx,
      ]);
      expect(events.record.mock.calls).toContainEqual([
        tx,
        {
          authId: 'alice',
          type: 'SESSION_REVOKED',
          context: CONTEXT,
          details: {
            scope: 'one',
            count: 1,
            sessionIds: ['other'],
            includesCurrentSession: false,
          },
          now: NOW,
        },
      ]);
      expect(tx.authUser.update.mock.calls).toHaveLength(0);
    });

    it('answers 404 for a session that is not the user’s active one, recording nothing', async () => {
      repository.revokeSessions.mockResolvedValue([]);

      await expect(
        service.revokeOne(me, 'someone-elses', CONTEXT),
      ).rejects.toMatchObject({ message: 'Session not found', status: 404 });

      expect(events.record.mock.calls).toHaveLength(0);
    });

    it('notes when the current session itself was ended', async () => {
      repository.revokeSessions.mockResolvedValue(['current']);

      await service.revokeOne(me, 'current', CONTEXT);

      expect(events.record.mock.calls[0][1].details).toMatchObject({
        includesCurrentSession: true,
      });
    });
  });

  describe('ending the other sessions', () => {
    it('keeps the current session', async () => {
      repository.revokeSessions.mockResolvedValue(['a', 'b']);

      await expect(service.revokeOthers(me, CONTEXT)).resolves.toEqual({
        revoked: 2,
        sessionIds: ['a', 'b'],
      });

      expect(repository.revokeSessions.mock.calls).toContainEqual([
        'alice',
        { except: 'current' },
        'USER_REVOKED',
        NOW,
        tx,
      ]);
    });

    it('needs an identified session (otherwise it would end all of them)', async () => {
      await expect(
        service.revokeOthers({ userId: 'alice' }, CONTEXT),
      ).rejects.toMatchObject({
        message: 'This session cannot be identified. Please sign in again.',
        status: 401,
      });

      expect(repository.revokeSessions.mock.calls).toHaveLength(0);
    });

    it('records nothing when there was nothing to end', async () => {
      repository.revokeSessions.mockResolvedValue([]);

      await expect(service.revokeOthers(me, CONTEXT)).resolves.toEqual({
        revoked: 0,
        sessionIds: [],
      });
      expect(events.record.mock.calls).toHaveLength(0);
    });
  });

  describe('ending all sessions', () => {
    it('ends every session and changes the token version (all access tokens)', async () => {
      repository.revokeSessions.mockResolvedValue(['current', 'other']);

      await service.revokeAll(me, CONTEXT);

      expect(repository.revokeSessions.mock.calls).toContainEqual([
        'alice',
        {},
        'USER_REVOKED',
        NOW,
        tx,
      ]);
      expect(tx.authUser.update.mock.calls).toContainEqual([
        {
          where: { id: 'alice' },
          data: { tokenVersion: { increment: 1 } },
          select: { tokenVersion: true },
        },
      ]);
      expect(tokenVersions.publish.mock.calls).toContainEqual(['alice', 8]);
      expect(events.record.mock.calls[0][1].details).toEqual({
        scope: 'all',
        count: 2,
        sessionIds: ['current', 'other'],
        includesCurrentSession: true,
      });
    });

    it('is recorded as logout-all for POST /auth/logout-all, even without sessions', async () => {
      repository.revokeSessions.mockResolvedValue([]);

      await service.revokeAll(me, CONTEXT, 'logout_all');

      expect(repository.revokeSessions.mock.calls[0][2]).toBe('LOGOUT_ALL');
      expect(events.record.mock.calls[0][1].details).toMatchObject({
        scope: 'logout_all',
        count: 0,
      });
    });

    it('drops the cached token version when it cannot be published', async () => {
      repository.revokeSessions.mockResolvedValue(['current']);
      tokenVersions.publish.mockRejectedValue(new Error('redis down'));
      tokenVersions.invalidate.mockResolvedValue(undefined);

      await service.revokeAll(me, CONTEXT);

      expect(tokenVersions.invalidate.mock.calls).toContainEqual(['alice']);
    });
  });

  it('never puts a token into the history', async () => {
    repository.revokeSessions.mockResolvedValue(['other']);

    await service.revokeOne(me, 'other', CONTEXT);

    const recorded = JSON.stringify(events.record.mock.calls);
    expect(recorded).not.toMatch(/token|secret|hash/i);
  });
});
