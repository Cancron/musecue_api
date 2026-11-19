import * as bcrypt from 'bcryptjs';
import { mock } from 'jest-mock-extended';
import {
  AccountStore,
  FakeAuthChallenges,
  FakeRateLimits,
  FakeRefreshSessions,
  FakeTokenVersionCache,
} from '../../../test/support/account-deletion-fakes';
import { AuthService } from '../../auth/auth.service';
import { AuthUtilsService } from '../../auth/services/auth-utils.service';
import { GoogleOAuthService } from '../../auth/services/google-oauth.service';
import config from '../../common/config/app.config';
import type { EmailQueueService } from '../../common/queues/email/email.queue';
import type { ActivityLogService } from '../../common/services/activity-log.service';
import type { CustomLoggerService } from '../../common/services/custom-logger.service';
import type { OAuthStateRepository } from '../../auth/state/oauth-state.repository';
import { mfaNotRequired } from '../../../test/support/mfa-not-required';

const PASSWORD = 'correct horse battery staple';
const META = { ip: '203.0.113.1', userAgent: 'spec' };

/**
 * An account pending deletion must not be able to obtain new tokens through
 * any sign-in path, or the block could be undone.
 */
describe('Accounts pending deletion cannot sign in again (privacy)', () => {
  let store: AccountStore;
  let sessions: FakeRefreshSessions;
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
    sessions = new FakeRefreshSessions();
    utils = new AuthUtilsService(new FakeRateLimits());
    auth = new AuthService(
      utils,
      store.prisma,
      mock<ActivityLogService>(),
      sessions.asRepository(),
      new FakeAuthChallenges(store.prisma).asRepository(),
      new FakeTokenVersionCache(),
      mock<EmailQueueService>(),
      mock<CustomLoggerService>(),
      mfaNotRequired(),
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

    expect(session).toMatchObject({
      mfaRequired: false,
      accessToken: expect.any(String) as string,
    });
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
    sessions.add(pending.id, jti, utils.hashToken(refreshToken));

    await expect(auth.refreshToken(refreshToken, META)).rejects.toMatchObject({
      status: 401,
    });

    expect(sessions.activeOf(pending.id)).toEqual([]);
    expect(sessions.sessions.get(jti)?.revokedReason).toBe('ACCOUNT_INACTIVE');
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
      mock<OAuthStateRepository>(),
      sessions.asRepository(),
      store.prisma,
      mock<ActivityLogService>(),
      utils,
      mfaNotRequired(),
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
