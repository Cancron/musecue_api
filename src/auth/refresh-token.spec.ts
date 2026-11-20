import { mock, mockDeep } from 'jest-mock-extended';
import { AuthService } from './auth.service';
import { AuthUtilsService } from './services/auth-utils.service';
import { AuthChallengeRepository } from './state/auth-challenge.repository';
import { RefreshSessionRepository } from './state/refresh-session.repository';
import { PrismaService } from '../common/services/prisma.service';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { EmailQueueService } from '../common/queues/email/email.queue';
import { TokenVersionCache } from '../infrastructure/token-version/token-version.cache';
import { mfaNotRequired } from '../../test/support/mfa-not-required';

describe('refresh-token failure and rotation boundaries', () => {
  const sessions = mock<RefreshSessionRepository>();
  const utils = mock<AuthUtilsService>();
  const prisma = mockDeep<PrismaService>();
  const service = new AuthService(
    utils,
    prisma,
    mock<ActivityLogService>(),
    sessions,
    mock<AuthChallengeRepository>(),
    mock<TokenVersionCache>(),
    mock<EmailQueueService>(),
    mock<CustomLoggerService>(),
    mfaNotRequired(),
  );
  const META = { ip: 'test', userAgent: 'test' };
  const active = {
    id: 'session-old',
    authId: 'owner',
    familyId: 'sign-in-session-1',
    tokenHash: 'hash',
    expiresAt: new Date(Date.now() + 3_600_000),
    revokedAt: null,
  };

  beforeEach(() => {
    jest.resetAllMocks();
    utils.verifyRefreshToken.mockReturnValue({
      userId: 'owner',
      jti: 'old',
    } as never);
    utils.hashToken.mockReturnValue('hash');
    utils.generateSecureId.mockReturnValue('new');
    sessions.find.mockResolvedValue(active);
    prisma.authUser.findUnique.mockResolvedValue({
      id: 'owner',
      status: 'ACTIVE',
      tokenVersion: 1,
    } as never);
    sessions.rotate.mockResolvedValue(true);
  });

  it('does not revoke sessions on database read outages', async () => {
    sessions.find.mockRejectedValue(new Error('offline'));
    await expect(service.refreshToken('test', META)).rejects.toMatchObject({
      status: 503,
    });
    expect(sessions.revoke.mock.calls).toHaveLength(0);
    expect(sessions.revokeAll.mock.calls).toHaveLength(0);
  });

  it('rejects reused tokens without revoking a concurrent winner', async () => {
    sessions.rotate.mockResolvedValue(false);
    await expect(service.refreshToken('test', META)).rejects.toMatchObject({
      status: 401,
      message: 'Refresh token has already been used or revoked',
    });
    expect(sessions.revoke.mock.calls).toHaveLength(0);
    expect(sessions.revokeAll.mock.calls).toHaveLength(0);
  });

  it.each([
    ['missing', null],
    ['rotated', { ...active, revokedAt: new Date() }],
    ['expired', { ...active, expiresAt: new Date(Date.now() - 1) }],
    ['owned by another user', { ...active, authId: 'someone-else' }],
  ])(
    'rejects a %s session without revoking other sessions',
    async (_label, stored) => {
      sessions.find.mockResolvedValue(stored);
      await expect(service.refreshToken('test', META)).rejects.toMatchObject({
        status: 401,
        message: 'Refresh token has been revoked. Please login again.',
      });
      expect(sessions.revokeAll.mock.calls).toHaveLength(0);
      expect(sessions.rotate.mock.calls).toHaveLength(0);
    },
  );

  it('revokes every session of the user when a token hash does not match', async () => {
    sessions.find.mockResolvedValue({ ...active, tokenHash: 'other' });
    await expect(service.refreshToken('test', META)).rejects.toMatchObject({
      status: 401,
      message: 'Invalid refresh token',
    });
    expect(sessions.revokeAll.mock.calls).toEqual([
      ['owner', 'REUSE_DETECTED'],
    ]);
    expect(sessions.rotate.mock.calls).toHaveLength(0);
  });

  it('revokes every session of an account that is no longer active', async () => {
    prisma.authUser.findUnique.mockResolvedValue({
      id: 'owner',
      status: 'BLOCKED',
      tokenVersion: 1,
    } as never);
    await expect(service.refreshToken('test', META)).rejects.toMatchObject({
      status: 401,
    });
    expect(sessions.revokeAll.mock.calls).toEqual([
      ['owner', 'ACCOUNT_INACTIVE'],
    ]);
  });

  it('does not return tokens if atomic persistence failed', async () => {
    sessions.rotate.mockRejectedValue(new Error('offline'));
    await expect(service.refreshToken('test', META)).rejects.toMatchObject({
      status: 503,
    });
  });

  it('rotates the presented session into its replacement in one operation', async () => {
    utils.createRefreshToken.mockReturnValue('new-refresh-token');
    utils.hashToken.mockImplementation((token) =>
      token === 'new-refresh-token' ? 'new-hash' : 'hash',
    );
    await service.refreshToken('test', {
      ...META,
      device: 'phone',
    });
    expect(sessions.rotate.mock.calls[0]?.[0]).toEqual({
      authId: 'owner',
      tokenId: 'old',
      tokenHash: 'hash',
    });
    expect(sessions.rotate.mock.calls[0]?.[1]).toMatchObject({
      authId: 'owner',
      tokenId: 'new',
      tokenHash: 'new-hash',
      ipAddress: 'test',
      userAgent: 'test',
      device: 'phone',
    });
    expect(sessions.revoke.mock.calls).toHaveLength(0);
    expect(sessions.revokeAll.mock.calls).toHaveLength(0);
  });
});
