import { NotificationType } from '@prisma/client';
import config from '../common/config/app.config';
import {
  emailDispatchKey,
  emailErrorDetail,
  emailRetryDelayMs,
  emailTypeOfNotification,
  MAX_EMAIL_ATTEMPTS,
  openEmailPayload,
  sealEmailPayload,
  secretDigest,
} from '../common/queues/email/email-delivery';
import {
  DEFAULT_EMAIL_PREFERENCES,
  isSecurityNotification,
  notificationContent,
  wantsEmail,
} from './notification.policy';

/**
 * Purchase and gift notifications, and the rules of the email outbox that
 * delivers every email (credit package notifications).
 */
describe('credit package notification policy', () => {
  const none = {
    emailReferralRewards: false,
    emailReferralMilestones: false,
    emailGifts: false,
    emailPurchases: false,
  };
  const PURCHASE = [
    NotificationType.CREDIT_PURCHASE_COMPLETED,
    NotificationType.CREDIT_PURCHASE_FAILED,
  ];
  const GIFT = [
    NotificationType.GIFT_RECEIVED,
    NotificationType.GIFT_ACCEPTED,
    NotificationType.GIFT_DECLINED,
    NotificationType.GIFT_PAID,
    NotificationType.GIFT_DELIVERED,
    NotificationType.GIFT_CANCELED,
    NotificationType.GIFT_EXPIRED,
    NotificationType.GIFT_UNDER_REVIEW,
    NotificationType.GIFT_REJECTED,
  ];

  it('emails purchase and gift notifications by default, following their own preferences', () => {
    for (const type of [...PURCHASE, ...GIFT]) {
      expect(wantsEmail(type, DEFAULT_EMAIL_PREFERENCES)).toBe(true);
      expect(wantsEmail(type, none)).toBe(false);
      expect(isSecurityNotification(type)).toBe(false);
    }
    for (const type of PURCHASE) {
      expect(wantsEmail(type, { ...none, emailPurchases: true })).toBe(true);
      expect(wantsEmail(type, { ...none, emailGifts: true })).toBe(false);
    }
    for (const type of GIFT) {
      expect(wantsEmail(type, { ...none, emailGifts: true })).toBe(true);
      expect(wantsEmail(type, { ...none, emailPurchases: true })).toBe(false);
    }
  });

  it('always emails security notifications', () => {
    expect(
      wantsEmail(NotificationType.SECURITY_SIGNED_OUT_EVERYWHERE, none),
    ).toBe(true);
    expect(
      wantsEmail(NotificationType.SECURITY_SESSION_REUSE_DETECTED, none),
    ).toBe(true);
  });

  it('maps every notification to the email type of its delivery history', () => {
    for (const type of PURCHASE) {
      expect(emailTypeOfNotification(type)).toBe('purchase');
    }
    for (const type of GIFT) expect(emailTypeOfNotification(type)).toBe('gift');
    expect(
      emailTypeOfNotification(NotificationType.REFERRAL_REWARD_EARNED),
    ).toBe('referral');
    expect(
      emailTypeOfNotification(NotificationType.SECURITY_SIGNED_OUT_EVERYWHERE),
    ).toBe('security');
    // Every type has one (the switch is exhaustive).
    for (const type of Object.values(NotificationType)) {
      expect(emailTypeOfNotification(type)).toEqual(expect.any(String));
    }
  });

  it('describes purchases and gifts without other users’ personal data', () => {
    expect(
      notificationContent.creditPurchaseCompleted('o1', 500, '10.00'),
    ).toEqual({
      type: NotificationType.CREDIT_PURCHASE_COMPLETED,
      title: 'Your 500 credits are ready',
      body: expect.stringContaining('$10.00') as string,
      data: { orderId: 'o1', credits: 500 },
    });
    expect(notificationContent.creditPurchaseFailed('o1', 250).title).toBe(
      'Your payment did not go through',
    );
    const later = new Date('2031-06-01T09:30:00.000Z');
    expect(
      notificationContent.giftPaid('g1', 'amy', 250, later, false).body,
    ).toContain('2031-06-01 09:30 UTC');
    expect(
      notificationContent.giftPaid('g1', 'amy', 250, later, true).body,
    ).toContain('being delivered');
    expect(notificationContent.giftDelivered('g1', 250)).toMatchObject({
      type: NotificationType.GIFT_DELIVERED,
      data: { giftId: 'g1', credits: 250 },
    });
  });

  describe('email outbox', () => {
    const original = config.jwt_refresh_secret;
    beforeAll(() => {
      config.jwt_refresh_secret = 'credit-package-notification-spec-secret';
    });
    afterAll(() => {
      config.jwt_refresh_secret = original;
    });

    it('retries failed deliveries with growing delays, then gives up after the last attempt', () => {
      expect(
        Array.from({ length: MAX_EMAIL_ATTEMPTS }, (_, i) =>
          emailRetryDelayMs(i + 1),
        ),
      ).toEqual([
        60_000, 300_000, 900_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000,
        43_200_000,
      ]);
    });

    it('dispatches each delivery round once: a retry gets a new job id', () => {
      const at = new Date('2031-01-01T00:00:00.000Z');
      expect(emailDispatchKey({ retry_count: 0, nextAttemptAt: at })).toBe(
        `0-${at.getTime()}`,
      );
      expect(emailDispatchKey({ retry_count: 1, nextAttemptAt: at })).not.toBe(
        emailDispatchKey({ retry_count: 0, nextAttemptAt: at }),
      );
    });

    it('keeps secrets encrypted and bound to their email', () => {
      const sealed = sealEmailPayload('verification:u1:x', { code: 'C0DE42' });
      expect(sealed).not.toContain('C0DE42');
      expect(openEmailPayload('verification:u1:x', sealed)).toEqual({
        code: 'C0DE42',
      });
      expect(() => openEmailPayload('verification:u2:x', sealed)).toThrow();
      expect(openEmailPayload('welcome:u1', null)).toEqual({});
      expect(secretDigest('C0DE42')).toMatch(/^[0-9a-f]{24}$/);
      expect(secretDigest('C0DE42')).not.toBe(secretDigest('C0DE43'));
    });

    it('records the SMTP error code and message of a failed attempt', () => {
      expect(
        emailErrorDetail(
          Object.assign(new Error('421 4.3.0 try later'), {
            responseCode: 421,
          }),
        ),
      ).toBe('smtp:421 421 4.3.0 try later');
      expect(
        emailErrorDetail(
          Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }),
        ),
      ).toBe('ECONNREFUSED connect refused');
      expect(emailErrorDetail('x')).toBe('unknown error');
    });
  });
});
