import * as bcrypt from 'bcryptjs';
import { mock } from 'jest-mock-extended';
import {
  AccountStore,
  FakeRedis,
} from '../../../test/support/account-deletion-fakes';
import { AuthService } from '../../auth/auth.service';
import { AuthUtilsService } from '../../auth/services/auth-utils.service';
import { GoogleOAuthService } from '../../auth/services/google-oauth.service';
import config from '../../common/config/app.config';
import type { EmailQueueService } from '../../common/queues/email/email.queue';
import type { ActivityLogService } from '../../common/services/activity-log.service';
import type { CustomLoggerService } from '../../common/services/custom-logger.service';

const PASSWORD = 'correct horse battery staple';
const PREFIX = config.redis_cache_key_prefix;
const META = { ip: '203.0.113.1', userAgent: 'spec' };

/**
 * An account pending deletion must not be able to obtain new tokens through
 * any sign-in path, or the block could be undone.
 */
describe('Accounts pending deletion cannot sign in again (privacy)', () => {
  let store: AccountStore;
  let redis: FakeRedis;
  let utils: AuthUtilsService;
  let auth: AuthService;
  const originalSecrets = {
    access: config.jwt_access_secret,
    refresh: config.jwt_refresh_secret,
  };

  beforeAll(() => {
    config.jwt_access_secret = 'sign-in-block-access-secret';
    config.jwt_refresh_secret = 'sign-in-block-refresh-secret';
  });
  afterAll(() => {
    config.jwt_access_secret = originalSecrets.access;
    config.jwt_refresh_secret = originalSecrets.refresh;
  });

  beforeEach(() => {
    store = new AccountStore();
    redis = new FakeRedis();
    utils = new AuthUtilsService(redis.asService());
    auth = new AuthService(
      utils,
      store.prisma,
      mock<ActivityLogService>(),
      redis.asService(),
      mock<EmailQueueService>(),
      mock<CustomLoggerService>(),
    );
  });

  const user = (status: 'ACTIVE' | 'PENDING_DELETION') =>
    store.addUser({
      password: bcrypt.hashSync(PASSWORD, 4),
      status,
      ...({ verified: true } as object),
    });

  it('still lets an active account log in (control)', async () => {
    const active = user('ACTIVE');

    const session = await auth.login(
      { email: active.email, password: PASSWORD },
      META,
    );

    expect(session.accessToken).toEqual(expect.any(String));
  });

  it('refuses a password login with the generic invalid-credentials error', async () => {
    const pending = user('PENDING_DELETION');
    const createAccessToken = jest.spyOn(utils, 'createAccessToken');

    await expect(
      auth.login({ email: pending.email, password: PASSWORD }, META),
    ).rejects.toMatchObject({
      status: 401,
      message: 'Invalid email or password',
    });

    expect(createAccessToken.mock.calls).toHaveLength(0);
  });

  it('refuses to refresh a session and revokes the refresh token', async () => {
    const pending = user('PENDING_DELETION');
    const jti = 'device-a';
    const refreshToken = utils.createRefreshToken({ userId: pending.id }, jti);
    redis.put(`${PREFIX}:refresh:user:${pending.id}:${jti}`, {
      userId: pending.id,
      jti,
      tokenHash: utils.hashToken(refreshToken),
    });
    redis.put(`${PREFIX}:sessions:user:${pending.id}`, [jti]);

    await expect(auth.refreshToken(refreshToken, META)).rejects.toMatchObject({
      status: 401,
    });

    expect(
      redis.raw(`${PREFIX}:refresh:user:${pending.id}:${jti}`),
    ).toBeUndefined();
  });

  it('refuses a Google sign-in without issuing tokens', async () => {
    const pending = store.addUser({
      provider: 'google',
      status: 'PENDING_DELETION',
    });
    store.prisma.authUser.findFirst.mockResolvedValue({
      ...pending,
      role: 'USER',
      verified: true,
      providerId: 'google-sub',
    } as never);
    const google = new GoogleOAuthService(
      mock<CustomLoggerService>(),
      redis.asService(),
      store.prisma,
      mock<ActivityLogService>(),
      utils,
    );
    const createAccessToken = jest.spyOn(utils, 'createAccessToken');
    const findOrCreateUser = (
      google as unknown as {
        findOrCreateUser: (
          googleUser: object,
          meta: typeof META,
        ) => Promise<unknown>;
      }
    ).findOrCreateUser.bind(google) as (
      googleUser: object,
      meta: typeof META,
    ) => Promise<unknown>;

    await expect(
      findOrCreateUser(
        { sub: 'google-sub', email: pending.email, email_verified: true },
        META,
      ),
    ).rejects.toMatchObject({ status: 401 });

    expect(createAccessToken.mock.calls).toHaveLength(0);
  });
});
