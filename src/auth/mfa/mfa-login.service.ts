import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import AppError from '../../common/errors/app.error';
import { MFA_LOGIN } from './mfa.constants';
import {
  MfaLoginRepository,
  type StoredTrustedDevice,
} from './mfa-login.repository';
import {
  MfaVerificationService,
  type MfaFactor,
} from './mfa-verification.service';
import type { MfaVerificationMethod } from './mfa.interface';

/** Returned by sign-in instead of tokens when MFA is required. */
export interface MfaChallengeView {
  mfaRequired: true;
  /** Opaque, single-use; not an access or refresh token. */
  challengeToken: string;
  challengeExpiresAt: Date;
  methods: MfaVerificationMethod[];
}

/** The decision after a successful first factor (password or Google). */
export type MfaLoginGate =
  | { kind: 'NOT_REQUIRED' }
  | { kind: 'TRUSTED_DEVICE'; deviceId: string }
  | { kind: 'CHALLENGE'; challenge: MfaChallengeView };

/** A newly trusted device; its token is returned this one time only. */
export interface NewTrustedDeviceView {
  id: string;
  token: string;
  name: string;
  expiresAt: Date;
}

export interface MfaChallengeCompletion {
  authId: string;
  method: MfaVerificationMethod;
  remainingRecoveryCodes: number;
  trustedDevice: NewTrustedDeviceView | null;
}

export type TrustedDeviceStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

export interface TrustedDeviceView {
  id: string;
  name: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  status: TrustedDeviceStatus;
  /** Whether this request presented the device's token. */
  current: boolean;
}

export interface SignInMeta {
  ip: string;
  userAgent: string;
  device?: string;
}

const sha256 = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

/**
 * MFA as the second step of sign-in. After a successful password or Google
 * sign-in of an MFA-enabled account, `beginLogin` either accepts a valid
 * trusted device of that account or issues a challenge (no tokens). The
 * challenge is completed with an authenticator or recovery code; only then
 * may the caller issue tokens, optionally trusting the device for 30 days.
 * Accounts without MFA are not affected.
 */
@Injectable()
export class MfaLoginService {
  constructor(
    private readonly repository: MfaLoginRepository,
    private readonly verification: MfaVerificationService,
  ) {}

  async beginLogin(
    authId: string,
    provider: 'local' | 'google',
    trustedDeviceToken: string | undefined,
    meta: SignInMeta,
    now: Date = new Date(),
  ): Promise<MfaLoginGate> {
    if (!(await this.repository.isMfaEnabled(authId))) {
      return { kind: 'NOT_REQUIRED' };
    }
    if (trustedDeviceToken && TOKEN_FORMAT.test(trustedDeviceToken)) {
      // Only a device of this very user, neither revoked nor expired.
      const deviceId = await this.repository.useTrustedDevice(
        authId,
        sha256(trustedDeviceToken),
        now,
      );
      if (deviceId) return { kind: 'TRUSTED_DEVICE', deviceId };
    }
    const challengeToken = newToken();
    const challengeExpiresAt = new Date(
      now.getTime() + MFA_LOGIN.CHALLENGE_TTL_MS,
    );
    await this.repository.createChallenge({
      authId,
      tokenHash: sha256(challengeToken),
      provider,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      device: meta.device ?? null,
      createdAt: now,
      expiresAt: challengeExpiresAt,
    });
    return {
      kind: 'CHALLENGE',
      challenge: {
        mfaRequired: true,
        challengeToken,
        challengeExpiresAt,
        methods: ['totp', 'recovery_code'],
      },
    };
  }

