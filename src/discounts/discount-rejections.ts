import { DiscountCustomerEligibility } from '@prisma/client';
import AppError from '../common/errors/app.error';
import { DISCOUNT_MESSAGES } from './discount-offer.constants';
import type { RedemptionRejection } from './discount-offer.policy';

/** The response for an offer that cannot be redeemed (ineligible: 403). */
export function rejectionError(
  rejection: RedemptionRejection,
  customerEligibility: DiscountCustomerEligibility,
): AppError {
  switch (rejection) {
    case 'INACTIVE':
      return AppError.conflict(DISCOUNT_MESSAGES.INACTIVE);
    case 'NOT_STARTED':
      return AppError.conflict(DISCOUNT_MESSAGES.NOT_STARTED);
    case 'EXPIRED':
      return AppError.conflict(DISCOUNT_MESSAGES.EXPIRED);
    case 'NOT_ELIGIBLE':
      return AppError.forbidden(DISCOUNT_MESSAGES.NOT_ELIGIBLE);
    case 'CUSTOMER_NOT_ELIGIBLE':
      return AppError.forbidden(
        customerEligibility === DiscountCustomerEligibility.NEW_CUSTOMERS
          ? DISCOUNT_MESSAGES.NEW_CUSTOMERS_ONLY
          : DISCOUNT_MESSAGES.RETURNING_CUSTOMERS_ONLY,
      );
    case 'PRODUCT_NOT_ELIGIBLE':
      return AppError.conflict(DISCOUNT_MESSAGES.PRODUCT_NOT_ELIGIBLE);
    case 'MIN_SPEND_NOT_MET':
      return AppError.conflict(DISCOUNT_MESSAGES.MIN_SPEND_NOT_MET);
    case 'USER_LIMIT_REACHED':
      return AppError.conflict(DISCOUNT_MESSAGES.USER_LIMIT_REACHED);
    case 'DEPLETED':
      return AppError.conflict(DISCOUNT_MESSAGES.DEPLETED);
    case 'BUDGET_EXHAUSTED':
      return AppError.conflict(DISCOUNT_MESSAGES.BUDGET_EXHAUSTED);
  }
}
