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
  /** Null while the defaults are in use and nothing has been saved. */
  updatedAt: string | null;
}

export type UpdateCreditSettingsInput = Partial<CreditSettingsValues>;

export interface CreditSettingsChangeActor extends ActivityLogMetadata {
  actionedBy: string;
}
