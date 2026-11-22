import type { CreditPackageCode } from '@prisma/client';
import type { ActivityLogMetadata } from '../../common/services/activity-log.service';

/** The editable settings of one credit package. */
export interface CreditPackageValues {
  /** Whole credits the package grants. */
  credits: number;
  /** Price in whole US cents (500 = $5.00). */
  priceUsdCents: number;
  /** Whether the package is offered for purchase. */
  available: boolean;
}

export interface CreditPackageView extends CreditPackageValues {
  code: CreditPackageCode;
  currency: 'USD';
  /** Read-only: `priceUsdCents` in dollars, e.g. "5.00". */
  priceUsd: string;
  /** When the stored package was last written. */
  updatedAt: string;
}

export type UpdateCreditPackageInput = Partial<CreditPackageValues>;

export interface CreditPackageChangeActor extends ActivityLogMetadata {
  actionedBy: string;
}
