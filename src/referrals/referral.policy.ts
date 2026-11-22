import { createHash } from 'node:crypto';

/**
 * Pure rules of referrals (no database access).
 */

/** Referral codes: 6-16 upper-case letters and digits. */
export const REFERRAL_CODE_PATTERN = /^[A-Z0-9]{6,16}$/;

/** A submitted code in its stored form, or null if it cannot be a code. */
export function normalizeReferralCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return REFERRAL_CODE_PATTERN.test(code) ? code : null;
}

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * The mailbox an email address delivers to, for recognizing one person
 * behind several addresses: lower case, without a "+tag", and for Gmail
 * without dots in the local part (`A.Lice+promo@GoogleMail.com` ->
 * `alice@gmail.com`).
 */
export function canonicalEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return normalized;
  let local = normalized.slice(0, at).split('+')[0];
  let domain = normalized.slice(at + 1);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

/**
 * SHA-256 (hex) of the canonical email: stored with a referral to refuse a
 * second referral of the same person, without storing the address again.
 */
export function canonicalEmailHash(email: string): string {
  return createHash('sha256').update(canonicalEmail(email)).digest('hex');
}

/** Whether two addresses belong to the same mailbox (a self-referral). */
export function isSameMailbox(a: string, b: string): boolean {
  return canonicalEmail(a) === canonicalEmail(b);
}

/**
 * How a referrer sees the people they invited: the first two characters of
 * the username, never the email or user id (`alice_89` -> `al***`).
 */
export function maskDisplayName(username: string): string {
  return `${username.slice(0, 2)}***`;
}

/** The credit reference of a referral reward: one reward per referral. */
export const referralRewardReference = (referralId: string) =>
  `referral-reward:${referralId}`;

export const REFERRAL_REWARD_PREFIX = 'referral-reward:';

/** The credit reference of a milestone reward: one per referrer and milestone. */
export const referralMilestoneReference = (milestoneId: string) =>
  `referral-milestone:${milestoneId}`;

export const REFERRAL_MILESTONE_PREFIX = 'referral-milestone:';

/** Why a referral was held for review (never any payment data). */
export type ReferralHoldReason =
  | 'SHARED_PAYMENT_METHOD_WITH_REFERRER'
  | 'SHARED_PAYMENT_METHOD_WITH_OTHER_REFERRAL'
  /** The payment method could not be read from Stripe: not ruled out. */
  | 'PAYMENT_METHOD_UNAVAILABLE';
