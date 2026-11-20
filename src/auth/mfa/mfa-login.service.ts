import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import AppError from '../../common/errors/app.error';
import { guardMfaStorage } from './mfa-errors';
import {
  MfaVerificationService,
  type CheckOutcome,
  type MfaLoginFactor,
  type MfaLoginMethod,
} from './mfa-verification.service';
import type { MfaSmsService, SmsCheckOutcome } from './sms/mfa-sms.service';
import { MFA_SMS_SERVICE } from './sms/mfa-sms.tokens';
import { MFA_LOGIN } from './mfa.constants';
import { MfaRepository, type TrustedDeviceView } from './mfa.repository';
import type { SecurityEventContext } from '../security-events/security-event.log';

export type FirstFactorProvider = 'local' | 'google';

export interface MfaLoginMeta {
  ip: string;
  userAgent: string;
  device?: string;
}

/** What a sign-in of an MFA user receives instead of tokens. */
export interface MfaChallengeView {
  mfaRequired: true;
  challengeToken: string;
  expiresAt: Date;
  methods: MfaLoginMethod[];
  /**
   * The masked verified number, when an SMS code can complete the challenge
   * (`sms` in `methods`; POST /auth/login/mfa/sms sends it).
   */
  smsPhone?: string;
}

export type MfaGateResult =
  | { kind: 'NOT_REQUIRED' }
  | { kind: 'TRUSTED_DEVICE'; deviceId: string }
  | { kind: 'CHALLENGE'; challenge: MfaChallengeView };

/** A newly trusted device: the token is shown only in this response. */
export interface NewTrustedDevice {
  id: string;
  token: string;
  name: string;
  expiresAt: Date;
}

export interface MfaLoginCompletion {
  authId: string;
  provider: FirstFactorProvider;
  method: MfaLoginMethod;
  trustedDevice: NewTrustedDevice | null;
}

export interface TrustedDeviceListItem extends TrustedDeviceView {
  /** Whether it is the device that sent the request. */
  current: boolean;
}

type CompleteOutcome<T> =
  | { kind: 'CHALLENGE_INVALID' }
  | { kind: 'DECLINED'; outcome: Exclude<CheckOutcome, { kind: 'VERIFIED' }> }
  | {
      kind: 'SMS_DECLINED';
      outcome: Exclude<SmsCheckOutcome, { kind: 'VERIFIED' }>;
    }
  | { kind: 'VERIFIED'; completion: MfaLoginCompletion; result: T };

const CONTEXT = 'MfaLoginService';

/** SHA-256 (hex) of an opaque token; tokens are 256-bit random values. */
export function hashMfaToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const newToken = (prefix: string) =>
  `${prefix}_${randomBytes(32).toString('base64url')}`;

/**
 * MFA at sign-in. After the first factor (password or Google) succeeds,
 * `gate` decides: users without MFA get their tokens as before; a valid
 * trusted device of the same user skips MFA; everyone else receives a
 * single-use challenge token (five minutes) instead of tokens. `complete`
 * exchanges a challenge and an authenticator or recovery code for the
 * sign-in, with the same checks, lockout and replay protection as
 * POST /auth/mfa/verify, and can trust the device for 30 days.
 *
 * Challenge and device tokens are opaque random values, stored only as
 * SHA-256 hashes in PostgreSQL. A challenge token is not a JWT and is
 * accepted nowhere except POST /auth/login/mfa.
 */
@Injectable()
export class MfaLoginService {
  constructor(
    private readonly repository: MfaRepository,
    private readonly verification: MfaVerificationService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
    @Optional()
    @Inject(MFA_SMS_SERVICE)
    private readonly sms?: MfaSmsService,
  ) {}

