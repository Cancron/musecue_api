import type { ExecutionContext } from '@nestjs/common';
import type { PrismaService } from '../../common/services/prisma.service';
import { AdminMfaGuard } from './admin-mfa.guard';

const NOW = new Date('2026-11-27T12:00:00.000Z');
const HOUR = 60 * 60_000;

interface Session {
  authId: string;
  familyId: string;
  revokedAt: Date | null;
  expiresAt: Date;
  mfaVerifiedAt: Date | null;
  mfaVerifiedWith: string | null;
}

describe('AdminMfaGuard', () => {
  let security: {
    mfaEnabled: boolean;
    mfaMethod: string | null;
    mfaSecret: string | null;
  } | null;
  let sessions: Session[];
  let guard: AdminMfaGuard;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    security = { mfaEnabled: true, mfaMethod: 'totp', mfaSecret: 'mfa2.x' };
    sessions = [
      {
        authId: 'admin',
        familyId: 'session-1',
        revokedAt: null,
        expiresAt: new Date(NOW.getTime() + 24 * HOUR),
        mfaVerifiedAt: new Date(NOW.getTime() - HOUR),
        mfaVerifiedWith: 'totp',
      },
    ];
    // Applies the guard's own query conditions to the sessions above.
    const prisma = {
      authSecurity: { findUnique: () => Promise.resolve(security) },
      refreshSession: {
        count: ({
          where,
        }: {
          where: {
            authId: string;
            familyId: string;
            expiresAt: { gt: Date };
            mfaVerifiedAt: { gte: Date };
            mfaVerifiedWith: { in: string[] };
          };
        }) =>
          Promise.resolve(
            sessions.filter(
              (s) =>
                s.authId === where.authId &&
                s.familyId === where.familyId &&
                s.revokedAt === null &&
                s.expiresAt > where.expiresAt.gt &&
                !!s.mfaVerifiedAt &&
                s.mfaVerifiedAt >= where.mfaVerifiedAt.gte &&
                where.mfaVerifiedWith.in.includes(s.mfaVerifiedWith ?? ''),
            ).length,
          ),
      },
    } as unknown as PrismaService;
    guard = new AdminMfaGuard(prisma);
  });
  afterEach(() => jest.useRealTimers());

  const check = (
    user: { userId: string; role: string; sid?: string } | undefined = {
      userId: 'admin',
      role: 'ADMIN',
      sid: 'session-1',
    },
  ) =>
    guard.canActivate({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext);

  it.each(['ADMIN', 'SUPERADMIN'])(
    'admits a %s whose session proved MFA with the authenticator',
    async (role) => {
      await expect(
        check({ userId: 'admin', role, sid: 'session-1' }),
      ).resolves.toBe(true);
    },
  );

  it('accepts a recovery code as the proof', async () => {
    sessions[0].mfaVerifiedWith = 'recovery_code';
    await expect(check()).resolves.toBe(true);
  });

  it('does not concern other roles (RolesGuard decides for them)', async () => {
    security = null;
    await expect(check({ userId: 'u', role: 'USER', sid: 'x' })).resolves.toBe(
      true,
    );
  });

  it.each([
    [
      'MFA is off',
      () =>
        (security = { mfaEnabled: false, mfaMethod: null, mfaSecret: null }),
    ],
    ['there is no MFA record', () => (security = null)],
    [
      'MFA is not enabled, even with a secret stored',
      () =>
        (security = {
          mfaEnabled: false,
          mfaMethod: 'totp',
          mfaSecret: 'mfa2.x',
        }),
    ],
    [
      'MFA is enabled without a stored secret',
      () =>
        (security = { mfaEnabled: true, mfaMethod: 'totp', mfaSecret: null }),
    ],
    [
      'the MFA method is SMS',
      () =>
        (security = { mfaEnabled: true, mfaMethod: 'sms', mfaSecret: null }),
    ],
  ])('refuses an administrator when %s (403)', async (_, arrange) => {
    arrange();
    await expect(check()).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('must enable MFA') as string,
    });
  });

  it.each([
    [
      'the session never proved MFA (e.g. a trusted device)',
      () => {
        sessions[0].mfaVerifiedAt = null;
        sessions[0].mfaVerifiedWith = null;
      },
    ],
    [
      'the proof is older than 12 hours',
      () => {
        sessions[0].mfaVerifiedAt = new Date(NOW.getTime() - 12 * HOUR - 1);
      },
    ],
    [
      'the proof was SMS',
      () => {
        sessions[0].mfaVerifiedWith = 'sms';
      },
    ],
    [
      'the session was revoked',
      () => {
        sessions[0].revokedAt = NOW;
      },
    ],
    [
      "the proof belongs to another user's session",
      () => {
        sessions[0].authId = 'someone-else';
      },
    ],
  ])('refuses when %s (403)', async (_, arrange) => {
    arrange();
    await expect(check()).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('Verify MFA in this session') as string,
    });
  });

  it('refuses a token without a session', async () => {
    await expect(
      check({ userId: 'admin', role: 'ADMIN' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses an unauthenticated request', async () => {
    await expect(
      guard.canActivate({
        switchToHttp: () => ({ getRequest: () => ({}) }),
      } as unknown as ExecutionContext),
    ).rejects.toMatchObject({ status: 401 });
  });
});
