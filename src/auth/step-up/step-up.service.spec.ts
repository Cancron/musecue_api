import { HttpException } from '@nestjs/common';
import type { StepUpAction, StepUpMethod } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { mock } from 'jest-mock-extended';
import { createHash } from 'node:crypto';
import type { Logger } from 'winston';
import { FakeMfaRepository } from '../../../test/support/fake-mfa-repository';
import { testCipher } from '../../../test/support/mfa-test-keys';
import config from '../../common/config/app.config';
import type { PrismaService } from '../../common/services/prisma.service';
import type { AuthService } from '../auth.service';
import { MfaVerificationService } from '../mfa/mfa-verification.service';
import { MfaService } from '../mfa/mfa.service';
import { totpCode } from '../mfa/mfa-totp';
import type { GoogleOAuthService } from '../services/google-oauth.service';
import type { OAuthStateRepository } from '../state/oauth-state.repository';
import type { RefreshSessionRepository } from '../state/refresh-session.repository';
import { StepUpService } from './step-up.service';

// Recovery codes use salted scrypt (deliberately slow).
jest.setTimeout(30_000);

const PASSWORD = 'correct horse battery staple';
const HASH = bcrypt.hashSync(PASSWORD, 4);
const SID = 'session-1';
const META = { ip: '203.0.113.8', userAgent: 'jest' };
/** The start of a 30-second TOTP step. */
const T0 = new Date(Math.floor(Date.UTC(2026, 10, 25, 9) / 30_000) * 30_000);
const plus = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

interface User {
  email: string;
  status: 'ACTIVE' | 'BLOCKED';
  password: string;
  provider: string;
  providerId: string | null;
  security: { id: string; failedAttempts: number; lockExpiresAt: Date | null };
}

interface Approval {
  authId: string;
  sessionId: string;
  action: StepUpAction;
  method: StepUpMethod;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return { status: error.getStatus(), message: error.message };
  }
  throw new Error('Expected the call to be rejected');
}

