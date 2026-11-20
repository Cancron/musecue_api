import { mock } from 'jest-mock-extended';
import type { Logger } from 'winston';
import { FakeMfaNotifier } from '../../../test/support/fake-mfa-notifier';
import { FakeMfaRepository } from '../../../test/support/fake-mfa-repository';
import { testCipher } from '../../../test/support/mfa-test-keys';
import config from '../../common/config/app.config';
import { totpCode } from './mfa-totp';
import { MfaVerificationService } from './mfa-verification.service';
import { MfaService } from './mfa.service';

// Recovery codes use salted scrypt (deliberately slow).
jest.setTimeout(30_000);

const ALICE = 'alice';
const META = { ip: '203.0.113.4', userAgent: 'jest' };
const T0 = new Date(Math.floor(Date.UTC(2026, 10, 27, 9) / 30_000) * 30_000);
const plus = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;

describe('MFA security history and MFA activation', () => {
  const originalSecret = config.jwt_refresh_secret;
  let repo: FakeMfaRepository;
  let service: MfaService;
  let verification: MfaVerificationService;

  beforeAll(() => {
    config.jwt_refresh_secret = '';
  });
  afterAll(() => {
    config.jwt_refresh_secret = originalSecret;
  });

  beforeEach(() => {
    repo = new FakeMfaRepository();
    repo.addAccount(ALICE);
    // Three signed-in sessions before MFA.
    repo.activeSessions.set(ALICE, ['phone', 'laptop', 'tablet']);
    const cipher = testCipher();
    const notifier = new FakeMfaNotifier().asNotifier();
    const logger = mock<Logger>();
    service = new MfaService(repo.asRepository(), cipher, notifier, logger);
    verification = new MfaVerificationService(
      repo.asRepository(),
      cipher,
      notifier,
      logger,
    );
  });

  const types = () => repo.securityEvents.map((e) => e.type);

  async function enableFrom(sessionId: string) {
    const { secret } = await service.startEnrollment(ALICE, T0, {
      ip: META.ip,
      sessionId,
    });
    const result = await service.confirmEnrollment(
      ALICE,
      totpCode(secret, T0),
      META,
      T0,
      sessionId,
    );
    return { secret, ...result };
  }

  it('keeps the activating session and revokes every other one', async () => {
    const result = await enableFrom('laptop');

    expect(result.sessionsRevoked).toBe(2);
    expect(repo.activeSessions.get(ALICE)).toEqual(['laptop']);
    expect(repo.revokedSessionsOf.get(ALICE)!.sort()).toEqual([
      'phone',
      'tablet',
    ]);
    // The activating session proved MFA just now.
    expect(repo.verifiedSessions).toEqual([
      { authId: ALICE, sessionId: 'laptop', method: 'totp' },
    ]);
    expect(types()).toEqual([
      'MFA_ENROLLMENT_STARTED',
      'MFA_ENABLED',
      'SESSION_REVOKED',
    ]);
    expect(repo.securityEvents[1].details).toEqual({
      method: 'totp',
      recoveryCodes: 10,
      sessionsRevoked: 2,
      trustedDevicesRevoked: 0,
    });
    expect(repo.securityEvents[2]).toMatchObject({
      context: { sessionId: 'laptop' },
      details: {
        scope: 'mfa_enabled',
        count: 2,
        includesCurrentSession: false,
      },
    });
  });

  it('records failed and blocked enrollment codes without the code', async () => {
    const { secret } = await service.startEnrollment(ALICE, T0);
    const code = totpCode(secret, T0);
    const wrong = String((Number(code) + 1) % 1e6).padStart(6, '0');
    for (let i = 0; i < 5; i++) {
      await service
        .confirmEnrollment(ALICE, wrong, META, plus(i * 1000))
        .catch(() => undefined);
    }

    expect(types()).toEqual([
      'MFA_ENROLLMENT_STARTED',
      'MFA_VERIFICATION_FAILED',
      'MFA_VERIFICATION_FAILED',
      'MFA_VERIFICATION_FAILED',
      'MFA_VERIFICATION_FAILED',
      'MFA_VERIFICATION_BLOCKED',
    ]);
    expect(repo.securityEvents[1].details).toEqual({
      context: 'enrollment',
      method: 'totp',
      remainingAttempts: 4,
    });
    expect(JSON.stringify(repo.securityEvents)).not.toContain(wrong);
    expect(JSON.stringify(repo.securityEvents)).not.toContain(secret);
  });

  it('records failed verifications, recovery-code use and marks the session', async () => {
    const { recoveryCodes } = await enableFrom('laptop');
    repo.securityEvents.length = 0;
    repo.verifiedSessions.length = 0;

    await verification
      .verify(
        ALICE,
        { method: 'recovery_code', code: 'AAAAA-AAAAA' },
        META,
        plus(MIN),
        'laptop',
      )
      .catch(() => undefined);
    await verification.verify(
      ALICE,
      { method: 'recovery_code', code: recoveryCodes[0] },
      META,
      plus(MIN),
      'laptop',
    );

    expect(types()).toEqual([
      'MFA_VERIFICATION_FAILED',
      'MFA_RECOVERY_CODE_USED',
    ]);
    expect(repo.securityEvents[0].details).toEqual({
      context: 'verification',
      method: 'recovery_code',
      remainingAttempts: 4,
    });
    expect(repo.securityEvents[1].details).toEqual({
      context: 'verification',
      remaining: 9,
    });
    expect(repo.verifiedSessions).toEqual([
      { authId: ALICE, sessionId: 'laptop', method: 'recovery_code' },
    ]);
    expect(JSON.stringify(repo.securityEvents)).not.toContain(recoveryCodes[0]);
  });

  it('records disabling and replacing, with the revoked devices', async () => {
    const { secret } = await enableFrom('laptop');
    repo.devices.push({
      id: 'device-1',
      authId: ALICE,
      tokenHash: 'f'.repeat(64),
      name: 'phone',
      ipAddress: null,
      userAgent: null,
      createdAt: T0,
      expiresAt: plus(60 * MIN),
      lastUsedAt: null,
      revokedAt: null,
    });
    repo.securityEvents.length = 0;
    const change = {
      metadata: META,
      sessionId: 'laptop',
      approvedWith: 'TOTP' as const,
    };

    const started = await service.startReplacement(ALICE, plus(MIN), {
      sessionId: 'laptop',
    });
    await service.confirmReplacement(
      ALICE,
      totpCode(started.secret, plus(MIN + 30_000)),
      change,
      plus(MIN + 30_000),
    );
    await service.disable(ALICE, change, plus(2 * MIN));

    expect(types()).toEqual([
      'MFA_AUTHENTICATOR_REPLACEMENT_STARTED',
      'MFA_AUTHENTICATOR_REPLACED',
      'TRUSTED_DEVICE_REVOKED',
      'MFA_DISABLED',
    ]);
    expect(repo.securityEvents[2].details).toEqual({
      reason: 'authenticator_replaced',
      count: 1,
    });
    expect(repo.securityEvents[3].details).toEqual({
      recoveryCodesDeleted: 10,
      trustedDevicesRevoked: 0,
      approvedWith: 'TOTP',
    });
    const recorded = JSON.stringify(repo.securityEvents);
    expect(recorded).not.toContain(secret);
    expect(recorded).not.toContain(started.secret);
  });

  it('records nothing when the change rolls back', async () => {
    await enableFrom('laptop');
    repo.securityEvents.length = 0;
    repo.failWith = new Error('database down');

    await service
      .disable(ALICE, { metadata: META }, plus(MIN))
      .catch(() => undefined);

    expect(repo.securityEvents).toEqual([]);
  });
});
