import { DiscountAudience } from '@prisma/client';
import {
  applyCheckoutDiscount,
  applyDiscount,
  discountOfferStatus,
  lateRedemptionFits,
  normalizeDiscountCode,
  packageProduct,
  proProduct,
  redemptionRejection,
  remainingBudget,
  remainingRedemptions,
  type RedeemableOffer,
  type RedemptionContext,
} from './discount-offer.policy';

const START = new Date('2026-12-20T00:00:00.000Z');
const END = new Date('2026-12-27T00:00:00.000Z');
const DURING = new Date('2026-12-24T12:00:00.000Z');

const offer = (overrides: Partial<RedeemableOffer> = {}): RedeemableOffer => ({
  active: true,
  discountPercent: 25,
  startsAt: START,
  endsAt: END,
  audience: DiscountAudience.ALL_USERS,
  customerEligibility: 'ALL_CUSTOMERS',
  eligibleProducts: [],
  minSpendCents: 0,
  maxRedemptionsPerUser: 1,
  maxTotalRedemptions: 100,
  redemptionCount: 0,
  budgetCents: null,
  budgetSpentCents: 0,
  budgetReservedCents: 0,
  ...overrides,
});
const context = (
  overrides: Partial<RedemptionContext> = {},
): RedemptionContext => ({
  now: DURING,
  isTargeted: false,
  userRedemptions: 0,
  hasPaidPurchase: false,
  product: 'PRO_MONTHLY',
  listPriceCents: 1900,
  discountCents: 475,
  ...overrides,
});

