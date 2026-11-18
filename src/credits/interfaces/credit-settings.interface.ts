import type { ActivityLogMetadata } from '../../common/services/activity-log.service';

/** The editable AI credit settings. */
export interface CreditSettingsValues {
  /** Credits granted for the one-time free trial. */
  trialCredits: number;
  /** Credits granted per monthly Pro billing period. */
  proMonthlyCredits: number;
  /** OpenRouter cost covered by one credit, in millionths of a US dollar. */
  creditCostUsdMicros: number;
  /** Credits a makeup session may use beyond the remaining balance. */
  sessionOverageCredits: number;
}

export interface CreditSettingsView extends CreditSettingsValues {
  /** `creditCostUsdMicros` as an exact decimal string, e.g. "0.005". Read-only. */
  creditCostUsd: string;
  /** When the stored settings were last written. */
  updatedAt: string;
}

export type UpdateCreditSettingsInput = Partial<CreditSettingsValues>;

export interface CreditSettingsChangeActor extends ActivityLogMetadata {
  actionedBy: string;
}