describe('StepUpService', () => {
  const originalSecret = config.jwt_refresh_secret;
  let users: Map<string, User>;
  let approvals: Approval[];
  let activeSessions: Set<string>;
  let states: Map<string, { provider: string; data: unknown; expiresAt: Date }>;
  let repo: FakeMfaRepository;
  let auth: ReturnType<typeof mock<AuthService>>;
  let recordFailure: jest.Mock;
  let google: ReturnType<typeof mock<GoogleOAuthService>>;
  let logger: ReturnType<typeof mock<Logger>>;
  let enrollment: MfaService;
  let service: StepUpService;

  beforeAll(() => {
    config.jwt_refresh_secret = ''; // never needed by step-up or MFA
    process.env.GOOGLE_CLIENT_ID = 'client.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    process.env.GOOGLE_REDIRECT_URI =
      'https://api.example.com/auth/google/callback';
    process.env.GOOGLE_STEP_UP_REDIRECT_URI = 'https://app.example.com/step-up';
  });
  afterAll(() => {
    config.jwt_refresh_secret = originalSecret;
  });

  beforeEach(() => {
    users = new Map();
    approvals = [];
    activeSessions = new Set([`alice:${SID}`, `gina:${SID}`, `paul:${SID}`]);
    states = new Map();
    const prisma = {
      authUser: {
        findUnique: ({ where }: { where: { id: string } }) => {
          const u = users.get(where.id);
          return Promise.resolve(
            u && {
              email: u.email,
              status: u.status,
              password: u.password,
              provider: u.provider,
              providerId: u.providerId,
              authSecurity: {
                mfaEnabled: repo.accounts.get(where.id)?.mfaEnabled ?? false,
              },
            },
          );
        },
        findUniqueOrThrow: ({ where }: { where: { id: string } }) => {
          const u = users.get(where.id)!;
          return Promise.resolve({
            password: u.password,
            authSecurity: u.security,
          });
        },
      },
      authSecurity: {
        update: ({ data }: { data: { failedAttempts: number } }) => {
          for (const u of users.values()) {
            u.security.failedAttempts = data.failedAttempts;
          }
          return Promise.resolve({});
        },
      },
      stepUpApproval: {
        create: ({ data }: { data: Approval }) => {
          approvals.push(data);
          return Promise.resolve(data);
        },
      },
    };
    repo = new FakeMfaRepository();
    repo.txClient = prisma;
    for (const id of ['alice', 'paul', 'gina']) repo.addAccount(id);
    users.set('paul', user({ email: 'paul@example.com' }));
    users.set('alice', user({ email: 'alice@example.com' }));
    users.set(
      'gina',
      user({
        email: 'gina@example.com',
        password: '',
        provider: 'google',
        providerId: 'google-sub-gina',
      }),
    );

    const sessions = {
      isSessionActive: (authId: string, sid: string) =>
        Promise.resolve(activeSessions.has(`${authId}:${sid}`)),
    } as unknown as RefreshSessionRepository;
    const oauthStates = {
      create: (
        provider: string,
        state: string,
        data: unknown,
        ttlSeconds: number,
        now: Date,
      ) => {
        states.set(state, {
          provider,
          data,
          expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
        });
        return Promise.resolve();
      },
      consume: (provider: string, state: string, now: Date) => {
        const entry = states.get(state);
        states.delete(state);
        return Promise.resolve(
          entry && entry.provider === provider && entry.expiresAt > now
            ? entry.data
            : null,
        );
      },
    } as unknown as OAuthStateRepository;

    recordFailure = jest.fn().mockResolvedValue(undefined);
    auth = mock<AuthService>({
      recordFailedPasswordConfirmation: recordFailure,
    });
    google = mock<GoogleOAuthService>();
    logger = mock<Logger>();
    const cipher = testCipher();
    enrollment = new MfaService(repo.asRepository(), cipher, logger);
    service = new StepUpService(
      prisma as unknown as PrismaService,
      sessions,
      repo.asRepository(),
      new MfaVerificationService(repo.asRepository(), cipher, logger),
      auth,
      google,
      oauthStates,
      logger,
    );
  });

  function user(overrides: Partial<User> = {}): User {
    return {
      email: 'x@example.com',
      status: 'ACTIVE',
      password: HASH,
      provider: 'local',
      providerId: null,
      security: { id: 'sec', failedAttempts: 0, lockExpiresAt: null },
      ...overrides,
    };
  }

  /** Enables MFA for Alice at T0. */
  async function enableMfa() {
    const { secret } = await enrollment.startEnrollment('alice', T0);
    const { recoveryCodes } = await enrollment.confirmEnrollment(
      'alice',
      totpCode(secret, T0),
      META,
      T0,
    );
    return { secret, recoveryCodes };
  }

  const approve = (
    userId: string,
    proof: Record<string, unknown>,
    now = plus(MIN),
    // null: a token without a session (not `undefined`: the default applies)
    sid: string | null = SID,
  ) =>
    service.approve(
      { userId, sid: sid ?? undefined },
      { action: 'SUBSCRIPTION_CANCEL', ...proof },
      META,
      now,
    );

  describe('requirement', () => {
    it('is decided by the account: MFA, password, or Google', async () => {
      await enableMfa();
      await expect(service.requirementFor('alice')).resolves.toBe('mfa');
      await expect(service.requirementFor('paul')).resolves.toBe('password');
      await expect(service.requirementFor('gina')).resolves.toBe('google');
    });
  });

  describe('MFA users', () => {
    it('approve with the authenticator code: ten minutes, this session and action', async () => {
      const { secret } = await enableMfa();
      const now = plus(MIN);

      const view = await approve('alice', { code: totpCode(secret, now) }, now);

      expect(view).toEqual({
        stepUpToken: expect.stringMatching(
          /^stup_[A-Za-z0-9_-]{43}$/,
        ) as string,
        action: 'SUBSCRIPTION_CANCEL',
        method: 'TOTP',
        expiresAt: plus(11 * MIN),
      });
      expect(approvals).toEqual([
        {
          authId: 'alice',
          sessionId: SID,
          action: 'SUBSCRIPTION_CANCEL',
          method: 'TOTP',
          tokenHash: sha256(view.stepUpToken),
          createdAt: now,
          expiresAt: plus(11 * MIN),
        },
      ]);
    });

    it('approve with an unused recovery code, which is consumed', async () => {
      const { recoveryCodes } = await enableMfa();

      await expect(
        approve('alice', { recoveryCode: recoveryCodes[0] }),
      ).resolves.toMatchObject({ method: 'RECOVERY_CODE' });
      expect(repo.unusedCodes('alice')).toHaveLength(9);
      await expect(
        rejection(approve('alice', { recoveryCode: recoveryCodes[0] })),
      ).resolves.toMatchObject({ status: 400 });
    });

    it('never accept the password, a used or wrong code', async () => {
      const { secret } = await enableMfa();
      await expect(
        rejection(approve('alice', { password: PASSWORD })),
      ).resolves.toMatchObject({ status: 400 });
      // The code that enabled MFA was used already.
      await expect(
        rejection(
          approve('alice', { code: totpCode(secret, T0) }, plus(10_000)),
        ),
      ).resolves.toEqual({
        status: 400,
        message: 'Invalid MFA code. 4 attempt(s) remaining.',
      });
      await expect(
        rejection(
          approve('alice', { code: '123456', recoveryCode: 'AAAAA-AAAAA' }),
        ),
      ).resolves.toMatchObject({ status: 400 });
      expect(approvals).toEqual([]);
    });

    it('share the MFA lockout', async () => {
      await enableMfa();
      for (let i = 0; i < 4; i++) {
        await rejection(approve('alice', { recoveryCode: 'AAAAA-AAAAA' }));
      }
      await expect(
        rejection(approve('alice', { recoveryCode: 'AAAAA-AAAAA' })),
      ).resolves.toMatchObject({ status: 429 });
    });
  });

  describe('password users without MFA', () => {
    it('approve with the current password', async () => {
      await expect(
        approve('paul', { password: PASSWORD }),
      ).resolves.toMatchObject({
        method: 'PASSWORD',
        action: 'SUBSCRIPTION_CANCEL',
      });
      expect(approvals).toHaveLength(1);
    });

    it('are refused with a wrong password, which counts toward the lockout', async () => {
      await expect(
        rejection(approve('paul', { password: 'wrong' })),
      ).resolves.toEqual({ status: 403, message: 'Incorrect password' });
      expect(recordFailure).toHaveBeenCalledWith(
        'paul',
        0,
        expect.objectContaining({ ip: META.ip }),
      );
      expect(approvals).toEqual([]);
    });

    it('are refused while the account is locked, without checking', async () => {
      users.get('paul')!.security.lockExpiresAt = plus(30 * MIN);
      await expect(
        rejection(approve('paul', { password: PASSWORD })),
      ).resolves.toMatchObject({ status: 403 });
      expect(approvals).toEqual([]);
    });

    it('cannot use MFA codes', async () => {
      await expect(
        rejection(approve('paul', { code: '123456' })),
      ).resolves.toMatchObject({ status: 400 });
    });
  });

  describe('sessions', () => {
    it('refuse a token without a session (issued before sessions existed)', async () => {
      await expect(
        rejection(approve('paul', { password: PASSWORD }, plus(MIN), null)),
      ).resolves.toMatchObject({ status: 401 });
    });

    it('refuse an ended session (logout)', async () => {
      activeSessions.delete(`paul:${SID}`);
      await expect(
        rejection(approve('paul', { password: PASSWORD })),
      ).resolves.toMatchObject({ status: 401 });
    });
  });

  describe('Google-only users', () => {
    const principal = { userId: 'gina', sid: SID };

    async function start(action: StepUpAction = 'ACCOUNT_DELETION') {
      return service.startGoogle(principal, action, plus(MIN));
    }

    /** What Google returns for a sign-in of `sub` with `nonce`. */
    function googleSignsIn(
      claims: { sub?: string; nonce?: string; auth_time?: number } = {},
    ) {
      google.exchangeCodeForTokens.mockResolvedValue({
        access_token: 'ya29',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'openid',
        id_token: 'id-token',
      });
      google.verifyIdToken.mockResolvedValue({
        iss: 'https://accounts.google.com',
        azp: 'client',
        aud: 'client',
        sub: claims.sub ?? 'google-sub-gina',
        email: 'gina@example.com',
        email_verified: true,
        nonce: claims.nonce,
        auth_time: claims.auth_time,
        iat: 0,
        exp: 0,
      });
    }

    it('must reauthenticate with Google (no password to check)', async () => {
      await expect(
        rejection(approve('gina', { password: 'anything' })),
      ).resolves.toMatchObject({ status: 400 });
    });

    it('get a one-time Google sign-in bound to user, session and action', async () => {
      const started = await start();

      const url = new URL(started.url);
      expect(url.origin + url.pathname).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      );
      const params = Object.fromEntries(url.searchParams);
      expect(params).toMatchObject({
        redirect_uri: 'https://app.example.com/step-up',
        state: started.state,
        code_challenge_method: 'S256',
        prompt: 'select_account',
        max_age: '0',
        login_hint: 'gina@example.com',
      });
      expect(params.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(started.expiresAt).toEqual(plus(11 * MIN));
      expect(states.get(started.state)!.data).toMatchObject({
        authId: 'gina',
        sessionId: SID,
        action: 'ACCOUNT_DELETION',
        nonce: params.nonce,
      });
    });

    it('approve the action on a matching callback', async () => {
      const started = await start();
      const nonce = new URL(started.url).searchParams.get('nonce')!;
      googleSignsIn({ nonce });

      const view = await service.completeGoogle(
        principal,
        { code: '4/code', state: started.state },
        plus(2 * MIN),
      );

      expect(view).toMatchObject({
        action: 'ACCOUNT_DELETION',
        method: 'GOOGLE',
      });
      expect(approvals[0]).toMatchObject({ authId: 'gina', sessionId: SID });
      expect(google.exchangeCodeForTokens.mock.calls).toEqual([
        ['4/code', expect.any(String), 'https://app.example.com/step-up'],
      ]);
    });

    it.each([
      ['a repeated callback', 'repeat'],
      ['an expired challenge', 'expired'],
      ['another session', 'session'],
      ['another user', 'user'],
      ['a token for another nonce', 'nonce'],
      ['another Google account', 'identity'],
      ['a sign-in older than the challenge', 'stale'],
    ])('refuse %s (403), approving nothing', async (_, variant) => {
      const started = await start();
      const nonce = new URL(started.url).searchParams.get('nonce')!;
      googleSignsIn({
        nonce: variant === 'nonce' ? 'another-nonce' : nonce,
        sub: variant === 'identity' ? 'google-sub-someone-else' : undefined,
        auth_time:
          variant === 'stale'
            ? Math.floor(plus(-MIN).getTime() / 1000) - 1
            : undefined,
      });
      let who = principal;
      if (variant === 'session') who = { userId: 'gina', sid: 'session-2' };
      if (variant === 'user') who = { userId: 'paul', sid: SID };
      if (variant === 'session') activeSessions.add('gina:session-2');
      if (variant === 'repeat') {
        await service.completeGoogle(
          principal,
          { code: 'c', state: started.state },
          plus(2 * MIN),
        );
        approvals.length = 0;
      }
      const when = variant === 'expired' ? plus(11 * MIN) : plus(2 * MIN);

      await expect(
        rejection(
          service.completeGoogle(
            who,
            { code: 'c', state: started.state },
            when,
          ),
        ),
      ).resolves.toMatchObject({ status: 403 });
      expect(approvals).toEqual([]);
    });

    it('is not offered to accounts with a password or MFA', async () => {
      await expect(
        rejection(
          service.startGoogle(
            { userId: 'paul', sid: SID },
            'DATA_EXPORT',
            plus(MIN),
          ),
        ),
      ).resolves.toMatchObject({ status: 400 });
    });
  });

  it('never logs an approval token, a code or a password', async () => {
    const { secret } = await enableMfa();
    const code = totpCode(secret, plus(MIN));
    const a = await approve('alice', { code });
    const p = await approve('paul', { password: PASSWORD });
    await rejection(approve('paul', { password: 'wrong-password' }));

    const logged = JSON.stringify([
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls,
    ]);
    for (const value of [
      a.stepUpToken,
      p.stepUpToken,
      code,
      PASSWORD,
      'wrong-password',
    ]) {
      expect(logged).not.toContain(value);
    }
  });
});
