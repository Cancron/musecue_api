import { NotificationType } from '@prisma/client';
import config from '../common/config/app.config';
import { hashPaymentFingerprint } from '../referrals/payment-fingerprint';
import {
  DEFAULT_EMAIL_PREFERENCES,
  decodeCursor,
  encodeCursor,
  isSecurityNotification,
  notificationContent,
  wantsEmail,
} from './notification.policy';

describe('referral notification policy', () => {
  const none = {
    emailReferralRewards: false,
    emailReferralMilestones: false,
    emailGifts: false,
    emailPurchases: false,
  };

  it('emails referral notifications by default and follows the preferences', () => {
    expect(
      wantsEmail(
        NotificationType.REFERRAL_REWARD_EARNED,
        DEFAULT_EMAIL_PREFERENCES,
      ),
    ).toBe(true);
    expect(
      wantsEmail(
        NotificationType.REFERRAL_MILESTONE_REACHED,
        DEFAULT_EMAIL_PREFERENCES,
      ),
    ).toBe(true);
    expect(wantsEmail(NotificationType.REFERRAL_REWARD_EARNED, none)).toBe(
      false,
    );
    expect(
      wantsEmail(NotificationType.REFERRAL_MILESTONE_REACHED, {
        ...none,
        emailReferralMilestones: true,
      }),
    ).toBe(true);
  });

  it.each([
    NotificationType.SECURITY_SIGNED_OUT_EVERYWHERE,
    NotificationType.SECURITY_SESSION_REUSE_DETECTED,
  ])('always emails the security notification %s', (type) => {
    expect(isSecurityNotification(type)).toBe(true);
    expect(wantsEmail(type, none)).toBe(true);
  });

  it('describes referral rewards and milestones', () => {
    expect(notificationContent.referralRewardEarned('r-1', 100)).toEqual({
      type: NotificationType.REFERRAL_REWARD_EARNED,
      title: 'You earned 100 referral credits',
      body: expect.stringContaining('100 credits never expire') as string,
      data: { referralId: 'r-1', credits: 100 },
    });
    expect(
      notificationContent.referralMilestoneReached('m-1', 1, 40).title,
    ).toBe('Milestone reached: 1 paid referral');
    expect(
      notificationContent.referralMilestoneReached('m-5', 5, 400),
    ).toMatchObject({
      title: 'Milestone reached: 5 paid referrals',
      data: { milestoneId: 'm-5', referralCount: 5, credits: 400 },
    });
  });

  it('round-trips page cursors and refuses malformed ones', () => {
    const at = new Date('2026-01-02T03:04:05.678Z');
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(decodeCursor(encodeCursor(at, id))).toEqual({ createdAt: at, id });
    for (const bad of [
      '',
      'not-a-cursor',
      Buffer.from(`${at.toISOString()}|not-an-id`).toString('base64url'),
      Buffer.from(`yesterday|${id}`).toString('base64url'),
      Buffer.from(`2026-01-02|${id}`).toString('base64url'),
    ]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });
});

describe('referral payment method fingerprints', () => {
  const original = config.jwt_refresh_secret;
  beforeAll(() => {
    config.jwt_refresh_secret = 'referral-fingerprint-spec-root-secret';
  });
  afterAll(() => {
    config.jwt_refresh_secret = original;
  });

  it('stores a keyed hash only: stable per payment method, distinct otherwise', () => {
    const hash = hashPaymentFingerprint('stripe', 'fp_card_123');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('fp_card_123');
    expect(hashPaymentFingerprint('stripe', 'fp_card_123')).toBe(hash);
    expect(hashPaymentFingerprint('stripe', 'fp_card_124')).not.toBe(hash);
    expect(hashPaymentFingerprint('other', 'fp_card_123')).not.toBe(hash);
  });
});
