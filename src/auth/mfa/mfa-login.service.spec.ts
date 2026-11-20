import { ConflictException, HttpException } from '@nestjs/common';
import { mock } from 'jest-mock-extended';
import type { Logger } from 'winston';
import { FakeMfaRepository } from '../../../test/support/fake-mfa-repository';
import { testCipher } from '../../../test/support/mfa-test-keys';
import config from '../../common/config/app.config';
import {
  hashMfaToken,
  MfaLoginService,
  type MfaChallengeView,
  type NewTrustedDevice,
} from './mfa-login.service';
import { totpCode } from './mfa-totp';
import {
  MfaVerificationService,
  type MfaFactor,
} from './mfa-verification.service';
import { MfaService } from './mfa.service';

// Recovery codes use salted scrypt (deliberately slow, ~50-80 ms each), so
// tests that issue and verify many codes need more than the 5 s default
// when run alongside other suites.
jest.setTimeout(30_000);

const ALICE = 'alice';
const BOB = 'bob';
const META = { ip: '203.0.113.5', userAgent: 'MuseCue/2.0 (iPhone)' };
/** The start of a 30-second TOTP step. */
const T0 = new Date(Math.floor(Date.UTC(2026, 10, 24, 9) / 30_000) * 30_000);
const plus = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return { status: error.getStatus(), message: error.message };
  }
  throw new Error('Expected the call to be rejected');
}

