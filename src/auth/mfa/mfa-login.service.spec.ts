import { HttpException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { mock, type MockProxy } from 'jest-mock-extended';
import { createHash } from 'node:crypto';
import type {
  MfaLoginRepository,
  StoredMfaChallenge,
  StoredTrustedDevice,
} from './mfa-login.repository';
import { MfaLoginService } from './mfa-login.service';
import type {
  MfaVerificationHooks,
  MfaVerificationService,
} from './mfa-verification.service';

const T0 = new Date('2026-11-24T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const META = { ip: '203.0.113.5', userAgent: 'jest-agent', device: 'Pixel 9' };
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const TOKEN = 'A'.repeat(43);
const TX = {} as Prisma.TransactionClient;

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
  throw new Error('Expected a rejection');
}

describe('MfaLoginService (mfa login)', () => {
  let repository: MockProxy<MfaLoginRepository>;
  let verification: MockProxy<MfaVerificationService>;
  let service: MfaLoginService;

  const challenge = (
    overrides: Partial<StoredMfaChallenge> = {},
  ): StoredMfaChallenge => ({
    id: 'challenge-1',
    authId: 'user-1',
    provider: 'local',
    expiresAt: new Date(T0.getTime() + 60_000),
    consumedAt: null,
    ...overrides,
  });

  /** verifyWithin that accepts the factor and runs the hooks like the real one. */
  const acceptFactor = () =>
    verification.verifyWithin.mockImplementation((async (
      _authId: string,
      _factor: unknown,
      _meta: unknown,
      _now: Date,
      hooks: MfaVerificationHooks<unknown>,
    ) => {
      await hooks.precheck?.(TX);
      const result = await hooks.onVerified?.(TX, 'recovery_code');
      return {
        verified: true,
        method: 'recovery_code',
        remainingRecoveryCodes: 7,
        result,
      };
    }) as MfaVerificationService['verifyWithin']);

  beforeEach(() => {
    repository = mock<MfaLoginRepository>();
    verification = mock<MfaVerificationService>();
    service = new MfaLoginService(repository, verification);
  });

  describe('beginLogin', () => {
    it('lets accounts without MFA through untouched', async () => {
      repository.isMfaEnabled.mockResolvedValue(false);
      await expect(
        service.beginLogin('user-1', 'local', TOKEN, META, T0),
      ).resolves.toEqual({ kind: 'NOT_REQUIRED' });
      expect(repository.useTrustedDevice.mock.calls).toHaveLength(0);
      expect(repository.createChallenge.mock.calls).toHaveLength(0);
    });

    it('skips the challenge only for a valid trusted device of that user', async () => {
      repository.isMfaEnabled.mockResolvedValue(true);
      repository.useTrustedDevice.mockResolvedValue('device-1');
      await expect(
        service.beginLogin('user-1', 'google', TOKEN, META, T0),
      ).resolves.toEqual({ kind: 'TRUSTED_DEVICE', deviceId: 'device-1' });
      // Looked up by owner and hash, never by the raw token.
      expect(repository.useTrustedDevice.mock.calls).toEqual([
        ['user-1', sha256(TOKEN), T0],
      ]);
      expect(repository.createChallenge.mock.calls).toHaveLength(0);
    });

    it('issues a challenge (hash stored, 5-minute expiry) when the device is not trusted', async () => {
      repository.isMfaEnabled.mockResolvedValue(true);
      repository.useTrustedDevice.mockResolvedValue(null);
      const gate = await service.beginLogin('user-1', 'local', TOKEN, META, T0);

      if (gate.kind !== 'CHALLENGE') throw new Error('expected a challenge');
      expect(gate.challenge).toEqual({
        mfaRequired: true,
        challengeToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
        challengeExpiresAt: new Date(T0.getTime() + 5 * 60_000),
        methods: ['totp', 'recovery_code'],
      });
      const [stored] = repository.createChallenge.mock.calls[0];
      expect(stored).toEqual({
        authId: 'user-1',
        tokenHash: sha256(gate.challenge.challengeToken),
        provider: 'local',
        ipAddress: META.ip,
        userAgent: META.userAgent,
        device: META.device,
        createdAt: T0,
        expiresAt: gate.challenge.challengeExpiresAt,
      });
      expect(JSON.stringify(stored)).not.toContain(
        gate.challenge.challengeToken,
      );
    });

    it('never looks up a malformed device token, and challenges without one', async () => {
      repository.isMfaEnabled.mockResolvedValue(true);
      for (const token of [undefined, '', 'short', `${TOKEN}!`]) {
        const gate = await service.beginLogin(
          'user-1',
          'local',
          token,
          META,
          T0,
        );
        expect(gate.kind).toBe('CHALLENGE');
      }
      expect(repository.useTrustedDevice.mock.calls).toHaveLength(0);
    });

    it('issues a different challenge token every time', async () => {
      repository.isMfaEnabled.mockResolvedValue(true);
      const tokens = new Set<string>();
      for (let i = 0; i < 20; i += 1) {
        const gate = await service.beginLogin(
          'u',
          'local',
          undefined,
          META,
          T0,
        );
        if (gate.kind === 'CHALLENGE')
          tokens.add(gate.challenge.challengeToken);
      }
      expect(tokens.size).toBe(20);
    });
  });

  describe('completeChallenge', () => {
    it.each([
      ['unknown', null],
      ['used', challenge({ consumedAt: T0 })],
      ['expired', challenge({ expiresAt: T0 })],
    ])(
      'refuses a %s challenge (401) without checking any code',
      async (_name, stored) => {
        repository.findChallenge.mockResolvedValue(stored);
        expect(
          await statusOf(
            service.completeChallenge(
              TOKEN,
              { code: '123456' },
              { trustDevice: false },
              META,
              T0,
            ),
          ),
        ).toBe(401);
        expect(verification.verifyWithin.mock.calls).toHaveLength(0);
      },
    );

    it('refuses a malformed challenge token without a lookup', async () => {
      expect(
        await statusOf(
          service.completeChallenge(
            'not-a-token',
            { code: '123456' },
            { trustDevice: false },
            META,
            T0,
          ),
        ),
      ).toBe(401);
      expect(repository.findChallenge.mock.calls).toHaveLength(0);
    });

    it('consumes the challenge in the verification transaction and returns the account', async () => {
      repository.findChallenge.mockResolvedValue(challenge());
      repository.lockChallenge.mockResolvedValue(challenge());
      repository.consumeChallenge.mockResolvedValue(true);
      acceptFactor();

      await expect(
        service.completeChallenge(
          TOKEN,
          { recoveryCode: 'ABCD-2345-WXYZ' },
          { trustDevice: false },
          META,
          T0,
        ),
      ).resolves.toEqual({
        authId: 'user-1',
        method: 'recovery_code',
        remainingRecoveryCodes: 7,
        trustedDevice: null,
      });
      expect(repository.findChallenge.mock.calls).toEqual([[sha256(TOKEN)]]);
      expect(verification.verifyWithin.mock.calls[0][0]).toBe('user-1');
      expect(repository.consumeChallenge.mock.calls).toEqual([
        [TX, 'challenge-1', T0],
      ]);
      expect(repository.createTrustedDevice.mock.calls).toHaveLength(0);
    });

    it('refuses (and so rolls back) when the challenge was used concurrently', async () => {
      repository.findChallenge.mockResolvedValue(challenge());
      repository.lockChallenge.mockResolvedValue(challenge({ consumedAt: T0 }));
      acceptFactor();
      expect(
        await statusOf(
          service.completeChallenge(
            TOKEN,
            { code: '123456' },
            { trustDevice: true },
            META,
            T0,
          ),
        ),
      ).toBe(401);
      expect(repository.consumeChallenge.mock.calls).toHaveLength(0);
      expect(repository.createTrustedDevice.mock.calls).toHaveLength(0);
    });

    it('trusts the device for exactly 30 days, storing only the token hash', async () => {
      repository.findChallenge.mockResolvedValue(challenge());
      repository.lockChallenge.mockResolvedValue(challenge());
      repository.consumeChallenge.mockResolvedValue(true);
      repository.createTrustedDevice.mockImplementation((_tx, device) =>
        Promise.resolve({
          id: 'device-9',
          tokenHash: device.tokenHash,
          name: device.name,
          ipAddress: device.ipAddress,
          userAgent: device.userAgent,
          createdAt: device.createdAt,
          expiresAt: device.expiresAt,
          lastUsedAt: null,
          revokedAt: null,
        }),
      );
      acceptFactor();

      const result = await service.completeChallenge(
        TOKEN,
        { code: '123456' },
        { trustDevice: true },
        META,
        T0,
      );

      const device = result.trustedDevice;
      expect(device).toEqual({
        id: 'device-9',
        token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
        name: 'Pixel 9',
        expiresAt: new Date(T0.getTime() + 30 * DAY),
      });
      const [, stored] = repository.createTrustedDevice.mock.calls[0];
      expect(stored).toMatchObject({
        authId: 'user-1',
        tokenHash: sha256(device!.token),
        createdAt: T0,
        expiresAt: new Date(T0.getTime() + 30 * DAY),
      });
      expect(JSON.stringify(stored)).not.toContain(device!.token);
    });
  });

  describe('trusted devices', () => {
    const device = (
      overrides: Partial<StoredTrustedDevice> = {},
    ): StoredTrustedDevice => ({
      id: 'd',
      tokenHash: sha256('other'),
      name: 'phone',
      ipAddress: null,
      userAgent: null,
      createdAt: T0,
      expiresAt: new Date(T0.getTime() + DAY),
      lastUsedAt: null,
      revokedAt: null,
      ...overrides,
    });

    it('lists status and marks the current device, never exposing hashes', async () => {
      repository.listTrustedDevices.mockResolvedValue([
        device({ id: 'active', tokenHash: sha256(TOKEN) }),
        device({ id: 'expired', expiresAt: T0 }),
        device({ id: 'revoked', revokedAt: T0 }),
      ]);
      const views = await service.listTrustedDevices('user-1', TOKEN, T0);
      expect(views.map((v) => [v.id, v.status, v.current])).toEqual([
        ['active', 'ACTIVE', true],
        ['expired', 'EXPIRED', false],
        ['revoked', 'REVOKED', false],
      ]);
      expect(JSON.stringify(views)).not.toContain(sha256(TOKEN));
      expect(repository.listTrustedDevices.mock.calls).toEqual([['user-1']]);
    });

    it("answers 404 for a device that is not the user's", async () => {
      repository.revokeTrustedDevice.mockResolvedValue(null);
      expect(
        await statusOf(service.revokeTrustedDevice('user-1', 'd', T0)),
      ).toBe(404);
      expect(repository.revokeTrustedDevice.mock.calls).toEqual([
        ['user-1', 'd', T0],
      ]);
    });
  });
});
