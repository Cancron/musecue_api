import type { ReferralStatus } from '@prisma/client';

/** The caller's referral code and referral results. */
export interface ReferralOverviewView {
  /** The caller's own code, to share for sign-ups. */
  code: string;
  /** Whether the caller signed up with someone's code. */
  referred: boolean;
  /**
   * The referral discount the caller gets on their first purchase (0 when
   * not referred, already purchased, or the discount is switched off).
   */
  referralDiscountPercent: number;
  /** Credits the caller currently earns per referral that buys (setting). */
  rewardCreditsPerReferral: number;
  referrals: {
    total: number;
    /** Signed up, no paying purchase yet. */
    pending: number;
    /** Bought; the caller received credits. */
    rewarded: number;
    /** Bought while no reward was due. */
    qualified: number;
  };
  /** Referral credits earned so far (exact decimal string). */
  totalEarnedCredits: string;
}

/** Someone the caller invited, as the caller may see them. */
export interface ReferralInviteeView {
  id: string;
  /** First characters of the username only. */
  displayName: string;
  status: ReferralStatus;
  signedUpAt: string;
  qualifiedAt: string | null;
  rewardCredits: number | null;
  rewardedAt: string | null;
}

/** One referral reward the caller received. */
export interface ReferralRewardView {
  /** The credit allocation. */
  id: string;
  /** The referral it rewarded. */
  referralId: string;
  /** The invitee, or null if their account was deleted since. */
  displayName: string | null;
  credits: string;
  /** Credits of this reward still unused. */
  remainingCredits: string;
  grantedAt: string;
  /** Referral credits never expire. */
  expiresAt: null;
}