describe('MfaLoginService', () => {
  const originalSecret = config.jwt_refresh_secret;
  let repo: FakeMfaRepository;
  let logger: ReturnType<typeof mock<Logger>>;
  let enrollment: MfaService;
  let verification: MfaVerificationService;
  let service: MfaLoginService;

  beforeAll(() => {
    // MFA must not depend on the JWT refresh secret: run without one.
    config.jwt_refresh_secret = '';
  });
  afterAll(() => {
    config.jwt_refresh_secret = originalSecret;
  });

  beforeEach(() => {
    repo = new FakeMfaRepository();
    repo.addAccount(ALICE);
    repo.addAccount(BOB);
    logger = mock<Logger>();
    const cipher = testCipher();
    enrollment = new MfaService(repo.asRepository(), cipher, logger);
    verification = new MfaVerificationService(
      repo.asRepository(),
      cipher,
      logger,
    );
    service = new MfaLoginService(repo.asRepository(), verification, logger);
  });

  /** Enables MFA at T0; returns the TOTP secret and the recovery codes. */
  async function enable(authId = ALICE) {
    const { secret } = await enrollment.startEnrollment(authId, T0);
    const { recoveryCodes } = await enrollment.confirmEnrollment(
      authId,
      totpCode(secret, T0),
      META,
      T0,
    );
    return { secret, recoveryCodes };
  }

  const gate = (
    authId = ALICE,
    now = plus(MIN),
    trustedDeviceToken?: string | null,
  ) =>
    service.gate(
      { authId, provider: 'local', meta: META, trustedDeviceToken },
      now,
    );

  /** A challenge issued at `now`. */
  async function challengeFor(authId = ALICE, now = plus(MIN)) {
    const result = await gate(authId, now);
    if (result.kind !== 'CHALLENGE') throw new Error('expected a challenge');
    return result.challenge;
  }

  /** Stands in for AuthService: "creates the session" inside the lock. */
  const issued: string[] = [];
  const issueSession = (_tx: unknown, completion: { authId: string }) => {
    issued.push(completion.authId);
    return Promise.resolve('session');
  };

  const complete = (
    challenge: MfaChallengeView,
    factor: MfaFactor,
    now = plus(MIN),
    extra: {
      trustDevice?: boolean;
      deviceName?: string;
      issue?: (tx: unknown, completion: { authId: string }) => Promise<string>;
    } = {},
  ) =>
    service
      .complete(
        {
          challengeToken: challenge.challengeToken,
          factor,
          trustDevice: extra.trustDevice ?? false,
          deviceName: extra.deviceName,
          meta: META,
        },
        extra.issue ?? issueSession,
        now,
      )
      .then(({ completion }) => completion);

  describe('gate', () => {
    it('lets users without MFA sign in as before', async () => {
      await expect(gate(ALICE)).resolves.toEqual({ kind: 'NOT_REQUIRED' });
      expect(repo.challenges).toHaveLength(0);
    });

    it('issues a five-minute challenge to users with MFA, storing only its hash', async () => {
      await enable();

      const challenge = await challengeFor(ALICE, plus(MIN));

      expect(challenge).toEqual({
        mfaRequired: true,
        challengeToken: expect.stringMatching(
          /^mfac_[A-Za-z0-9_-]{43}$/,
        ) as string,
        expiresAt: plus(6 * MIN),
        methods: ['totp', 'recovery_code'],
      });
      expect(repo.challenges).toEqual([
        expect.objectContaining({
          authId: ALICE,
          tokenHash: hashMfaToken(challenge.challengeToken),
          provider: 'local',
          consumedAt: null,
        }),
      ]);
      expect(JSON.stringify(repo.challenges)).not.toContain(
        challenge.challengeToken,
      );
    });

    it('issues a new, distinct challenge for every sign-in', async () => {
      await enable();
      const a = await challengeFor();
      const b = await challengeFor();
      expect(a.challengeToken).not.toBe(b.challengeToken);
    });
  });

  describe('complete', () => {
    it('accepts the authenticator code and consumes the challenge', async () => {
      const { secret } = await enable();
      const challenge = await challengeFor();
      const now = plus(MIN);

      await expect(
        complete(challenge, { method: 'totp', code: totpCode(secret, now) }),
      ).resolves.toEqual({
        authId: ALICE,
        provider: 'local',
        method: 'totp',
        trustedDevice: null,
      });
      expect(repo.challenges[0].consumedAt).toEqual(now);
    });

    it('accepts an unused recovery code, which is consumed', async () => {
      const { recoveryCodes } = await enable();

      await expect(
        complete(await challengeFor(), {
          method: 'recovery_code',
          code: recoveryCodes[0],
        }),
      ).resolves.toMatchObject({ method: 'recovery_code' });
      expect(repo.unusedCodes(ALICE)).toHaveLength(9);

      // Used once: the same code fails on the next challenge.
      await expect(
        rejection(
          complete(await challengeFor(), {
            method: 'recovery_code',
            code: recoveryCodes[0],
          }),
        ),
      ).resolves.toMatchObject({ status: 400 });
    });

    describe('when the sign-in cannot be created', () => {
      const failingIssue = () =>
        Promise.reject(new Error('refresh session could not be stored'));

      it('keeps the recovery code, the challenge and the device untouched', async () => {
        const { recoveryCodes } = await enable();
        const challenge = await challengeFor();
        const factor: MfaFactor = {
          method: 'recovery_code',
          code: recoveryCodes[0],
        };

        await expect(
          rejection(
            complete(challenge, factor, plus(MIN), {
              trustDevice: true,
              issue: failingIssue,
            }),
          ),
        ).resolves.toMatchObject({ status: 503 });

        expect(repo.unusedCodes(ALICE)).toHaveLength(10);
        expect(repo.challenges[0].consumedAt).toBeNull();
        expect(repo.devices).toEqual([]);
        expect(
          repo.audits.filter(
            (a) => a.changes[0]?.fieldName === 'mfaRecoveryCodesRemaining',
          ),
        ).toEqual([]);
        // The same challenge with the same code then succeeds.
        await expect(complete(challenge, factor)).resolves.toMatchObject({
          method: 'recovery_code',
        });
        expect(repo.unusedCodes(ALICE)).toHaveLength(9);
      });

      it('keeps the authenticator step usable', async () => {
        const { secret } = await enable();
        const challenge = await challengeFor();
        const now = plus(MIN);
        const factor: MfaFactor = {
          method: 'totp',
          code: totpCode(secret, now),
        };
        const stepBefore = repo.accounts.get(ALICE)!.mfaLastUsedStep;

        await rejection(
          complete(challenge, factor, now, { issue: failingIssue }),
        );

        expect(repo.accounts.get(ALICE)!.mfaLastUsedStep).toBe(stepBefore);
        await expect(complete(challenge, factor, now)).resolves.toMatchObject({
          method: 'totp',
        });
      });

      it('passes HTTP errors of the sign-in through (e.g. 409 login in progress)', async () => {
        const { recoveryCodes } = await enable();
        const challenge = await challengeFor();

        await expect(
          rejection(
            complete(
              challenge,
              { method: 'recovery_code', code: recoveryCodes[0] },
              plus(MIN),
              {
                issue: () =>
                  Promise.reject(
                    new ConflictException('Another login is in progress'),
                  ),
              },
            ),
          ),
        ).resolves.toMatchObject({ status: 409 });
        expect(repo.unusedCodes(ALICE)).toHaveLength(10);
      });
    });

    it('creates the sign-in only after a valid code', async () => {
      const { recoveryCodes } = await enable();
      const challenge = await challengeFor();
      issued.length = 0;
      await rejection(
        complete(challenge, { method: 'recovery_code', code: 'AAAAA-AAAAA' }),
      );
      expect(issued).toEqual([]);
      await complete(challenge, {
        method: 'recovery_code',
        code: recoveryCodes[0],
      });
      expect(issued).toEqual([ALICE]);
    });

    it('uses a challenge only once', async () => {
      const { recoveryCodes } = await enable();
      const challenge = await challengeFor();
      await complete(challenge, {
        method: 'recovery_code',
        code: recoveryCodes[0],
      });

      await expect(
        rejection(
          complete(challenge, {
            method: 'recovery_code',
            code: recoveryCodes[1],
          }),
        ),
      ).resolves.toEqual({
        status: 401,
        message:
          'The MFA challenge is invalid or has expired. Please sign in again.',
      });
      // The second code was not consumed.
      expect(repo.unusedCodes(ALICE)).toHaveLength(9);
    });

    it('accepts exactly one of concurrent completions of one challenge', async () => {
      const { recoveryCodes } = await enable();
      const challenge = await challengeFor();

      const results = await Promise.allSettled(
        recoveryCodes
          .slice(0, 4)
          .map((code) =>
            complete(challenge, { method: 'recovery_code', code }),
          ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(repo.unusedCodes(ALICE)).toHaveLength(9);
    });

    it('expires after five minutes', async () => {
      const { recoveryCodes } = await enable();
      const challenge = await challengeFor(ALICE, plus(MIN));

      await expect(
        rejection(
          complete(
            challenge,
            { method: 'recovery_code', code: recoveryCodes[0] },
            plus(6 * MIN),
          ),
        ),
      ).resolves.toMatchObject({ status: 401 });
      expect(repo.unusedCodes(ALICE)).toHaveLength(10);
      await expect(
        complete(
          await challengeFor(ALICE, plus(6 * MIN)),
          { method: 'recovery_code', code: recoveryCodes[0] },
          plus(11 * MIN - 1),
        ),
      ).resolves.toMatchObject({ authId: ALICE });
    });

    it('keeps the challenge usable after a wrong code, and counts it', async () => {
      const { secret } = await enable();
      const challenge = await challengeFor();
      const now = plus(MIN);
      const code = totpCode(secret, now);
      const wrong = String((Number(code) + 1) % 1e6).padStart(6, '0');

      await expect(
        rejection(complete(challenge, { method: 'totp', code: wrong }, now)),
      ).resolves.toEqual({
        status: 400,
        message: 'Invalid MFA code. 4 attempt(s) remaining.',
      });
      expect(repo.challenges[0].consumedAt).toBeNull();
      await expect(
        complete(challenge, { method: 'totp', code }, now),
      ).resolves.toMatchObject({ method: 'totp' });
    });

    it('applies the verification lockout', async () => {
      const { recoveryCodes } = await enable();
      const challenge = await challengeFor();
      for (let i = 0; i < 4; i++) {
        await rejection(
          complete(challenge, { method: 'recovery_code', code: 'AAAAA-AAAAA' }),
        );
      }
      await expect(
        rejection(
          complete(challenge, { method: 'recovery_code', code: 'AAAAA-AAAAA' }),
        ),
      ).resolves.toMatchObject({ status: 429 });
      await expect(
        rejection(
          complete(challenge, {
            method: 'recovery_code',
            code: recoveryCodes[0],
          }),
        ),
      ).resolves.toMatchObject({ status: 429 });
    });

    it.each([
      'not-a-token',
      'mfac_short',
      `mfatd_${'A'.repeat(43)}`,
      `mfac_${'A'.repeat(43)}`,
    ])('declines the unknown or malformed challenge %j', async (token) => {
      await enable();
      await expect(
        rejection(
          service.complete(
            {
              challengeToken: token,
              factor: { method: 'recovery_code', code: 'AAAAA-AAAAA' },
              trustDevice: false,
              meta: META,
            },
            issueSession,
          ),
        ),
      ).resolves.toMatchObject({ status: 401 });
      // Never counted against anyone.
      expect(repo.accounts.get(ALICE)!.mfaFailedAttemptsAt).toEqual([]);
    });

    it("only checks the code against the challenge owner's credentials", async () => {
      const alice = await enable(ALICE);
      await enable(BOB);
      const bobChallenge = await challengeFor(BOB);

      await expect(
        rejection(
          complete(bobChallenge, {
            method: 'recovery_code',
            code: alice.recoveryCodes[0],
          }),
        ),
      ).resolves.toMatchObject({ status: 400 });
      expect(repo.unusedCodes(ALICE)).toHaveLength(10);
    });
  });

  describe('trusted devices', () => {
    /** Completes a challenge with trustDevice and returns the device. */
    async function trust(authId = ALICE, now = plus(MIN), name?: string) {
      const challenge = await challengeFor(authId, now);
      const code = fixtures.get(authId)!.recoveryCodes.pop()!;
      const result = await complete(
        challenge,
        { method: 'recovery_code', code },
        now,
        { trustDevice: true, deviceName: name },
      );
      return result.trustedDevice!;
    }
    const fixtures = new Map<
      string,
      { secret: string; recoveryCodes: string[] }
    >();

    beforeEach(async () => {
      fixtures.clear();
      fixtures.set(ALICE, await enable(ALICE));
      fixtures.set(BOB, await enable(BOB));
    });

    it('trusts the device for 30 days: token shown once, stored as a hash', async () => {
      const device = await trust(ALICE, plus(MIN), 'Ann’s iPhone');

      expect(device).toEqual({
        id: expect.any(String) as string,
        token: expect.stringMatching(/^mfatd_[A-Za-z0-9_-]{43}$/) as string,
        name: 'Ann’s iPhone',
        expiresAt: plus(MIN + 30 * DAY),
      });
      expect(repo.devices).toEqual([
        expect.objectContaining({
          authId: ALICE,
          tokenHash: hashMfaToken(device.token),
          createdAt: plus(MIN),
          expiresAt: plus(MIN + 30 * DAY),
          revokedAt: null,
        }),
      ]);
      expect(JSON.stringify(repo.devices)).not.toContain(device.token);
    });

    it('names the device after the client when no name is given', async () => {
      const device = await trust(ALICE);
      expect(device.name).toBe(META.userAgent);
    });

    it("lets the owner's trusted device skip the challenge until it expires", async () => {
      const device = await trust(ALICE, plus(MIN));

      await expect(gate(ALICE, plus(2 * MIN), device.token)).resolves.toEqual({
        kind: 'TRUSTED_DEVICE',
        deviceId: device.id,
      });
      expect(repo.devices[0].lastUsedAt).toEqual(plus(2 * MIN));
      const lastMoment = plus(MIN + 30 * DAY - 1);
      await expect(
        gate(ALICE, lastMoment, device.token),
      ).resolves.toMatchObject({ kind: 'TRUSTED_DEVICE' });
      // Expired: the challenge is back.
      await expect(
        gate(ALICE, plus(MIN + 30 * DAY), device.token),
      ).resolves.toMatchObject({ kind: 'CHALLENGE' });
    });

    it("never lets another user's trusted device skip MFA", async () => {
      const aliceDevice = await trust(ALICE);

      await expect(
        gate(BOB, plus(2 * MIN), aliceDevice.token),
      ).resolves.toMatchObject({ kind: 'CHALLENGE' });
      expect(repo.devices[0].lastUsedAt).toBeNull();
    });

    it('stops skipping once revoked', async () => {
      const device = await trust(ALICE);

      await expect(
        service.revokeTrustedDevice(ALICE, device.id, plus(2 * MIN)),
      ).resolves.toEqual({ id: device.id, revoked: true });

      await expect(
        gate(ALICE, plus(3 * MIN), device.token),
      ).resolves.toMatchObject({ kind: 'CHALLENGE' });
      await expect(
        service.listTrustedDevices(ALICE, null, plus(3 * MIN)),
      ).resolves.toEqual([]);
    });

    it('ignores malformed or unknown device tokens', async () => {
      await trust(ALICE);
      for (const token of ['garbage', `mfatd_${'A'.repeat(43)}`, '', null]) {
        await expect(gate(ALICE, plus(2 * MIN), token)).resolves.toMatchObject({
          kind: 'CHALLENGE',
        });
      }
    });

    it('lists only the owner’s active devices, marking the current one', async () => {
      const first = await trust(ALICE, plus(MIN), 'laptop');
      const second = await trust(ALICE, plus(2 * MIN), 'phone');
      await trust(BOB, plus(2 * MIN), 'bob phone');
      await service.revokeTrustedDevice(ALICE, first.id, plus(3 * MIN));

      const list = await service.listTrustedDevices(
        ALICE,
        second.token,
        plus(4 * MIN),
      );

      expect(list).toEqual([
        {
          id: second.id,
          name: 'phone',
          ipAddress: META.ip,
          createdAt: plus(2 * MIN),
          lastUsedAt: null,
          expiresAt: plus(2 * MIN + 30 * DAY),
          current: true,
        },
      ]);
      expect(JSON.stringify(list)).not.toContain(second.token);
    });

    it("cannot revoke another user's device (404), and leaves it trusted", async () => {
      const bobDevice = await trust(BOB);

      await expect(
        rejection(service.revokeTrustedDevice(ALICE, bobDevice.id)),
      ).resolves.toEqual({ status: 404, message: 'Trusted device not found' });
      await expect(
        gate(BOB, plus(2 * MIN), bobDevice.token),
      ).resolves.toMatchObject({ kind: 'TRUSTED_DEVICE' });
    });

    it('keeps at most ten trusted devices, revoking the oldest', async () => {
      // Ten trusts use Alice's ten recovery codes; the eleventh needs a new
      // set.
      const devices: NewTrustedDevice[] = [];
      for (let i = 0; i < 10; i++) {
        devices.push(await trust(ALICE, plus(MIN + i * 1000), `d${i}`));
      }
      fixtures.get(ALICE)!.recoveryCodes.push(...(await regenerateCodes()));
      const newest = await trust(ALICE, plus(MIN + 20_000), 'd10');

      const active = await service.listTrustedDevices(
        ALICE,
        null,
        plus(MIN + 30_000),
      );
      expect(active).toHaveLength(10);
      expect(active.map((d) => d.id)).not.toContain(devices[0].id);
      expect(active.map((d) => d.id)).toContain(newest.id);
      await expect(
        gate(ALICE, plus(2 * MIN), devices[0].token),
      ).resolves.toMatchObject({ kind: 'CHALLENGE' });
    });

    /** A new set of recovery codes for Alice. */
    async function regenerateCodes(): Promise<string[]> {
      const view = await verification.regenerateRecoveryCodes(ALICE, META);
      return view.recoveryCodes;
    }
  });

  it('never logs a challenge or device token', async () => {
    const { recoveryCodes } = await enable();
    const challenge = await challengeFor();
    const { trustedDevice } = await complete(
      challenge,
      { method: 'recovery_code', code: recoveryCodes[0] },
      plus(MIN),
      { trustDevice: true },
    );
    await gate(ALICE, plus(2 * MIN), trustedDevice!.token);

    const logged = JSON.stringify([
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls,
    ]);
    expect(logged).not.toContain(challenge.challengeToken);
    expect(logged).not.toContain(trustedDevice!.token);
    expect(logged).not.toContain(recoveryCodes[0]);
  });
});