  /**
   * Decides whether a sign-in whose first factor succeeded needs MFA. Pass
   * the raw `trustedDeviceToken` from the request, or its hash when it was
   * carried through an OAuth state.
   */
  async gate(
    input: {
      authId: string;
      provider: FirstFactorProvider;
      meta: MfaLoginMeta;
      trustedDeviceToken?: string | null;
      trustedDeviceTokenHash?: string | null;
    },
    now: Date = new Date(),
  ): Promise<MfaGateResult> {
    return this.guard(async () => {
      if (!(await this.repository.mfaEnabled(input.authId))) {
        return { kind: 'NOT_REQUIRED' };
      }

      const deviceHash =
        input.trustedDeviceTokenHash ??
        trustedDeviceTokenHash(input.trustedDeviceToken);
      if (deviceHash) {
        const device = await this.repository.useTrustedDevice(
          input.authId,
          deviceHash,
          now,
        );
        if (device) {
          this.logger.info('MFA skipped for a trusted device', {
            context: CONTEXT,
            authId: input.authId,
            deviceId: device.id,
          });
          return { kind: 'TRUSTED_DEVICE', deviceId: device.id };
        }
      }

      const challengeToken = newToken('mfac');
      const expiresAt = new Date(now.getTime() + MFA_LOGIN.CHALLENGE_TTL_MS);
      const smsPhone = (await this.sms?.signInPhone(input.authId)) ?? null;
      await this.repository.createLoginChallenge({
        authId: input.authId,
        tokenHash: hashMfaToken(challengeToken),
        provider: input.provider,
        ipAddress: input.meta.ip,
        userAgent: input.meta.userAgent,
        device: input.meta.device ?? null,
        createdAt: now,
        expiresAt,
      });
      this.logger.info('MFA challenge issued', {
        context: CONTEXT,
        authId: input.authId,
        provider: input.provider,
      });
      return {
        kind: 'CHALLENGE',
        challenge: {
          mfaRequired: true,
          challengeToken,
          expiresAt,
          methods: smsPhone
            ? ['totp', 'recovery_code', 'sms']
            : ['totp', 'recovery_code'],
          ...(smsPhone ? { smsPhone } : {}),
        },
      };
    });
  }

  /**
   * Completes a challenge with a second factor. `issue` creates the sign-in
   * (the refresh session) inside the same transaction that consumes the
   * challenge and the code and trusts the device: if it fails, everything
   * rolls back, so the challenge, the recovery code (or authenticator step)
   * stay usable and no device is trusted. Declines: 401 for an unknown,
   * expired or used challenge; otherwise the verification errors (400, 409,
   * 429).
   */
  async complete<T>(
    input: {
      challengeToken: string;
      factor: MfaLoginFactor;
      trustDevice: boolean;
      deviceName?: string;
      meta: MfaLoginMeta;
    },
    issue: (
      tx: Prisma.TransactionClient,
      completion: MfaLoginCompletion,
    ) => Promise<T>,
    now: Date = new Date(),
  ): Promise<{ completion: MfaLoginCompletion; result: T }> {
    if (!MFA_LOGIN.CHALLENGE_TOKEN_PATTERN.test(input.challengeToken)) {
      throw this.invalidChallenge();
    }
    const tokenHash = hashMfaToken(input.challengeToken);
    const authId = await this.guard(() =>
      this.repository.loginChallengeOwner(tokenHash),
    );
    if (!authId) throw this.invalidChallenge();

    const outcome = await this.guard(() =>
      this.repository.withLock<CompleteOutcome<T>>(authId, async (uow) => {
        // Under the owner's lock: concurrent completions are serialized, so
        // a challenge is used at most once.
        const challenge = await uow.loginChallenge(tokenHash);
        if (
          !challenge ||
          challenge.consumedAt ||
          challenge.expiresAt.getTime() <= now.getTime()
        ) {
          return { kind: 'CHALLENGE_INVALID' };
        }
        let method: MfaLoginMethod;
        if (input.factor.method === 'sms') {
          // Sign-in only: an SMS code never trusts a device (and never
          // counts as the session's MFA proof).
          if (!this.sms || input.trustDevice) {
            return {
              kind: 'SMS_DECLINED',
              outcome: { kind: 'NOT_AVAILABLE' },
            };
          }
          const smsChecked = await this.sms.checkSignInCode(
            uow.tx,
            authId,
            challenge.id,
            input.factor.code,
            { ip: input.meta.ip, userAgent: input.meta.userAgent },
            now,
          );
          if (smsChecked.kind !== 'VERIFIED') {
            return { kind: 'SMS_DECLINED', outcome: smsChecked };
          }
          method = 'sms';
        } else {
          const checked = await this.verification.checkFactor(
            uow,
            authId,
            input.factor,
            {
              ip: input.meta.ip,
              userAgent: input.meta.userAgent,
              device: input.meta.device,
            },
            now,
            { source: 'sign_in' },
          );
          if (checked.kind !== 'VERIFIED') {
            return { kind: 'DECLINED', outcome: checked };
          }
          method = checked.method;
        }
        if (!(await uow.consumeLoginChallenge(challenge.id, now))) {
          // Cannot happen under the lock; roll everything back if it does.
          throw new Error('MFA challenge was consumed concurrently');
        }

        let trustedDevice: NewTrustedDevice | null = null;
        if (input.trustDevice) {
          const token = newToken('mfatd');
          const name = deviceName(input.deviceName, input.meta);
          const expiresAt = new Date(
            now.getTime() + MFA_LOGIN.TRUSTED_DEVICE_TTL_MS,
          );
          const { id, revokedIds } = await uow.createTrustedDevice(
            {
              tokenHash: hashMfaToken(token),
              name,
              ipAddress: input.meta.ip,
              userAgent: input.meta.userAgent,
              createdAt: now,
              expiresAt,
            },
            MFA_LOGIN.MAX_TRUSTED_DEVICES,
          );
          trustedDevice = { id, token, name, expiresAt };
          const context = {
            ip: input.meta.ip,
            userAgent: input.meta.userAgent,
          };
          await uow.recordEvent({
            type: 'TRUSTED_DEVICE_ADDED',
            context,
            details: {
              deviceId: id,
              name,
              expiresAt: expiresAt.toISOString(),
            },
            now,
          });
          if (revokedIds.length > 0) {
            await uow.recordEvent({
              type: 'TRUSTED_DEVICE_REVOKED',
              context,
              details: {
                reason: 'device_limit',
                count: revokedIds.length,
                deviceIds: revokedIds,
              },
              now,
            });
          }
        }
        const completion: MfaLoginCompletion = {
          authId,
          provider: challenge.provider === 'google' ? 'google' : 'local',
          method,
          trustedDevice,
        };
        // Same transaction: a failure here undoes everything above.
        const result = await issue(uow.tx, completion);
        return { kind: 'VERIFIED', completion, result };
      }),
    );

    if (outcome.kind === 'CHALLENGE_INVALID') throw this.invalidChallenge();
    if (outcome.kind === 'DECLINED') {
      throw this.verification.declinedError(authId, outcome.outcome);
    }
    if (outcome.kind === 'SMS_DECLINED') {
      if (!this.sms) {
        throw AppError.conflict('SMS verification is not available');
      }
      throw this.sms.declinedError(authId, outcome.outcome);
    }
    this.logger.info('MFA sign-in completed', {
      context: CONTEXT,
      authId,
      method: outcome.completion.method,
      trustedDevice: outcome.completion.trustedDevice?.id ?? null,
    });
    return { completion: outcome.completion, result: outcome.result };
  }

