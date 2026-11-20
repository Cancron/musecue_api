import { Inject, Injectable } from '@nestjs/common';
import type { MfaSmsCodePurpose, StepUpMethod } from '@prisma/client';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'winston';
import AppError from '../../../common/errors/app.error';
import type { ActivityLogMetadata } from '../../../common/services/activity-log.service';
import { PrismaService } from '../../../common/services/prisma.service';
import type { SecurityEventContext } from '../../security-events/security-event.log';
import { guardMfaStorage, requireActiveAccount } from '../mfa-errors';
import { MfaSecretCipher } from '../mfa-secret.cipher';
import {
  MfaSecurityNotifier,
  type PendingSecurityNotification,
} from '../mfa-security-notifier';
import { MFA_AUDIT_FIELDS } from '../mfa.constants';
import { MfaRepository, type MfaUnitOfWork } from '../mfa.repository';
import {
  generateSmsCode,
  maskedPhone,
  normalizePhoneNumber,
  phoneHintOf,
  smsLimit,
  smsMessage,
  withUse,
} from './mfa-sms-codes';
import { MFA_SMS } from './mfa-sms.constants';
import { MfaSmsStore, type SmsAccountState } from './mfa-sms.store';
import { SMS_PROVIDER, type SmsProvider } from './sms-provider';

/** GET /auth/mfa/sms: never the number itself, never a code. */
export interface MfaSmsStatusView {
  /** Whether SMS can be sent at all (provider and MFA key configured). */
  available: boolean;
  /** Whether the account may use SMS: MFA enabled with an authenticator. */
  eligible: boolean;
  /** A verified number receives sign-in codes. */
  enabled: boolean;
  phoneNumber: string | null;
  verifiedAt: Date | null;
  /** A number being verified (added or replacing the current one). */
  pending: { phoneNumber: string; codeExpiresAt: Date | null } | null;
  deliveriesRemaining: number;
  attemptsRemaining: number;
}

export interface SmsCodeSentView {
  sent: true;
  phoneNumber: string;
  expiresAt: Date;
  deliveriesRemaining: number;
}

/** How a phone change was made (request and approval; never a secret). */
export interface SmsChangeContext {
  metadata: ActivityLogMetadata;
  sessionId?: string;
  approvedWith?: StepUpMethod;
}

/** The result of checking a sign-in SMS code inside the MFA transaction. */
export type SmsLoginCheck =
  | { kind: 'VERIFIED' }
  | { kind: 'REFUSED'; error: AppError };

type Locked<T> =
  | { kind: 'OK'; value: T }
  | { kind: 'REFUSED'; error: AppError };

/** A code to deliver once its transaction committed. */
interface Delivery {
  codeId: string;
  to: string;
  code: string;
  purpose: 'sign_in' | 'phone';
}

const CONTEXT = 'MfaSmsService';

const eventContext = (change: SmsChangeContext): SecurityEventContext => ({
  ip: change.metadata.ip,
  userAgent: change.metadata.userAgent,
  sessionId: change.sessionId ?? null,
});

/**
 * Optional SMS sign-in verification for users with authenticator-app MFA:
 *
 * - phone numbers are added (or replaced) by verifying an SMS code, and
 *   removed, each with a step-up approval (enforced on the routes);
 * - at sign-in, an MFA challenge can send a code to the verified number and
 *   be completed with it (MfaLoginService). SMS never counts as a step-up or
 *   an administrator's MFA proof.
 *
 * Codes are six CSPRNG digits, stored only as an HMAC, valid for 5 minutes,
 * used once; sending a new code for the same purpose invalidates the
 * previous one, and replacing or removing a number invalidates every code
 * sent to it, in the same transaction. At most 3 codes are sent and at most
 * 5 codes are checked per user within any 15 minutes. Everything runs under
 * the user's MFA lock (MfaRepository.withLock).
 */
