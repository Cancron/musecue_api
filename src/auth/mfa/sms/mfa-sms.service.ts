import { Inject, Injectable } from '@nestjs/common';
import type { MfaSmsCodePurpose, Prisma } from '@prisma/client';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Logger } from 'winston';
import AppError from '../../../common/errors/app.error';
import type { SecurityEventContext } from '../../security-events/security-event.log';
import { guardMfaStorage, requireActiveAccount } from '../mfa-errors';
import { hashMfaToken } from '../mfa-login.service';
import { MfaSecretCipher } from '../mfa-secret.cipher';
import {
  MfaSecurityNotifier,
  type PendingSecurityNotification,
} from '../mfa-security-notifier';
import { MFA_LOGIN, MFA_SMS } from '../mfa.constants';
import type { MfaChangeContext } from '../mfa.service';
import { maskPhoneNumber, normalizePhoneNumber } from './mfa-phone-number';
import {
  MfaSmsRepository,
  type MfaSmsUnitOfWork,
  type SmsAccountState,
} from './mfa-sms.repository';
import { SMS_SENDER, type SmsSender } from './sms-sender';

export type SmsPhoneMode = 'enrollment' | 'replacement';

export interface SmsStatusView {
  /** SMS can be used: authenticator MFA is on and SMS delivery works. */
  available: boolean;
  /** A verified phone number is registered. */
  enabled: boolean;
  phone: { maskedNumber: string; verifiedAt: Date } | null;
  /** A phone number waiting for its verification code. */
  pending: {
    purpose: SmsPhoneMode;
    maskedNumber: string;
    expiresAt: Date;
  } | null;
}

export interface SmsCodeSentView {
  purpose: SmsPhoneMode | 'sign_in';
  maskedNumber: string;
  expiresAt: Date;
  /** SMS codes that can still be sent within the current 15 minutes. */
  deliveriesRemaining: number;
}

export type SmsCheckOutcome =
  | { kind: 'VERIFIED' }
  | { kind: 'NOT_AVAILABLE' }
  | { kind: 'BLOCKED'; until: Date }
  | { kind: 'INVALID'; remainingAttempts: number };

type Refusal =
  | { kind: 'NOT_AVAILABLE' }
  | { kind: 'CHALLENGE_INVALID' }
  | { kind: 'ALREADY_ENROLLED' }
  | { kind: 'NO_PHONE' }
  | { kind: 'SAME_NUMBER' }
  | { kind: 'NO_VERIFICATION' }
  | { kind: 'DELIVERY_LIMIT'; until: Date }
  | { kind: 'BLOCKED'; until: Date }
  | { kind: 'INVALID'; remainingAttempts: number };

interface Delivery {
  kind: 'SEND';
  codeId: string;
  to: string;
  body: string;
  maskedNumber: string;
  expiresAt: Date;
  deliveriesRemaining: number;
}

const CONTEXT = 'MfaSmsService';
const PURPOSE: Record<SmsPhoneMode, MfaSmsCodePurpose> = {
  enrollment: 'PHONE_ENROLLMENT',
  replacement: 'PHONE_REPLACEMENT',
};
const PHONE_PURPOSES: MfaSmsCodePurpose[] = [
  'PHONE_ENROLLMENT',
  'PHONE_REPLACEMENT',
];

/** A uniformly random six-digit code (CSPRNG). */
export function generateSmsCode(): string {
  return String(randomInt(0, 10 ** MFA_SMS.DIGITS)).padStart(
    MFA_SMS.DIGITS,
    '0',
  );
}

/** Times within the last `windowMs` (sliding window), oldest first. */
export function recentTimes(dates: Date[], now: Date, windowMs: number) {
  return dates
    .filter((d) => d.getTime() > now.getTime() - windowMs)
    .sort((a, b) => a.getTime() - b.getTime());
}

