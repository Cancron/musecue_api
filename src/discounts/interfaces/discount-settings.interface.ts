import type { ActivityLogMetadata } from '../../common/services/activity-log.service';

/** The editable discount and referral settings (0 = offer switched off). */
export interface DiscountSettingsValues {
  /** Percentage off a user's first paying purchase (whole percent, 0-100). */
  firstPurchaseDiscountPercent: number;
  /** Percentage off the purchase of a referred user (whole percent, 0-100). */
  referralDiscountPercent: number;
  /**
   * Credits for the referring user once the referred user's first paying
   * purchase has succeeded.
   */
  referrerRewardCredits: number;
}

export interface DiscountSettingsView extends DiscountSettingsValues {
  /** Read-only: whether each offer is on (its value is above 0). */
  firstPurchaseDiscountActive: boolean;
  referralDiscountActive: boolean;
  referrerRewardActive: boolean;
  /** When the stored settings were last written. */
  updatedAt: string;
}

export type UpdateDiscountSettingsInput = Partial<DiscountSettingsValues>;

export interface DiscountSettingsChangeActor extends ActivityLogMetadata {
  actionedBy: string;
}