@Injectable()
export class MfaSmsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: MfaRepository,
    private readonly cipher: MfaSecretCipher,
    private readonly notifier: MfaSecurityNotifier,
    @Inject(SMS_PROVIDER) private readonly provider: SmsProvider,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  /** Whether SMS can be sent (provider and MFA key configured). */
  get available(): boolean {
    return this.provider.available && this.cipher.available;
  }

  async status(
    authId: string,
    now: Date = new Date(),
  ): Promise<MfaSmsStatusView> {
    return this.guard(() =>
      this.prisma.$transaction(async (tx) => {
        const store = new MfaSmsStore(tx, authId);
        const account = await store.account();
        const active = await store.phone('ACTIVE');
        const pending = await store.phone('PENDING');
        const pendingCode = pending
          ? (
              await store.usableCodes(
                { phoneId: pending.id, purpose: 'PHONE_VERIFICATION' },
                now,
              )
            )[0]
          : undefined;
        return {
          available: this.available,
          eligible: eligible(account),
          enabled: !!active,
          phoneNumber: active ? maskedPhone(active.phoneHint) : null,
          verifiedAt: active?.verifiedAt ?? null,
          pending: pending
            ? {
                phoneNumber: maskedPhone(pending.phoneHint),
                codeExpiresAt: pendingCode?.expiresAt ?? null,
              }
            : null,
          deliveriesRemaining: smsLimit(
            account?.sentAt ?? [],
            now,
            MFA_SMS.MAX_DELIVERIES,
          ).remaining,
          attemptsRemaining: smsLimit(
            account?.attemptsAt ?? [],
            now,
            MFA_SMS.MAX_ATTEMPTS,
          ).remaining,
        };
      }),
    );
  }

  /**
   * Adds a number, or starts replacing the verified one: the number becomes
   * PENDING (a previous pending number is discarded, its codes invalidated)
   * and a verification code is sent to it. The verified number keeps
   * working until the new one is verified.
   */
  async startPhone(
    authId: string,
    phoneNumber: string,
    change: SmsChangeContext,
    now: Date = new Date(),
  ) {
    const e164 = normalizePhoneNumber(phoneNumber);
    if (!e164) {
      throw AppError.badRequest(
        'phoneNumber must be an international number, for example +14155550123',
      );
    }
    this.requireAvailable();
    const outcome = await this.locked(authId, async (uow, store) => {
      requireActiveAccount(await uow.account());
      const account = await store.account();
      if (!eligible(account)) return refuse(notEligible());
      const limit = smsLimit(account!.sentAt, now, MFA_SMS.MAX_DELIVERIES);
      if (limit.remaining === 0) return refuse(tooManySent(limit.retryAt!));

      const active = await store.phone('ACTIVE');
      if (
        active &&
        this.cipher.decrypt('sms-phone', authId, active.phoneNumber) === e164
      ) {
        return refuse(
          AppError.conflict(
            'This phone number is already verified for SMS codes',
          ),
        );
      }
      const previous = await store.phone('PENDING');
      if (previous) await store.revokePhone(previous.id, 'superseded', now);

      const phone = await store.createPendingPhone({
        encryptedNumber: this.cipher.encrypt('sms-phone', authId, e164),
        phoneHint: phoneHintOf(e164),
        now,
      });
      const delivery = await this.issueCode(store, account!, {
        authId,
        phoneId: phone.id,
        to: e164,
        purpose: 'PHONE_VERIFICATION',
        loginChallengeId: null,
        expiresAt: new Date(now.getTime() + MFA_SMS.CODE_TTL_MS),
        now,
      });
      await uow.recordEvent({
        type: 'MFA_SMS_PHONE_VERIFICATION_STARTED',
        context: eventContext(change),
        details: {
          phone: maskedPhone(phone.phoneHint),
          replacing: !!active,
          approvedWith: change.approvedWith ?? null,
        },
        now,
      });
      return ok({
        delivery,
        view: {
          status: 'PENDING' as const,
          phoneNumber: maskedPhone(phone.phoneHint),
          replaces: active ? maskedPhone(active.phoneHint) : null,
          codeExpiresAt: delivery.expiresAt,
          deliveriesRemaining: limit.remaining - 1,
        },
      });
    });
    await this.deliver(authId, outcome.delivery);
    this.logger.info('SMS phone verification started', {
      context: CONTEXT,
      authId,
    });
    return outcome.view;
  }

  /**
   * Verifies the pending number with the code sent to it. It becomes the
   * verified number; a previously verified number is revoked and every code
   * sent to it invalidated, in the same transaction.
   */
  async confirmPhone(
    authId: string,
    code: string,
    change: SmsChangeContext,
    now: Date = new Date(),
  ): Promise<MfaSmsStatusView> {
    const result = await this.locked(authId, async (uow, store) => {
      requireActiveAccount(await uow.account());
      const account = await store.account();
      if (!eligible(account)) return refuse(notEligible());
      const pending = await store.phone('PENDING');
      if (!pending) {
        return refuse(
          AppError.conflict(
            'No phone number is waiting for verification. Add one first.',
          ),
        );
      }
      const checked = await this.checkCode(uow, store, account!, {
        authId,
        phoneId: pending.id,
        purpose: 'PHONE_VERIFICATION',
        code,
        context: 'phone_verification',
        eventContext: eventContext(change),
        now,
      });
      if (checked.kind === 'REFUSED') return checked;

      const active = await store.phone('ACTIVE');
      let invalidated = 0;
      if (active)
        invalidated = await store.revokePhone(active.id, 'replaced', now);
      await store.activatePhone(pending.id, now);
      const metadata = { ...change.metadata, actionedBy: authId };
      await uow.audit(
        [
          {
            fieldName: MFA_AUDIT_FIELDS.SMS_PHONE,
            oldValue: active ? maskedPhone(active.phoneHint) : null,
            newValue: maskedPhone(pending.phoneHint),
          },
          ...(change.approvedWith
            ? [
                {
                  fieldName: MFA_AUDIT_FIELDS.STEP_UP_METHOD,
                  oldValue: null,
                  newValue: change.approvedWith,
                },
              ]
            : []),
        ],
        metadata,
      );
      await uow.recordEvent({
        type: active ? 'MFA_SMS_PHONE_REPLACED' : 'MFA_SMS_ENABLED',
        context: eventContext(change),
        details: {
          phone: maskedPhone(pending.phoneHint),
          previousPhone: active ? maskedPhone(active.phoneHint) : null,
          codesInvalidated: invalidated,
          approvedWith: change.approvedWith ?? null,
        },
        now,
      });
      const notification = await this.notifier.record(uow.tx, {
        authId,
        event: active ? 'MFA_SMS_PHONE_REPLACED' : 'MFA_SMS_PHONE_ADDED',
        metadata,
        now,
      });
      return ok(notification);
    });
    await this.notifier.dispatch(result);
    this.logger.info('SMS phone verified', { context: CONTEXT, authId });
    return this.status(authId, now);
  }

  /**
   * Removes the verified and any pending number: both are revoked and every
   * code sent to them invalidated, in one transaction. 404 without any.
   */
  async removePhone(
    authId: string,
    change: SmsChangeContext,
    now: Date = new Date(),
  ): Promise<MfaSmsStatusView & { removed: true }> {
    const result = await this.locked(authId, async (uow, store) => {
      requireActiveAccount(await uow.account());
      const active = await store.phone('ACTIVE');
      const { phones, codes } = await store.revokeAllPhones('removed', now);
      if (phones === 0) {
        return refuse(
          AppError.notFound('No phone number is set up for SMS codes'),
        );
      }
      const metadata = { ...change.metadata, actionedBy: authId };
      let notification: PendingSecurityNotification | null = null;
      if (active) {
        await uow.audit(
          [
            {
              fieldName: MFA_AUDIT_FIELDS.SMS_PHONE,
              oldValue: maskedPhone(active.phoneHint),
              newValue: null,
            },
            ...(change.approvedWith
              ? [
                  {
                    fieldName: MFA_AUDIT_FIELDS.STEP_UP_METHOD,
                    oldValue: null,
                    newValue: change.approvedWith,
                  },
                ]
              : []),
          ],
          metadata,
        );
        notification = await this.notifier.record(uow.tx, {
          authId,
          event: 'MFA_SMS_PHONE_REMOVED',
          metadata,
          now,
        });
      }
      await uow.recordEvent({
        type: 'MFA_SMS_DISABLED',
        context: eventContext(change),
        details: {
          phone: active ? maskedPhone(active.phoneHint) : null,
          numbersRemoved: phones,
          codesInvalidated: codes,
          approvedWith: change.approvedWith ?? null,
        },
        now,
      });
      return ok(notification);
    });
    if (result) await this.notifier.dispatch(result);
    this.logger.info('SMS phone removed', { context: CONTEXT, authId });
    return { ...(await this.status(authId, now)), removed: true };
  }

  /**
   * The masked verified number when the user can receive sign-in codes
   * (SMS available, authenticator MFA on, a verified number); else null.
   */
  async loginPhone(authId: string): Promise<string | null> {
    if (!this.available) return null;
    const phone = await this.prisma.mfaSmsPhone.findFirst({
      where: {
        authId,
        status: 'ACTIVE',
        authUser: {
          authSecurity: { mfaEnabled: true, mfaMethod: 'totp' },
        },
      },
      select: { phoneHint: true },
    });
    return phone ? maskedPhone(phone.phoneHint) : null;
  }

  /**
   * Sends a sign-in code for an MFA challenge to the verified number (the
   * previous code of that challenge stops working). `challenge` is the
   * challenge as read under the user's lock.
   */
  async sendLoginCode(
    uow: MfaUnitOfWork,
    authId: string,
    challenge: { id: string; expiresAt: Date },
    meta: { ip: string; userAgent: string },
    now: Date,
  ): Promise<
    Locked<{ delivery: Delivery & { expiresAt: Date }; view: SmsCodeSentView }>
  > {
    const store = new MfaSmsStore(uow.tx, authId);
    const account = await store.account();
    const active = eligible(account) ? await store.phone('ACTIVE') : null;
    if (!active) return refuse(notSetUp());
    if (!this.available) return refuse(unavailable());
    const limit = smsLimit(account!.sentAt, now, MFA_SMS.MAX_DELIVERIES);
    if (limit.remaining === 0) return refuse(tooManySent(limit.retryAt!));

    await store.invalidateCodes(
      { purpose: 'LOGIN', loginChallengeId: challenge.id },
      now,
    );
    const expiresAt = new Date(
      Math.min(
        now.getTime() + MFA_SMS.CODE_TTL_MS,
        challenge.expiresAt.getTime(),
      ),
    );
    const to = this.cipher.decrypt('sms-phone', authId, active.phoneNumber);
    if (this.cipher.needsReencryption(active.phoneNumber)) {
      // After an MFA key rotation: moved to the current key on use.
      await store.updatePhoneNumber(
        active.id,
        this.cipher.encrypt('sms-phone', authId, to),
      );
    }
    const delivery = await this.issueCode(store, account!, {
      authId,
      phoneId: active.id,
      to,
      purpose: 'LOGIN',
      loginChallengeId: challenge.id,
      expiresAt,
      now,
    });
    await uow.recordEvent({
      type: 'MFA_SMS_CODE_SENT',
      context: { ip: meta.ip, userAgent: meta.userAgent },
      details: { context: 'sign_in', phone: maskedPhone(active.phoneHint) },
      now,
    });
    return ok({
      delivery,
      view: {
        sent: true as const,
        phoneNumber: maskedPhone(active.phoneHint),
        expiresAt,
        deliveriesRemaining: limit.remaining - 1,
      },
    });
  }

  /** Hands a committed code to the SMS provider (see `deliver`). */
  async deliverLoginCode(authId: string, delivery: Delivery): Promise<void> {
    await this.deliver(authId, delivery);
  }

  /**
   * Checks a sign-in SMS code for an MFA challenge inside the MFA
   * transaction. Refusals are returned (not thrown) so the counted attempt
   * commits.
   */
  async checkLoginCode(
    uow: MfaUnitOfWork,
    authId: string,
    challengeId: string,
    code: string,
    meta: { ip: string; userAgent: string },
    now: Date,
  ): Promise<SmsLoginCheck> {
    const store = new MfaSmsStore(uow.tx, authId);
    const account = await store.account();
    const active = eligible(account) ? await store.phone('ACTIVE') : null;
    if (!active) return refuse(notSetUp());
    const checked = await this.checkCode(uow, store, account!, {
      authId,
      phoneId: active.id,
      purpose: 'LOGIN',
      loginChallengeId: challengeId,
      code,
      context: 'sign_in',
      eventContext: { ip: meta.ip, userAgent: meta.userAgent },
      now,
    });
    return checked.kind === 'OK' ? { kind: 'VERIFIED' } : checked;
  }

  /**
   * Creates a code for `to` (inside the transaction) and counts the
   * delivery; it is sent once the transaction committed.
   */
  private async issueCode(
    store: MfaSmsStore,
    account: SmsAccountState,
    input: {
      authId: string;
      phoneId: string;
      to: string;
      purpose: MfaSmsCodePurpose;
      loginChallengeId: string | null;
      expiresAt: Date;
      now: Date;
    },
  ): Promise<Delivery & { expiresAt: Date }> {
    const code = generateSmsCode();
    const codeId = randomUUID();
    await store.createCode({
      id: codeId,
      phoneId: input.phoneId,
      purpose: input.purpose,
      loginChallengeId: input.loginChallengeId,
      codeHash: this.cipher.hashSmsCode(
        binding(input.authId, input.phoneId, codeId, input.purpose),
        code,
      ),
      createdAt: input.now,
      expiresAt: input.expiresAt,
    });
    await store.saveSent(
      withUse(account.sentAt, input.now, MFA_SMS.MAX_DELIVERIES),
    );
    return {
      codeId,
      to: input.to,
      code,
      purpose: input.purpose === 'LOGIN' ? 'sign_in' : 'phone',
      expiresAt: input.expiresAt,
    };
  }

  /**
   * Counts an attempt (refused beyond 5 in 15 minutes, without checking)
   * and checks `code` against the usable codes of the number and purpose; a
   * match is used up. A wrong, expired, used or invalidated code is refused
   * alike, and recorded in the security history.
   */
  private async checkCode(
    uow: MfaUnitOfWork,
    store: MfaSmsStore,
    account: SmsAccountState,
    input: {
      authId: string;
      phoneId: string;
      purpose: MfaSmsCodePurpose;
      loginChallengeId?: string;
      code: string;
      context: 'sign_in' | 'phone_verification';
      eventContext: SecurityEventContext;
      now: Date;
    },
  ): Promise<Locked<true>> {
    const { now } = input;
    const limit = smsLimit(account.attemptsAt, now, MFA_SMS.MAX_ATTEMPTS);
    if (limit.remaining === 0) return refuse(tooManyAttempts(limit.retryAt!));
    const attempts = withUse(account.attemptsAt, now, MFA_SMS.MAX_ATTEMPTS);
    await store.saveAttempts(attempts);

    const candidates = await store.usableCodes(
      {
        phoneId: input.phoneId,
        purpose: input.purpose,
        ...(input.loginChallengeId
          ? { loginChallengeId: input.loginChallengeId }
          : {}),
      },
      now,
    );
    const match = candidates.find((candidate) =>
      this.cipher.verifySmsCode(
        candidate.codeHash,
        binding(input.authId, candidate.phoneId, candidate.id, input.purpose),
        input.code,
      ),
    );
    if (match && (await store.consumeCode(match.id, now))) {
      return ok(true);
    }

    const after = smsLimit(attempts, now, MFA_SMS.MAX_ATTEMPTS);
    await uow.recordEvent({
      type:
        after.remaining === 0
          ? 'MFA_VERIFICATION_BLOCKED'
          : 'MFA_VERIFICATION_FAILED',
      context: input.eventContext,
      details:
        after.remaining === 0
          ? {
              context: input.context,
              method: 'sms',
              blockedUntil: after.retryAt!.toISOString(),
            }
          : {
              context: input.context,
              method: 'sms',
              remainingAttempts: after.remaining,
            },
      now,
    });
    return refuse(
      AppError.badRequest(
        `Invalid or expired SMS code. ${after.remaining} attempt(s) remaining.`,
      ),
    );
  }

  /**
   * Sends a committed code. If the provider fails, the code is invalidated
   * (the delivery still counts toward the limit) and the request answers
   * 503. Neither the code nor the number is ever logged.
   */
  private async deliver(authId: string, delivery: Delivery): Promise<void> {
    try {
      await this.provider.send(
        delivery.to,
        smsMessage(delivery.code, delivery.purpose),
      );
    } catch (error) {
      this.logger.warn('SMS could not be sent', {
        context: CONTEXT,
        authId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      await this.prisma.mfaSmsCode
        .updateMany({
          where: {
            id: delivery.codeId,
            authId,
            consumedAt: null,
            invalidatedAt: null,
          },
          data: { invalidatedAt: new Date() },
        })
        .catch(() => undefined);
      throw AppError.serviceUnavailable(
        'The SMS could not be sent. Please try again later.',
      );
    }
  }

  /** Runs `work` under the user's MFA lock; refusals commit, then throw. */
  private async locked<T>(
    authId: string,
    work: (uow: MfaUnitOfWork, store: MfaSmsStore) => Promise<Locked<T>>,
  ): Promise<T> {
    const outcome = await this.guard(() =>
      this.repository.withLock(authId, (uow) =>
        work(uow, new MfaSmsStore(uow.tx, authId)),
      ),
    );
    if (outcome.kind === 'REFUSED') throw outcome.error;
    return outcome.value;
  }

  private requireAvailable() {
    if (!this.available) throw unavailable();
  }

  private guard<T>(operation: () => Promise<T>): Promise<T> {
    return guardMfaStorage(this.logger, CONTEXT, operation);
  }
}

/** What a code hash is bound to. */
const binding = (
  authId: string,
  phoneId: string,
  codeId: string,
  purpose: MfaSmsCodePurpose,
) => [authId, phoneId, codeId, purpose].join('\u0000');

/** SMS is only for users with MFA enabled with an authenticator app. */
function eligible(account: SmsAccountState | null): boolean {
  return !!account?.mfaEnabled && account.mfaMethod === 'totp';
}

const ok = <T>(value: T): Locked<T> => ({ kind: 'OK', value });
const refuse = (error: AppError): { kind: 'REFUSED'; error: AppError } => ({
  kind: 'REFUSED',
  error,
});

const notEligible = () =>
  AppError.conflict(
    'SMS verification needs MFA with an authenticator app. Enable it first.',
  );
const notSetUp = () =>
  AppError.conflict('SMS verification is not set up for this account');
const unavailable = () =>
  AppError.serviceUnavailable('SMS verification is not available');
const tooManySent = (retryAt: Date) =>
  AppError.tooManyRequests(
    `Too many SMS codes were sent. Try again after ${retryAt.toISOString()}.`,
  );
const tooManyAttempts = (retryAt: Date) =>
  AppError.tooManyRequests(
    `Too many SMS codes were entered. Try again after ${retryAt.toISOString()}.`,
  );