/**
 * A limit of `max` events per `windowMs`: either the next list of times
 * (this event included) or the time the limit frees up.
 */
export function slidingLimit(
  dates: Date[],
  now: Date,
  max: number,
  windowMs: number,
): { next: Date[]; remaining: number } | { blockedUntil: Date } {
  const recent = recentTimes(dates, now, windowMs);
  if (recent.length >= max) {
    return { blockedUntil: new Date(recent[0].getTime() + windowMs) };
  }
  const next = [...recent, now];
  return { next, remaining: max - next.length };
}

/** The delivery limit: 3 SMS codes per user within any 15 minutes. */
const deliveryLimit = (account: SmsAccountState, now: Date) =>
  slidingLimit(
    account.deliveriesAt,
    now,
    MFA_SMS.MAX_DELIVERIES,
    MFA_SMS.DELIVERY_WINDOW_MS,
  );

/** SMS needs authenticator MFA: it is never the only second factor. */
const smsAllowed = (account: SmsAccountState) =>
  account.mfaEnabled && account.mfaMethod === 'totp';

const smsBody = (purpose: MfaSmsCodePurpose, code: string) =>
  purpose === 'SIGN_IN'
    ? `${code} is your MuseCue sign-in code. It expires in 5 minutes. Never share it: MuseCue will never ask you for it.`
    : `${code} is your MuseCue code to verify this phone number. It expires in 5 minutes. Never share it.`;

/**
 * Optional SMS verification for users with authenticator MFA:
 *
 * - Phone numbers are registered (enrollment), replaced and removed by their
 *   owner; the routes require step-up approvals (MFA_SMS_ENROLLMENT,
 *   MFA_SMS_REPLACE, MFA_SMS_DISABLE), and a new number must be verified
 *   with a code sent to it. Replacing or removing the number invalidates
 *   every open SMS code at once.
 * - At sign-in, an MFA challenge can be completed with a code sent to the
 *   verified number (POST /auth/login/mfa/sms, then POST /auth/login/mfa
 *   with `smsCode`). SMS is accepted nowhere else: not for step-up, not for
 *   POST /auth/mfa/verify, and an SMS sign-in is never an administrator MFA
 *   proof.
 *
 * Codes are six random digits (CSPRNG), stored only as HMAC-SHA256 (keyed
 * from MFA_ENCRYPTION_KEY), valid for 5 minutes and once. At most 3 codes are
 * sent and 5 checked per user within any 15 minutes. Numbers are stored
 * encrypted; only masked numbers are shown or recorded, and neither numbers
 * nor codes are logged.
 */
