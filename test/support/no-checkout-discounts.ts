import type { CheckoutDiscountService } from '../../src/subscription/discounts/checkout-discount.service';

/**
 * Checkouts without discounts, for unit tests of the checkout and webhook
 * flows that do not involve discounts (their in-memory database has no
 * discount tables). Nothing is selected, reserved, redeemed or released.
 */
export function noCheckoutDiscounts(): CheckoutDiscountService {
  const none: Pick<
    CheckoutDiscountService,
    | 'select'
    | 'reserve'
    | 'release'
    | 'redeem'
    | 'hasReservation'
    | 'isUnpayable'
    | 'releaseIfUnpayable'
    | 'releaseForEndedSubscription'
  > = {
    select: () => Promise.resolve(null),
    reserve: () => Promise.resolve(),
    release: () => Promise.resolve(false),
    redeem: () => Promise.resolve('NONE'),
    hasReservation: () => Promise.resolve(false),
    isUnpayable: () => Promise.resolve(true),
    releaseIfUnpayable: () => Promise.resolve('NONE'),
    releaseForEndedSubscription: () => Promise.resolve('NONE'),
  };
  return none as CheckoutDiscountService;
}