describe('discount offer policy', () => {
  describe('redemptionRejection', () => {
    it('accepts an active, running, open offer below every limit', () => {
      expect(redemptionRejection(offer(), context())).toBeNull();
    });

    it.each([
      ['a deactivated offer', offer({ active: false }), context(), 'INACTIVE'],
      ['a 0% discount', offer({ discountPercent: 0 }), context(), 'INACTIVE'],
      [
        'an offer before its start',
        offer(),
        context({ now: new Date(START.getTime() - 1) }),
        'NOT_STARTED',
      ],
      ['an offer at its exact end', offer(), context({ now: END }), 'EXPIRED'],
      [
        'a targeted offer for another user',
        offer({ audience: DiscountAudience.SELECTED_USERS }),
        context({ isTargeted: false }),
        'NOT_ELIGIBLE',
      ],
      [
        'a new-customer offer for a user who already paid',
        offer({ customerEligibility: 'NEW_CUSTOMERS' }),
        context({ hasPaidPurchase: true }),
        'CUSTOMER_NOT_ELIGIBLE',
      ],
      [
        'a returning-customer offer for a user who never paid',
        offer({ customerEligibility: 'RETURNING_CUSTOMERS' }),
        context({ hasPaidPurchase: false }),
        'CUSTOMER_NOT_ELIGIBLE',
      ],
      [
        'a product the offer does not cover',
        offer({ eligibleProducts: ['PRO_YEARLY', 'CREDITS_LARGE'] }),
        context({ product: 'PRO_MONTHLY' }),
        'PRODUCT_NOT_ELIGIBLE',
      ],
      [
        'a purchase below the minimum spend',
        offer({ minSpendCents: 5000 }),
        context({ listPriceCents: 1900 }),
        'MIN_SPEND_NOT_MET',
      ],
      [
        'a user at the per-user limit',
        offer({ maxRedemptionsPerUser: 2 }),
        context({ userRedemptions: 2 }),
        'USER_LIMIT_REACHED',
      ],
      [
        'an offer without redemptions left',
        offer({ maxTotalRedemptions: 3, redemptionCount: 3 }),
        context(),
        'DEPLETED',
      ],
      [
        'a discount above the budget left',
        offer({
          budgetCents: 1000,
          budgetSpentCents: 400,
          budgetReservedCents: 200,
        }),
        context({ discountCents: 401 }),
        'BUDGET_EXHAUSTED',
      ],
    ] as const)('rejects %s', (_case, subject, ctx, reason) => {
      expect(redemptionRejection(subject, ctx)).toBe(reason);
    });

    it('accepts the exact budget left, an eligible product and the exact minimum spend', () => {
      expect(
        redemptionRejection(
          offer({
            budgetCents: 1000,
            budgetSpentCents: 400,
            budgetReservedCents: 200,
            eligibleProducts: ['PRO_MONTHLY'],
            minSpendCents: 1900,
            customerEligibility: 'RETURNING_CUSTOMERS',
          }),
          context({ discountCents: 400, hasPaidPurchase: true }),
        ),
      ).toBeNull();
    });

    it('accepts the exact start instant and a targeted user', () => {
      expect(
        redemptionRejection(
          offer({ audience: DiscountAudience.SELECTED_USERS }),
          context({ now: START, isTargeted: true }),
        ),
      ).toBeNull();
    });

    it('accepts an unlimited offer with many redemptions', () => {
      expect(
        redemptionRejection(
          offer({ maxTotalRedemptions: null, redemptionCount: 1_000_000 }),
          context(),
        ),
      ).toBeNull();
    });

    it('reports inactivity before the period, and the period before limits', () => {
      expect(
        redemptionRejection(
          offer({ active: false, maxTotalRedemptions: 1, redemptionCount: 1 }),
          context({ now: END }),
        ),
      ).toBe('INACTIVE');
      expect(
        redemptionRejection(
          offer({ maxTotalRedemptions: 1, redemptionCount: 1 }),
          context({ now: END }),
        ),
      ).toBe('EXPIRED');
    });
  });

  it('lets a late payment of a released reservation count only within the limits and the budget', () => {
    expect(lateRedemptionFits(offer(), 0, 475)).toBe(true);
    expect(lateRedemptionFits(offer(), 1, 475)).toBe(false);
    expect(
      lateRedemptionFits(
        offer({ maxTotalRedemptions: 3, redemptionCount: 3 }),
        0,
        1,
      ),
    ).toBe(false);
    expect(
      lateRedemptionFits(
        offer({ budgetCents: 500, budgetSpentCents: 100 }),
        0,
        400,
      ),
    ).toBe(true);
    expect(
      lateRedemptionFits(
        offer({ budgetCents: 500, budgetSpentCents: 101 }),
        0,
        400,
      ),
    ).toBe(false);
    // Switched off or expired by now: the payment was made on the terms of
    // its reservation, so only capacity matters.
    expect(lateRedemptionFits(offer({ active: false }), 0, 475)).toBe(true);
  });

  describe('discountOfferStatus', () => {
    it.each([
      [offer(), DURING, 'ACTIVE'],
      [offer({ active: false }), DURING, 'INACTIVE'],
      [offer({ discountPercent: 0 }), DURING, 'INACTIVE'],
      [offer(), new Date(START.getTime() - 1), 'SCHEDULED'],
      [offer(), END, 'EXPIRED'],
      [
        offer({ maxTotalRedemptions: 2, redemptionCount: 2 }),
        DURING,
        'DEPLETED',
      ],
      [
        offer({
          budgetCents: 500,
          budgetSpentCents: 300,
          budgetReservedCents: 200,
        }),
        DURING,
        'DEPLETED',
      ],
      [offer({ budgetCents: 500, budgetSpentCents: 300 }), DURING, 'ACTIVE'],
    ] as const)('%o at %s is %s', (subject, now, status) => {
      expect(discountOfferStatus(subject, now)).toBe(status);
    });
  });

  it('reports the redemptions and budget left, or null when unlimited', () => {
    expect(remainingRedemptions(offer({ redemptionCount: 40 }))).toBe(60);
    expect(remainingRedemptions(offer({ maxTotalRedemptions: null }))).toBe(
      null,
    );
    expect(
      remainingBudget(
        offer({
          budgetCents: 1000,
          budgetSpentCents: 250,
          budgetReservedCents: 100,
        }),
      ),
    ).toBe(650);
    expect(remainingBudget(offer())).toBeNull();
  });

  describe('applyDiscount', () => {
    it.each([
      [500, 20, 100, 400],
      [1000, 15, 150, 850],
      [2000, 100, 2000, 0],
      [999, 33, 329, 670],
      [50, 1, 0, 50],
      [500, 0, 0, 500],
    ])(
      '%i cents at %i%% off: %i discount, %i to pay',
      (price, percent, discount, final) => {
        expect(applyDiscount(price, percent)).toEqual({
          originalPriceUsdCents: price,
          discountUsdCents: discount,
          finalPriceUsdCents: final,
        });
      },
    );

    it.each([
      [0, 10],
      [-1, 10],
      [10.5, 10],
      [500, -1],
      [500, 101],
      [500, 12.5],
    ])('refuses %p cents at %p%%', (price, percent) => {
      expect(() => applyDiscount(price, percent)).toThrow(RangeError);
    });
  });

  describe('applyCheckoutDiscount (never below Stripe’s $0.50 minimum charge)', () => {
    it.each([
      [1900, 20, 380, 1520],
      [19000, 15, 2850, 16150],
      [1900, 100, 1850, 50],
      [60, 50, 10, 50],
      [50, 90, 0, 50],
      [1999, 33, 659, 1340],
    ])(
      '%i cents at %i%% off: %i discount, %i charged',
      (price, percent, discount, final) => {
        expect(applyCheckoutDiscount(price, percent)).toEqual({
          originalPriceUsdCents: price,
          discountUsdCents: discount,
          finalPriceUsdCents: final,
        });
      },
    );
  });

  it('maps billing options and credit packages to products', () => {
    expect([proProduct('MONTHLY'), proProduct('YEARLY')]).toEqual([
      'PRO_MONTHLY',
      'PRO_YEARLY',
    ]);
    expect(
      (['SMALL', 'MEDIUM', 'LARGE'] as const).map((code) =>
        packageProduct(code),
      ),
    ).toEqual(['CREDITS_SMALL', 'CREDITS_MEDIUM', 'CREDITS_LARGE']);
  });

  it('compares codes case-insensitively', () => {
    expect(normalizeDiscountCode(' xmas-2026 ')).toBe('XMAS-2026');
  });
});
