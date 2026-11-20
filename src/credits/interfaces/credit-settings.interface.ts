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
  /**
   * AI usage is charged in multiples of this many millionths of a credit,
   * rounded up (1000000 = whole credits; 1 = exact fractional credits).
   */
  deductionStepMicroCredits: number;
}

export interface CreditSettingsView extends CreditSettingsValues {
  /** `creditCostUsdMicros` as an exact decimal string, e.g. "0.005". Read-only. */
  creditCostUsd: string;
  /** `deductionStepMicroCredits` in credits, e.g. "1" or "0.1". Read-only. */
  deductionStepCredits: string;
  /** When the stored settings were last written. */
  updatedAt: string;
}

export type UpdateCreditSettingsInput = Partial<CreditSettingsValues>;

export interface CreditSettingsChangeActor extends ActivityLogMetadata {
  actionedBy: string;
}
