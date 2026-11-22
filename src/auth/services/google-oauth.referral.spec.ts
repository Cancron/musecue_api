import { mock, mockDeep } from 'jest-mock-extended';
import AppError from '../../common/errors/app.error';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';
import {
  REFERRAL_MESSAGES,
  ReferralRegistrationService,
} from '../../referrals/referral-registration.service';
import type { IGoogleOAuthLoginResponse } from '../interfaces/google-oauth.interface';
import { OAuthStateRepository } from '../state/oauth-state.repository';
import { RefreshSessionRepository } from '../state/refresh-session.repository';
import { AuthUtilsService } from './auth-utils.service';
import { GoogleOAuthService } from './google-oauth.service';

/**
 * Referral codes in Google sign-up: validated when the sign-in starts,
 * registered only when the callback creates a new account (in the same
 * transaction), never applied to an existing account.
 */
describe('GoogleOAuthService referrals', () => {
  const prisma = mockDeep<PrismaService>();
  const states = mock<OAuthStateRepository>();
  const referrals = mock<ReferralRegistrationService>();
  const service = new GoogleOAuthService(
    mock<CustomLoggerService>(),
    states,
    mock<RefreshSessionRepository>(),
    prisma,
    mock<ActivityLogService>(),
    mock<AuthUtilsService>(),
    referrals,
  );
  const META = { ip: '203.0.113.5', userAgent: 'jest' };
  const GOOGLE_USER = {
    sub: 'google-sub-1',
    email: 'new.person@example.com',
    email_verified: true,
    name: 'New Person',
  };
  const tokens = {
    accessToken: 'a',
    refreshToken: 'r',
    user: {
      id: 'new-user',
      email: GOOGLE_USER.email,
      username: 'newperson',
      role: 'USER',
      verified: true,
      provider: 'google',
      providerId: GOOGLE_USER.sub,
    },
    expiresIn: 900,
    isNewUser: true,
  };

  type Internals = {
    findOrCreateUser: (
      googleUser: object,
      meta: typeof META,
      referralCode?: string,
    ) => Promise<IGoogleOAuthLoginResponse>;
    generateTokensForUser: (...args: unknown[]) => Promise<unknown>;
  };
  const internals = service as unknown as Internals;
  const callFindOrCreateUser = internals.findOrCreateUser.bind(
    service,
  ) as Internals['findOrCreateUser'];
  const findOrCreateUser = (code?: string) =>
    callFindOrCreateUser(GOOGLE_USER, META, code);

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_REDIRECT_URI =
      'http://localhost:5000/auth/google/callback';
    prisma.$transaction.mockImplementation(((
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => callback(prisma)) as never);
    prisma.authUser.create.mockResolvedValue(tokens.user as never);
    jest
      .spyOn(internals, 'generateTokensForUser')
      .mockImplementation((_user, _meta, isNewUser) =>
        Promise.resolve({ ...tokens, isNewUser }),
      );
  });

  describe('starting the sign-in', () => {
    it('stores a valid code (normalized) with the OAuth state', async () => {
      referrals.findReferrer.mockResolvedValue({
        code: 'FRIEND42',
        referrerAuthId: 'referrer',
        referrerEmail: 'referrer@example.com',
      });

      await service.getAuthorizationUrl(META, undefined, ' friend42 ');

      expect(referrals.findReferrer.mock.calls).toEqual([[' friend42 ']]);
      expect(states.create.mock.calls[0]?.[2]).toMatchObject({
        referralCode: 'FRIEND42',
      });
    });

    it('refuses an invalid code before anything is stored', async () => {
      referrals.findReferrer.mockRejectedValue(
        AppError.badRequest(REFERRAL_MESSAGES.INVALID_CODE),
      );

      await expect(
        service.getAuthorizationUrl(META, undefined, 'NOSUCHCODE'),
      ).rejects.toMatchObject({
        status: 400,
        message: 'Invalid referral code',
      });
      expect(states.create.mock.calls).toHaveLength(0);
    });

    it('stores no code when none is given', async () => {
      await service.getAuthorizationUrl(META);
      expect(states.create.mock.calls[0]?.[2]).not.toHaveProperty(
        'referralCode',
      );
      expect(referrals.findReferrer.mock.calls).toHaveLength(0);
    });
  });

  describe('the callback', () => {
    it('registers the referral with a new account, in the same transaction', async () => {
      prisma.authUser.findFirst.mockResolvedValue(null);
      prisma.authUser.findUnique.mockResolvedValue(null);

      const result = await findOrCreateUser('FRIEND42');

      expect(referrals.assertUsableAtSignup.mock.calls).toEqual([
        ['FRIEND42', GOOGLE_USER.email],
      ]);
      expect(referrals.registerAtSignup.mock.calls).toEqual([
        [
          prisma,
          { authId: 'new-user', email: GOOGLE_USER.email, code: 'FRIEND42' },
        ],
      ]);
      expect(result).toMatchObject({
        isNewUser: true,
        referral: { applied: true },
      });
    });

    it('creates no account when the referral is refused (self-referral or duplicate)', async () => {
      prisma.authUser.findFirst.mockResolvedValue(null);
      prisma.authUser.findUnique.mockResolvedValue(null);
      referrals.assertUsableAtSignup.mockRejectedValue(
        AppError.badRequest(REFERRAL_MESSAGES.SELF_REFERRAL),
      );

      await expect(findOrCreateUser('OWNCODE1')).rejects.toMatchObject({
        status: 400,
        message: 'You cannot use your own referral code',
      });
      expect(prisma.authUser.create.mock.calls).toHaveLength(0);
      expect(referrals.registerAtSignup.mock.calls).toHaveLength(0);
    });

    it('never adds a referral to an existing account (retrospective)', async () => {
      prisma.authUser.findFirst.mockResolvedValue({
        ...tokens.user,
        status: 'ACTIVE',
        tokenVersion: 1,
      } as never);

      const result = await findOrCreateUser('FRIEND42');

      expect(result).toMatchObject({
        isNewUser: false,
        referral: { applied: false, reason: 'EXISTING_ACCOUNT' },
      });
      expect(referrals.assertUsableAtSignup.mock.calls).toHaveLength(0);
      expect(referrals.registerAtSignup.mock.calls).toHaveLength(0);
      expect(prisma.authUser.create.mock.calls).toHaveLength(0);
    });

    it('reports nothing about referrals without a code', async () => {
      prisma.authUser.findFirst.mockResolvedValue(null);
      prisma.authUser.findUnique.mockResolvedValue(null);
      const result = await findOrCreateUser();
      expect(result).not.toHaveProperty('referral');
      expect(referrals.registerAtSignup.mock.calls).toHaveLength(0);
    });
  });
});