  /**
   * Completes a challenge with the account's second factor. The challenge is
   * consumed in the same transaction that accepts the code, so neither works
   * twice; an invalid, used or expired challenge is refused (401) without
   * counting an incorrect code. Incorrect codes count toward the account's
   * MFA verification block.
   */
  async completeChallenge(
    challengeToken: string,
    factor: MfaFactor,
    options: { trustDevice: boolean; deviceName?: string },
    meta: SignInMeta,
    now: Date = new Date(),
  ): Promise<MfaChallengeCompletion> {
    const invalid = () =>
      AppError.unauthorized(
        'The MFA challenge is invalid or has expired. Please sign in again.',
      );
    const usable = (c: { consumedAt: Date | null; expiresAt: Date } | null) =>
      c !== null &&
      c.consumedAt === null &&
      c.expiresAt.getTime() > now.getTime();

    const stored = TOKEN_FORMAT.test(challengeToken)
      ? await this.repository.findChallenge(sha256(challengeToken))
      : null;
    if (!stored || !usable(stored)) throw invalid();

    const deviceToken = options.trustDevice ? newToken() : null;
    const outcome = await this.verification.verifyWithin(
      stored.authId,
      factor,
      { ...meta, actionedBy: stored.authId },
      now,
      {
        precheck: async (tx) => {
          if (!usable(await this.repository.lockChallenge(tx, stored.id))) {
            throw invalid();
          }
        },
        onVerified: async (tx) => {
          if (!(await this.repository.consumeChallenge(tx, stored.id, now))) {
            throw invalid();
          }
          if (!deviceToken) return null;
          const device = await this.repository.createTrustedDevice(tx, {
            authId: stored.authId,
            tokenHash: sha256(deviceToken),
            name: deviceName(options.deviceName, meta),
            ipAddress: meta.ip,
            userAgent: meta.userAgent,
            createdAt: now,
            expiresAt: new Date(
              now.getTime() + MFA_LOGIN.TRUSTED_DEVICE_TTL_MS,
            ),
          });
          return {
            id: device.id,
            token: deviceToken,
            name: device.name,
            expiresAt: device.expiresAt,
          };
        },
      },
    );
    return {
      authId: stored.authId,
      method: outcome.method,
      remainingRecoveryCodes: outcome.remainingRecoveryCodes,
      trustedDevice: outcome.result ?? null,
    };
  }

  /** The owner's trusted devices (active, expired and revoked), newest first. */
  async listTrustedDevices(
    authId: string,
    currentToken: string | undefined,
    now: Date = new Date(),
  ): Promise<TrustedDeviceView[]> {
    const current =
      currentToken && TOKEN_FORMAT.test(currentToken)
        ? sha256(currentToken)
        : null;
    const devices = await this.repository.listTrustedDevices(authId);
    return devices.map((device) => toView(device, now, current));
  }

  /** Revokes one of the owner's devices; 404 for any other device. */
  async revokeTrustedDevice(
    authId: string,
    deviceId: string,
    now: Date = new Date(),
  ): Promise<TrustedDeviceView> {
    const device = await this.repository.revokeTrustedDevice(
      authId,
      deviceId,
      now,
    );
    if (!device) throw AppError.notFound('Trusted device not found');
    return toView(device, now, null);
  }
}

function deviceName(requested: string | undefined, meta: SignInMeta): string {
  const name =
    requested?.trim() || meta.device?.trim() || meta.userAgent?.trim() || '';
  return (name || 'Unknown device').slice(0, 100);
}

function toView(
  device: StoredTrustedDevice,
  now: Date,
  currentHash: string | null,
): TrustedDeviceView {
  const status: TrustedDeviceStatus = device.revokedAt
    ? 'REVOKED'
    : device.expiresAt.getTime() <= now.getTime()
      ? 'EXPIRED'
      : 'ACTIVE';
  return {
    id: device.id,
    name: device.name,
    ipAddress: device.ipAddress,
    userAgent: device.userAgent,
    createdAt: device.createdAt,
    expiresAt: device.expiresAt,
    lastUsedAt: device.lastUsedAt,
    revokedAt: device.revokedAt,
    status,
    current: currentHash !== null && device.tokenHash === currentHash,
  };
}
