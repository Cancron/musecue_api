import type { ActivityLogMetadata } from '../../common/services/activity-log.service';

/** The editable settings of a plan. */
export interface SubscriptionPlanSettings {
  planEnabled: boolean;
  monthlyPriceUsdCents: number;
  yearlyPriceUsdCents: number;
  trialEnabled: boolean;
  trialDays: number;
}

export interface SubscriptionPlanView extends SubscriptionPlanSettings {
  code: 'PRO';
  currency: 'USD';
  /** Null while the plan still uses its defaults and has never been saved. */
  updatedAt: string | null;
}

export type UpdateSubscriptionPlanInput = Partial<SubscriptionPlanSettings>;

export interface PlanChangeActor extends ActivityLogMetadata {
  actionedBy: string;
}
