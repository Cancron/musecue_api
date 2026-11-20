import type { Prisma } from '@prisma/client';
import {
  confirmMfaSkip,
  MfaStateChangedError,
  type MfaSkip,
} from './login-session';

const NOW = new Date('2026-11-29T10:00:00.000Z');

/**
 * A sign-in that skipped the MFA challenge is confirmed again under the
 * sessions lock before its session is stored (MFA enabled or the trusted
 * device revoked concurrently: no session). See test/mfa-concurrency.
 */
describe('MFA skip at sign-in, confirmed under the sessions lock', () => {
  const txWith = (mfaEnabled: boolean | null, trustedDevices = 1) =>
    ({
      authSecurity: {
        findUnique: () =>
          Promise.resolve(mfaEnabled === null ? null : { mfaEnabled }),
      },
      mfaTrustedDevice: {
        count: jest.fn(() => Promise.resolve(trustedDevices)),
      },
    }) as unknown as Prisma.TransactionClient;

  const notRequired: MfaSkip = { kind: 'NOT_REQUIRED' };
  const device: MfaSkip = { kind: 'TRUSTED_DEVICE', deviceId: 'device-1' };

  it('stores a sign-in without MFA while MFA is still off', async () => {
    await expect(
      confirmMfaSkip(txWith(false), 'alice', notRequired, NOW),
    ).resolves.toBeUndefined();
    await expect(
      confirmMfaSkip(txWith(null), 'alice', notRequired, NOW),
    ).resolves.toBeUndefined();
  });

  it('refuses it once MFA was enabled meanwhile', async () => {
    await expect(
      confirmMfaSkip(txWith(true), 'alice', notRequired, NOW),
    ).rejects.toBeInstanceOf(MfaStateChangedError);
  });

  it('stores a trusted-device sign-in only while the device is still trusted', async () => {
    const tx = txWith(true, 1);
    await expect(
      confirmMfaSkip(tx, 'alice', device, NOW),
    ).resolves.toBeUndefined();
    expect((tx.mfaTrustedDevice.count as jest.Mock).mock.calls[0]).toEqual([
      {
        where: {
          id: 'device-1',
          authId: 'alice',
          revokedAt: null,
          expiresAt: { gt: NOW },
        },
      },
    ]);
    await expect(
      confirmMfaSkip(txWith(true, 0), 'alice', device, NOW),
    ).rejects.toBeInstanceOf(MfaStateChangedError);
    await expect(
      confirmMfaSkip(txWith(false, 1), 'alice', device, NOW),
    ).rejects.toBeInstanceOf(MfaStateChangedError);
  });
});
