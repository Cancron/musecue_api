import type { ActivityLogMetadata } from '../../common/services/activity-log.service';

/** The editable AI credit settings. */
export interface CreditSettingsValues {
  trialAllowanceCredits: number;
  proMonthlyAllowanceCredits: number;
  /** OpenRouter cost per credit in millionths of a US dollar (5000 = $0.005). */
  openRouterUsdMicrosPerCredit: number;
  sessionOverageAllowanceCredits: number;
}

export interface CreditSettingsView extends CreditSettingsValues {
  /**
   * Read-only decimal rendering of `openRouterUsdMicrosPerCredit` in US
   * dollars (e.g. "0.005"). Change the micro-dollar field to update it.
   */
  openRouterUsdPerCredit: string;
  /** When the stored configuration last changed (or was created). */
  updatedAt: string;
}

export type UpdateCreditSettingsInput = Partial<CreditSettingsValues>;

export interface CreditSettingsChangeActor extends ActivityLogMetadata {
  actionedBy: string;
}
