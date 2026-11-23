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
  emailGifts: boolean;
  emailPurchases: boolean;
}

export const DEFAULT_EMAIL_PREFERENCES: EmailPreferences = {
  emailReferralRewards: true,
  emailReferralMilestones: true,
  emailGifts: true,
  emailPurchases: true,
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
    case NotificationType.GIFT_RECEIVED:
    case NotificationType.GIFT_ACCEPTED:
    case NotificationType.GIFT_DECLINED:
    case NotificationType.GIFT_DELIVERED:
    case NotificationType.GIFT_PAID:
    case NotificationType.GIFT_CANCELED:
    case NotificationType.GIFT_EXPIRED:
    case NotificationType.GIFT_UNDER_REVIEW:
    case NotificationType.GIFT_REJECTED:
      return preferences.emailGifts;
    case NotificationType.CREDIT_PURCHASE_COMPLETED:
    case NotificationType.CREDIT_PURCHASE_FAILED:
      return preferences.emailPurchases;
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
  giftReceived: (
    giftId: string,
    senderName: string,
    credits: number,
  ): NotificationContent => ({
    type: NotificationType.GIFT_RECEIVED,
    title: `${senderName} wants to give you ${credits} credits`,
    body: `${senderName} sent you a gift of ${credits} MuseCue credits. Accept it to let them complete the gift, or decline it.`,
    data: { giftId, credits },
  }),
  giftAccepted: (
    giftId: string,
    recipientName: string,
    credits: number,
  ): NotificationContent => ({
    type: NotificationType.GIFT_ACCEPTED,
    title: `${recipientName} accepted your gift`,
    body: `${recipientName} accepted your gift of ${credits} credits. Complete the payment to send it.`,
    data: { giftId, credits },
  }),
  giftDeclined: (
    giftId: string,
    recipientName: string,
    credits: number,
  ): NotificationContent => ({
    type: NotificationType.GIFT_DECLINED,
    title: `${recipientName} declined your gift`,
    body: `${recipientName} declined your gift of ${credits} credits. Nothing was charged.`,
    data: { giftId, credits },
  }),
  giftDelivered: (giftId: string, credits: number): NotificationContent => ({
    type: NotificationType.GIFT_DELIVERED,
    title: `You received ${credits} gift credits`,
    body: `A gift of ${credits} credits was added to your balance. Gift credits never expire.`,
    data: { giftId, credits },
  }),
  giftDeliveredToRecipient: (
    giftId: string,
    recipientName: string,
    credits: number,
  ): NotificationContent => ({
    type: NotificationType.GIFT_DELIVERED,
    title: `Your gift to ${recipientName} was delivered`,
    body: `${recipientName} received the ${credits} credits you gave.`,
    data: { giftId, credits },
  }),
  giftPaid: (
    giftId: string,
    recipientName: string,
    credits: number,
    deliverAt: Date,
    immediate: boolean,
  ): NotificationContent => ({
    type: NotificationType.GIFT_PAID,
    title: `Your gift to ${recipientName} is paid`,
    body: immediate
      ? `Your payment for ${credits} credits for ${recipientName} was received. The gift is being delivered.`
      : `Your payment for ${credits} credits for ${recipientName} was received. The gift will be delivered on ${deliverAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    data: { giftId, credits, deliverAt: deliverAt.toISOString() },
  }),
  giftCanceled: (
    giftId: string,
    senderName: string,
    credits: number,
  ): NotificationContent => ({
    type: NotificationType.GIFT_CANCELED,
    title: `${senderName} canceled a gift`,
    body: `${senderName} canceled the gift of ${credits} credits they sent you.`,
    data: { giftId, credits },
  }),
  giftExpired: (giftId: string, credits: number): NotificationContent => ({
    type: NotificationType.GIFT_EXPIRED,
    title: 'Your gift invitation expired',
    body: `Your gift of ${credits} credits was not accepted and paid in time. Nothing was charged.`,
    data: { giftId, credits },
  }),
  giftUnderReview: (giftId: string, credits: number): NotificationContent => ({
    type: NotificationType.GIFT_UNDER_REVIEW,
    title: 'Your gift is being reviewed',
    body: `Your paid gift of ${credits} credits could not be delivered yet and is being reviewed by our team.`,
    data: { giftId, credits },
  }),
  giftRejected: (giftId: string, credits: number): NotificationContent => ({
    type: NotificationType.GIFT_REJECTED,
    title: 'Your gift could not be delivered',
    body: `Your gift of ${credits} credits could not be delivered. Your payment will be refunded.`,
    data: { giftId, credits },
  }),
  creditPurchaseCompleted: (
    orderId: string,
    credits: number,
    amountUsd: string,
  ): NotificationContent => ({
    type: NotificationType.CREDIT_PURCHASE_COMPLETED,
    title: `Your ${credits} credits are ready`,
    body: `Thank you for your purchase of ${credits} credits ($${amountUsd}). They were added to your balance and never expire.`,
    data: { orderId, credits },
  }),
  creditPurchaseFailed: (
    orderId: string,
    credits: number,
  ): NotificationContent => ({
    type: NotificationType.CREDIT_PURCHASE_FAILED,
    title: 'Your payment did not go through',
    body: `The payment for ${credits} credits failed, so nothing was charged or added. You can try again with another payment method.`,
    data: { orderId, credits },
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
