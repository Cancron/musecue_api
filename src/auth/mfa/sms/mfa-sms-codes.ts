import { randomInt } from 'node:crypto';
import { MFA_SMS } from './mfa-sms.constants';

/**
 * Pure helpers of SMS verification: codes, phone numbers and the sliding
 * 15-minute limits. The caller supplies the time.
 */

/** Six digits from the operating system's CSPRNG (uniform, no modulo bias). */
export function generateSmsCode(): string {
  return String(randomInt(0, 10 ** MFA_SMS.CODE_DIGITS)).padStart(
    MFA_SMS.CODE_DIGITS,
    '0',
  );
}

/** A well-formed code: exactly six digits. */
export const SMS_CODE_PATTERN = /^\d{6}$/;

/**
 * The E.164 form of a number typed with a leading `+` and optional
 * spaces, dots, dashes or parentheses; null when it is not a valid number.
 */
export function normalizePhoneNumber(input: string): string | null {
  if (!MFA_SMS.INPUT_PATTERN.test(input.trim())) return null;
  const normalized = `+${input.replace(/\D/g, '')}`;
  return MFA_SMS.E164_PATTERN.test(normalized) ? normalized : null;
}

/** The last two digits, the only part of a number kept in clear. */
export const phoneHintOf = (e164: string): string => e164.slice(-2);

/** How a number is shown: only its last two digits. */
export const maskedPhone = (hint: string): string => `••••••••${hint}`;

/** The SMS text: the code, its lifetime, and a warning; nothing else. */
export function smsMessage(code: string, purpose: 'sign_in' | 'phone'): string {
  const what =
    purpose === 'sign_in'
      ? 'MuseCue sign-in code'
      : 'MuseCue phone verification code';
  return `Your ${what} is ${code}. It expires in 5 minutes. Never share it; MuseCue will never ask you for it.`;
}

/** The times that still count at `now` (the last 15 minutes), oldest first. */
export function recentTimes(times: readonly Date[], now: Date): Date[] {
  const windowStart = now.getTime() - MFA_SMS.WINDOW_MS;
  return times
    .filter((at) => at.getTime() > windowStart && at.getTime() <= now.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
}

export interface SmsLimit {
  /** Uses left in the window. */
  remaining: number;
  /** When the next use is allowed again, once none is left. */
  retryAt: Date | null;
}

/** A sliding-window limit of `max` uses per 15 minutes. */
export function smsLimit(
  times: readonly Date[],
  now: Date,
  max: number,
): SmsLimit {
  const recent = recentTimes(times, now);
  const remaining = Math.max(0, max - recent.length);
  return {
    remaining,
    retryAt:
      remaining > 0
        ? null
        : new Date(recent[recent.length - max].getTime() + MFA_SMS.WINDOW_MS),
  };
}

/** Records a use at `now`, keeping only what counts (at most `max`). */
export function withUse(
  times: readonly Date[],
  now: Date,
  max: number,
): Date[] {
  return [...recentTimes(times, now), now].slice(-max);
}
