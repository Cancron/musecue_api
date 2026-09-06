import { mock, mockDeep } from 'jest-mock-extended';
import { AuthService } from './auth.service';
import { AuthUtilsService } from './services/auth-utils.service';
import { PrismaService } from '../common/services/prisma.service';
import { RedisService } from '../common/services/redis.service';
import { ActivityLogService } from '../common/services/activity-log.service';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { EmailQueueService } from '../common/queues/email/email.queue';

describe('refresh-token failure and rotation boundaries', () => {
  const redis = mock<RedisService>();
  const utils = mock<AuthUtilsService>();
  const prisma = mockDeep<PrismaService>();
  const service = new AuthService(
    utils,
    prisma,
    mock<ActivityLogService>(),
    redis,
    mock<EmailQueueService>(),
    mock<CustomLoggerService>(),
  );
  beforeEach(() => {
    jest.resetAllMocks();
    utils.verifyRefreshToken.mockReturnValue({
      userId: 'owner',
      jti: 'old',
    } as never);
    utils.hashToken.mockReturnValue('hash');
    utils.generateSecureId.mockReturnValue('new');
    redis.getRequired.mockResolvedValue({ tokenHash: 'hash' });
    prisma.authUser.findUnique.mockResolvedValue({
      id: 'owner',
      status: 'ACTIVE',
      tokenVersion: 1,
    } as never);
    redis.rotateRefreshToken.mockResolvedValue(true);
  });
  it('does not revoke sessions on Redis read outages', async () => {
    redis.getRequired.mockRejectedValue(new Error('offline'));
    await expect(
      service.refreshToken('test', { ip: 'test', userAgent: 'test' }),
    ).rejects.toMatchObject({ status: 503 });
    expect(redis.del.mock.calls).toHaveLength(0);
    expect(redis.pruneRefreshSessions.mock.calls).toHaveLength(0);
  });
  it('rejects reused tokens without revoking a concurrent winner', async () => {
    redis.rotateRefreshToken.mockResolvedValue(false);
    await expect(
      service.refreshToken('test', { ip: 'test', userAgent: 'test' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(redis.del.mock.calls).toHaveLength(0);
    expect(redis.pruneRefreshSessions.mock.calls).toHaveLength(0);
  });
  it('rejects an already-consumed token without revoking other sessions', async () => {
    redis.getRequired.mockResolvedValue(null);
    await expect(
      service.refreshToken('test', { ip: 'test', userAgent: 'test' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(redis.pruneRefreshSessions.mock.calls).toHaveLength(0);
    expect(redis.rotateRefreshToken.mock.calls).toHaveLength(0);
  });
  it('does not return tokens if atomic persistence failed', async () => {
    redis.rotateRefreshToken.mockRejectedValue(new Error('offline'));
    await expect(
      service.refreshToken('test', { ip: 'test', userAgent: 'test' }),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('rotates the token and session index in one operation', async () => {
    await service.refreshToken('test', { ip: 'test', userAgent: 'test' });
    expect(redis.rotateRefreshToken.mock.calls[0]?.[0]).toMatchObject({
      expectedHash: 'hash',
      oldJti: 'old',
      newJti: 'new',
    });
    expect(redis.set.mock.calls).toHaveLength(0);
    expect(redis.del.mock.calls).toHaveLength(0);
  });
});
