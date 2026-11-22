import { NotificationType } from '@prisma/client';

/**
 * Pure rules of notifications (no database access).
 */

/** Security notifications are always emailed, whatever the preferences. */
export const SECURITY_NOTIFICATION_TYPES: readonly NotificationType[] = [
  NotificationType.SECURITY_SIGNED_OUT_EVERYWHERE,
  NotificationType.SECURITY_SESSION_REUSE_DETECTED,
];

export const isSecurityNotification = (type: NotificationType): boolean =>
  SECURITY_NOTIFICATION_TYPES.includes(type);

/** A user's email preferences (defaults: every email on). */
export interface EmailPreferences {
  emailReferralRewards: boolean;
  emailReferralMilestones: boolean;
}

export const DEFAULT_EMAIL_PREFERENCES: EmailPreferences = {
  emailReferralRewards: true,
  emailReferralMilestones: true,
};

/** Whether a notification of `type` is emailed with these preferences. */
export function wantsEmail(
  type: NotificationType,
  preferences: EmailPreferences,
): boolean {
  switch (type) {
    case NotificationType.REFERRAL_REWARD_EARNED:
      return preferences.emailReferralRewards;
    case NotificationType.REFERRAL_MILESTONE_REACHED:
      return preferences.emailReferralMilestones;
    case NotificationType.SECURITY_SIGNED_OUT_EVERYWHERE:
    case NotificationType.SECURITY_SESSION_REUSE_DETECTED:
      return true;
  }
}

/** What a notification says (inbox entry and email). */
export interface NotificationContent {
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, string | number>;
}

export const notificationContent = {
  referralRewardEarned: (
    referralId: string,
    credits: number,
  ): NotificationContent => ({
    type: NotificationType.REFERRAL_REWARD_EARNED,
    title: `You earned ${credits} referral credits`,
    body: `Someone you invited made their first purchase. Your ${credits} credits never expire.`,
    data: { referralId, credits },
  }),
  referralMilestoneReached: (
    milestoneId: string,
    referralCount: number,
    credits: number,
  ): NotificationContent => ({
    type: NotificationType.REFERRAL_MILESTONE_REACHED,
    title: `Milestone reached: ${referralCount} paid referral${referralCount === 1 ? '' : 's'}`,
    body: `You earned ${credits} bonus credits for inviting ${referralCount} ${referralCount === 1 ? 'person who has' : 'people who have'} made a purchase.`,
    data: { milestoneId, referralCount, credits },
  }),
  signedOutEverywhere: (): NotificationContent => ({
    type: NotificationType.SECURITY_SIGNED_OUT_EVERYWHERE,
    title: 'You were signed out on all devices',
    body: 'All your sessions were ended. If you did not do this, change your password and contact support.',
  }),
  sessionReuseDetected: (): NotificationContent => ({
    type: NotificationType.SECURITY_SESSION_REUSE_DETECTED,
    title: 'We signed you out for your security',
    body: 'A sign-in token of your account was used again after it had been replaced, so we ended all your sessions. Please sign in again, and change your password if you did not expect this.',
  }),
};

/**
 * Opaque page cursor: the position after the last entry of a page (newest
 * first: creation time, then id).
 */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString(
    'base64url',
  );
}

/** The position a cursor names, or null for a malformed cursor. */
export function decodeCursor(
  cursor: string,
): { createdAt: Date; id: string } | null {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  if (separator < 0) return null;
  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (
    Number.isNaN(createdAt.getTime()) ||
    createdAt.toISOString() !== decoded.slice(0, separator) ||
    !/^[0-9a-f-]{36}$/.test(id)
  ) {
    return null;
  }
  return { createdAt, id };
}