@Injectable()
export class MfaSmsService {
  constructor(
    private readonly repository: MfaSmsRepository,
    private readonly cipher: MfaSecretCipher,
    private readonly notifier: MfaSecurityNotifier,
    @Inject(SMS_SENDER) private readonly sender: SmsSender,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  /** Whether SMS codes can be sent at all (a provider is configured). */
  get deliveryConfigured(): boolean {
    return this.sender.configured;
  }

  async status(authId: string, now: Date = new Date()): Promise<SmsStatusView> {
    const state = await this.guard(() => this.repository.read(authId));
    const authenticator = state.mfaEnabled && state.mfaMethod === 'totp';
    const pending =
      state.pending && state.pending.expiresAt.getTime() > now.getTime()
        ? state.pending
        : null;
    return {
      available: authenticator && this.sender.configured,
      enabled: authenticator && state.phone !== null,
      phone: state.phone,
      pending: pending
        ? {
            purpose:
              pending.purpose === 'PHONE_REPLACEMENT'
                ? 'replacement'
                : 'enrollment',
            maskedNumber: pending.maskedNumber,
            expiresAt: pending.expiresAt,
          }
        : null,
    };
  }

  /**
   * The masked verified number when SMS can complete this user's sign-in
   * challenge (authenticator MFA, a verified number, delivery configured).
   */
  async signInPhone(authId: string): Promise<string | null> {
    if (!this.sender.configured) return null;
    const state = await this.repository.read(authId);
    return state.mfaEnabled && state.mfaMethod === 'totp' && state.phone
      ? state.phone.maskedNumber
      : null;
  }

  /**
   * Sends a verification code to a new number (enrollment: no number yet;
   * replacement: the current number keeps working until confirmed).
   */
  async startPhoneVerification(
    authId: string,
    mode: SmsPhoneMode,
    phoneNumber: string,
    context: SecurityEventContext,
    now: Date = new Date(),
  ): Promise<SmsCodeSentView> {
    const e164 = normalizePhoneNumber(phoneNumber);
    if (!e164) {
      throw AppError.badRequest(
        'phoneNumber must be an international number such as +14155550123',
      );
    }
    this.requireDelivery();
    const purpose = PURPOSE[mode];
    const outcome = await this.guard(() =>
      this.repository.withLock<Refusal | Delivery>(authId, async (uow) => {
        const account = requireActiveAccount(await uow.account());
        if (!smsAllowed(account)) return { kind: 'NOT_AVAILABLE' };
        const phone = await uow.phone();
        if (mode === 'enrollment' && phone) return { kind: 'ALREADY_ENROLLED' };
        if (mode === 'replacement') {
          if (!phone) return { kind: 'NO_PHONE' };
          if (
            this.cipher.decrypt('phone', authId, phone.phoneNumber) === e164
          ) {
            return { kind: 'SAME_NUMBER' };
          }
        }
        const limit = deliveryLimit(account, now);
        if ('blockedUntil' in limit) {
          return { kind: 'DELIVERY_LIMIT', until: limit.blockedUntil };
        }
        // A new verification replaces any earlier one.
        await uow.invalidateOpenCodes(now, { purposes: PHONE_PURPOSES });
        return this.issueCode(uow, authId, limit, {
          purpose,
          to: e164,
          phoneId: null,
          challengeId: null,
          destination: this.cipher.encrypt('phone', authId, e164),
          context,
          now,
        });
      }),
    );
    if (outcome.kind !== 'SEND') throw this.refusalError(outcome);
    await this.deliver(authId, outcome, purpose, now);
    return {
      purpose: mode,
      maskedNumber: outcome.maskedNumber,
      expiresAt: outcome.expiresAt,
      deliveriesRemaining: outcome.deliveriesRemaining,
    };
  }

  /**
   * Confirms the number being verified with the code sent to it: it becomes
   * (or replaces) the user's SMS number. Replacing it invalidates every open
   * SMS code, including sign-in codes sent to the previous number.
   */
  async confirmPhoneVerification(
    authId: string,
    mode: SmsPhoneMode,
    code: string,
    change: MfaChangeContext,
    now: Date = new Date(),
  ): Promise<SmsStatusView> {
    const context = changeEventContext(change);
    const outcome = await this.guard(() =>
      this.repository.withLock<
        Refusal | { kind: 'DONE'; notification: PendingSecurityNotification }
      >(authId, async (uow) => {
        const account = requireActiveAccount(await uow.account());
        if (!smsAllowed(account)) return { kind: 'NOT_AVAILABLE' };
        const phone = await uow.phone();
        if (mode === 'enrollment' && phone) return { kind: 'ALREADY_ENROLLED' };
        if (mode === 'replacement' && !phone) return { kind: 'NO_PHONE' };
        const pending = await uow.latestOpenCode({
          purposes: [PURPOSE[mode]],
        });
        if (!pending?.destination) return { kind: 'NO_VERIFICATION' };

        const checked = await this.checkCode(
          uow,
          authId,
          account,
          pending,
          code,
          now,
        );
        if (checked.kind !== 'VERIFIED') {
          await this.recordFailure(
            uow,
            checked,
            'phone_verification',
            context,
            now,
          );
          return checked;
        }

        const e164 = this.cipher.decrypt('phone', authId, pending.destination);
        const stored = {
          phoneNumber: this.cipher.encrypt('phone', authId, e164),
          maskedNumber: pending.maskedNumber,
          verifiedAt: now,
        };
        // Every open code ends: sign-in codes of the previous number and
        // any other verification.
        const codesInvalidated = await uow.invalidateOpenCodes(now);
        if (phone) await uow.replacePhone(phone.id, stored);
        else await uow.createPhone(stored);

        const metadata = { ...change.metadata, actionedBy: authId };
        await uow.audit(
          [
            {
              fieldName: 'mfaSmsPhone',
              oldValue: phone?.maskedNumber ?? null,
              newValue: pending.maskedNumber,
            },
            ...approvalChange(change),
          ],
          metadata,
        );
        await uow.recordEvent({
          type: phone ? 'MFA_SMS_PHONE_REPLACED' : 'MFA_SMS_ENABLED',
          context,
          details: {
            phone: pending.maskedNumber,
            previousPhone: phone?.maskedNumber ?? null,
            codesInvalidated,
            approvedWith: change.approvedWith ?? null,
          },
          now,
        });
        const notification = await this.notifier.record(uow.tx, {
          authId,
          event: phone ? 'MFA_SMS_PHONE_REPLACED' : 'MFA_SMS_ENABLED',
          metadata,
          now,
        });
        return { kind: 'DONE', notification };
      }),
    );
    if (outcome.kind !== 'DONE') throw this.refusalError(outcome);
    await this.notifier.dispatch(outcome.notification);
    this.logger.info(
      mode === 'enrollment' ? 'SMS phone added' : 'SMS phone replaced',
      { context: CONTEXT, authId },
    );
    return this.status(authId, now);
  }

  /**
   * Removes the user's SMS number: SMS can no longer complete a sign-in and
   * every open SMS code ends at once.
   */
  async removePhone(
    authId: string,
    change: MfaChangeContext,
    now: Date = new Date(),
  ): Promise<SmsStatusView> {
    const context = changeEventContext(change);
    const outcome = await this.guard(() =>
      this.repository.withLock<
        Refusal | { kind: 'DONE'; notification: PendingSecurityNotification }
      >(authId, async (uow) => {
        requireActiveAccount(await uow.account());
        const phone = await uow.phone();
        if (!phone) return { kind: 'NO_PHONE' };
        const codesInvalidated = await uow.invalidateOpenCodes(now);
        await uow.deletePhone();
        const metadata = { ...change.metadata, actionedBy: authId };
        await uow.audit(
          [
            {
              fieldName: 'mfaSmsPhone',
              oldValue: phone.maskedNumber,
              newValue: null,
            },
            ...approvalChange(change),
          ],
          metadata,
        );
        await uow.recordEvent({
          type: 'MFA_SMS_DISABLED',
          context,
          details: {
            phone: phone.maskedNumber,
            codesInvalidated,
            approvedWith: change.approvedWith ?? null,
          },
          now,
        });
        const notification = await this.notifier.record(uow.tx, {
          authId,
          event: 'MFA_SMS_DISABLED',
          metadata,
          now,
        });
        return { kind: 'DONE', notification };
      }),
    );
    if (outcome.kind !== 'DONE') throw this.refusalError(outcome);
    await this.notifier.dispatch(outcome.notification);
    this.logger.info('SMS phone removed', { context: CONTEXT, authId });
    return this.status(authId, now);
  }

  /**
   * Sends a sign-in code for an MFA challenge to the owner's verified
   * number. A new code ends the earlier codes of the same challenge.
   */
  async sendSignInCode(
    challengeToken: string,
    meta: { ip: string; userAgent: string },
    now: Date = new Date(),
  ): Promise<SmsCodeSentView> {
    if (!MFA_LOGIN.CHALLENGE_TOKEN_PATTERN.test(challengeToken)) {
      throw invalidChallenge();
    }
    const tokenHash = hashMfaToken(challengeToken);
    const authId = await this.guard(() =>
      this.repository.loginChallengeOwner(tokenHash),
    );
    if (!authId) throw invalidChallenge();
    this.requireDelivery();

    const outcome = await this.guard(() =>
      this.repository.withLock<Refusal | Delivery>(authId, async (uow) => {
        const challenge = await uow.openLoginChallenge(tokenHash, now);
        if (!challenge) return { kind: 'CHALLENGE_INVALID' };
        const account = requireActiveAccount(await uow.account());
        if (!smsAllowed(account)) return { kind: 'NOT_AVAILABLE' };
        const phone = await uow.phone();
        if (!phone) return { kind: 'NOT_AVAILABLE' };
        const limit = deliveryLimit(account, now);
        if ('blockedUntil' in limit) {
          return { kind: 'DELIVERY_LIMIT', until: limit.blockedUntil };
        }
        // A new code ends the earlier codes of this challenge.
        await uow.invalidateOpenCodes(now, { challengeId: challenge.id });
        return this.issueCode(uow, authId, limit, {
          purpose: 'SIGN_IN',
          to: this.cipher.decrypt('phone', authId, phone.phoneNumber),
          maskedNumber: phone.maskedNumber,
          phoneId: phone.id,
          challengeId: challenge.id,
          destination: null,
          context: { ip: meta.ip, userAgent: meta.userAgent },
          now,
        });
      }),
    );
    if (outcome.kind !== 'SEND') throw this.refusalError(outcome);
    await this.deliver(authId, outcome, 'SIGN_IN', now);
    return {
      purpose: 'sign_in',
      maskedNumber: outcome.maskedNumber,
      expiresAt: outcome.expiresAt,
      deliveriesRemaining: outcome.deliveriesRemaining,
    };
  }

  /**
   * Checks the SMS code of a sign-in challenge inside the sign-in's locked
   * transaction (see MfaLoginService). Every check counts toward the limit
   * of 5 per 15 minutes; a match is used up at once. Only a code sent for
   * this challenge to the currently verified number matches.
   */
  async checkSignInCode(
    tx: Prisma.TransactionClient,
    authId: string,
    challengeId: string,
    code: string,
    meta: { ip: string; userAgent: string },
    now: Date,
  ): Promise<SmsCheckOutcome> {
    const uow = this.repository.unitOfWork(tx, authId);
    const account = requireActiveAccount(await uow.account());
    if (!smsAllowed(account)) return { kind: 'NOT_AVAILABLE' };
    const phone = await uow.phone();
    if (!phone) return { kind: 'NOT_AVAILABLE' };
    const candidate = await uow.latestOpenCode({
      purposes: ['SIGN_IN'],
      challengeId,
    });
    const current =
      candidate &&
      candidate.phoneId === phone.id &&
      candidate.createdAt.getTime() >= phone.verifiedAt.getTime()
        ? candidate
        : null;
    const checked = await this.checkCode(
      uow,
      authId,
      account,
      current,
      code,
      now,
    );
    if (checked.kind !== 'VERIFIED') {
      await this.recordFailure(
        uow,
        checked,
        'sign_in',
        { ip: meta.ip, userAgent: meta.userAgent },
        now,
      );
    }
    return checked;
  }

  /** The HTTP error of a declined SMS check. */
  declinedError(
    authId: string,
    outcome: Exclude<SmsCheckOutcome, { kind: 'VERIFIED' }>,
  ): AppError {
    if (outcome.kind === 'INVALID') {
      this.logger.warn('Incorrect SMS code', {
        context: CONTEXT,
        authId,
        remainingAttempts: outcome.remainingAttempts,
      });
    }
    return this.refusalError(outcome);
  }

  /**
   * Counts the check (limit: 5 per 15 minutes) and compares the code with
   * `stored` (none: declined). A match is used up.
   */
  private async checkCode(
    uow: MfaSmsUnitOfWork,
    authId: string,
    account: SmsAccountState,
    stored: {
      id: string;
      purpose: MfaSmsCodePurpose;
      codeHash: string;
      expiresAt: Date;
      deliveredAt: Date | null;
    } | null,
    code: string,
    now: Date,
  ): Promise<SmsCheckOutcome> {
    const limit = slidingLimit(
      account.attemptsAt,
      now,
      MFA_SMS.MAX_ATTEMPTS,
      MFA_SMS.ATTEMPT_WINDOW_MS,
    );
    if ('blockedUntil' in limit) {
      return { kind: 'BLOCKED', until: limit.blockedUntil };
    }
    await uow.saveAttempts(limit.next);
    // Only a delivered, unexpired code can match.
    const matches =
      !!stored &&
      stored.deliveredAt !== null &&
      stored.expiresAt.getTime() > now.getTime() &&
      /^\d{6}$/.test(code) &&
      sameHash(
        stored.codeHash,
        this.codeHash(authId, stored.id, stored.purpose, code),
      );
    if (!matches || !(await uow.markCodeUsed(stored.id, now))) {
      return { kind: 'INVALID', remainingAttempts: limit.remaining };
    }
    return { kind: 'VERIFIED' };
  }

  private async recordFailure(
    uow: MfaSmsUnitOfWork,
    outcome: Exclude<SmsCheckOutcome, { kind: 'VERIFIED' }>,
    where: 'sign_in' | 'phone_verification',
    context: SecurityEventContext,
    now: Date,
  ) {
    if (outcome.kind !== 'INVALID') return;
    // History: never the code, only where it failed.
    await uow.recordEvent({
      type: 'MFA_VERIFICATION_FAILED',
      context,
      details: {
        context: where,
        method: 'sms',
        remainingAttempts: outcome.remainingAttempts,
      },
      now,
    });
  }

  /** Creates a code (counted against the delivery limit) to be sent. */
  private async issueCode(
    uow: MfaSmsUnitOfWork,
    authId: string,
    limit: { next: Date[]; remaining: number },
    input: {
      purpose: MfaSmsCodePurpose;
      to: string;
      maskedNumber?: string;
      phoneId: string | null;
      challengeId: string | null;
      destination: string | null;
      context: SecurityEventContext;
      now: Date;
    },
  ): Promise<Delivery> {
    const { now } = input;
    const id = randomUUID();
    const code = generateSmsCode();
    const maskedNumber = input.maskedNumber ?? maskPhoneNumber(input.to);
    const expiresAt = new Date(now.getTime() + MFA_SMS.CODE_TTL_MS);
    await uow.createCode({
      id,
      purpose: input.purpose,
      phoneId: input.phoneId,
      challengeId: input.challengeId,
      destination: input.destination,
      maskedNumber,
      codeHash: this.codeHash(authId, id, input.purpose, code),
      createdAt: now,
      expiresAt,
    });
    await uow.saveDeliveries(limit.next);
    await uow.recordEvent({
      type: 'MFA_SMS_CODE_SENT',
      context: input.context,
      details: { purpose: input.purpose.toLowerCase(), phone: maskedNumber },
      now,
    });
    return {
      kind: 'SEND',
      codeId: id,
      to: input.to,
      body: smsBody(input.purpose, code),
      maskedNumber,
      expiresAt,
      deliveriesRemaining: limit.remaining,
    };
  }

  /**
   * Hands the message to the provider after the code was committed (issued
   * undelivered, so unusable). Only once the provider accepted it is the code
   * marked delivered and usable. If sending or recording the delivery fails,
   * the code stays unusable (even if ending it below fails too), the
   * delivery is uncounted when possible, and the answer is 503.
   */
  private async deliver(
    authId: string,
    delivery: Delivery,
    purpose: MfaSmsCodePurpose,
    now: Date,
  ): Promise<void> {
    let sent = false;
    try {
      await this.sender.send(delivery.to, delivery.body);
      sent = true;
      await this.repository.markDelivered(authId, delivery.codeId, new Date());
      this.logger.info('SMS code sent', { context: CONTEXT, authId, purpose });
      return;
    } catch (error) {
      this.logger.error(
        sent
          ? 'SMS code delivery could not be recorded'
          : 'SMS code could not be sent',
        {
          context: CONTEXT,
          authId,
          purpose,
          errorName: error instanceof Error ? error.name : typeof error,
        },
      );
    }
    // Best effort: the code is unusable anyway (never delivered).
    await this.guard(() =>
      this.repository.withLock(authId, async (uow) => {
        await uow.invalidateOpenCodes(now, { id: delivery.codeId });
        if (sent) return; // A message went out: it stays counted.
        const account = await uow.account();
        if (!account) return;
        const index = account.deliveriesAt.findIndex(
          (d) => d.getTime() === now.getTime(),
        );
        if (index >= 0) {
          await uow.saveDeliveries(
            account.deliveriesAt.filter((_, i) => i !== index),
          );
        }
      }),
    ).catch(() => undefined);
    throw AppError.serviceUnavailable(
      'The SMS code could not be sent. Please try again later.',
    );
  }

  private codeHash(
    authId: string,
    codeId: string,
    purpose: MfaSmsCodePurpose,
    code: string,
  ): string {
    return this.cipher.mac(
      `mfa-sms-code\u0000${authId}\u0000${codeId}\u0000${purpose}\u0000${code}`,
    );
  }

  private requireDelivery() {
    if (!this.sender.configured) {
      throw AppError.serviceUnavailable('SMS verification is not available');
    }
  }

  private refusalError(refusal: Refusal): AppError {
    switch (refusal.kind) {
      case 'NOT_AVAILABLE':
        return AppError.conflict(
          'SMS verification is only available with authenticator-app MFA and a verified phone number',
        );
      case 'CHALLENGE_INVALID':
        return invalidChallenge();
      case 'ALREADY_ENROLLED':
        return AppError.conflict(
          'A phone number is already registered. Replace it instead.',
        );
      case 'NO_PHONE':
        return AppError.conflict('No phone number is registered');
      case 'SAME_NUMBER':
        return AppError.conflict('This phone number is already registered');
      case 'NO_VERIFICATION':
        return AppError.conflict(
          'No phone number verification is in progress. Start again.',
        );
      case 'DELIVERY_LIMIT':
        return AppError.tooManyRequests(
          `Too many SMS codes were sent. Try again after ${refusal.until.toISOString()}.`,
        );
      case 'BLOCKED':
        return AppError.tooManyRequests(
          `Too many SMS code attempts. Try again after ${refusal.until.toISOString()}.`,
        );
      case 'INVALID':
        return AppError.badRequest(
          `Invalid or expired SMS code. ${refusal.remainingAttempts} attempt(s) remaining.`,
        );
    }
  }

  private guard<T>(operation: () => Promise<T>): Promise<T> {
    return guardMfaStorage(this.logger, CONTEXT, operation);
  }
}

function invalidChallenge(): AppError {
  return AppError.unauthorized(
    'The MFA challenge is invalid or has expired. Please sign in again.',
  );
}

function sameHash(stored: string, computed: string): boolean {
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(computed, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function changeEventContext(change: MfaChangeContext): SecurityEventContext {
  return {
    ip: change.metadata.ip,
    userAgent: change.metadata.userAgent,
    sessionId: change.sessionId ?? null,
  };
}

function approvalChange(change: MfaChangeContext) {
  return change.approvedWith
    ? [
        {
          fieldName: 'stepUpMethod',
          oldValue: null,
          newValue: change.approvedWith,
        },
      ]
    : [];
}