  /** The user's trusted devices (never their tokens). */
  async listTrustedDevices(
    authId: string,
    currentToken?: string | null,
    now: Date = new Date(),
  ): Promise<TrustedDeviceListItem[]> {
    return this.guard(async () => {
      const currentHash = trustedDeviceTokenHash(currentToken);
      const [devices, currentId] = await Promise.all([
        this.repository.listTrustedDevices(authId, now),
        currentHash
          ? this.repository.trustedDeviceIdByToken(authId, currentHash)
          : Promise.resolve(null),
      ]);
      return devices.map((device) => ({
        ...device,
        current: device.id === currentId,
      }));
    });
  }

  /** Revokes one of the user's trusted devices; 404 for any other device. */
  async revokeTrustedDevice(
    authId: string,
    deviceId: string,
    now: Date = new Date(),
    context: SecurityEventContext = {},
  ): Promise<{ id: string; revoked: true }> {
    const found = await this.guard(() =>
      this.repository.revokeTrustedDevice(authId, deviceId, now, context),
    );
    if (!found) throw AppError.notFound('Trusted device not found');
    this.logger.info('Trusted device revoked', {
      context: CONTEXT,
      authId,
      deviceId,
    });
    return { id: deviceId, revoked: true };
  }

  private invalidChallenge(): AppError {
    return AppError.unauthorized(
      'The MFA challenge is invalid or has expired. Please sign in again.',
    );
  }

  private guard<T>(operation: () => Promise<T>): Promise<T> {
    return guardMfaStorage(this.logger, CONTEXT, operation);
  }
}

/** SHA-256 of a well-formed trusted-device token; null for anything else. */
export function trustedDeviceTokenHash(
  token: string | null | undefined,
): string | null {
  if (!token || !MFA_LOGIN.TRUSTED_DEVICE_TOKEN_PATTERN.test(token)) {
    return null;
  }
  return hashMfaToken(token);
}

function deviceName(requested: string | undefined, meta: MfaLoginMeta) {
  const name =
    requested?.trim() || meta.device?.trim() || meta.userAgent?.trim() || '';
  return (name && name !== 'unknown' ? name : 'Unknown device').slice(0, 100);
}
