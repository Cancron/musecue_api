import { DiscountAudience } from '@prisma/client';
import {
  applyDiscount,
  discountOfferStatus,
  normalizeDiscountCode,
  redemptionRejection,
  remainingRedemptions,
  type RedeemableOffer,
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
  maxRedemptionsPerUser: 1,
  maxTotalRedemptions: 100,
  redemptionCount: 0,
  ...overrides,
});
const context = (overrides = {}) => ({
  now: DURING,
  isTargeted: false,
  userRedemptions: 0,
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
    ] as const)('rejects %s', (_case, subject, ctx, reason) => {
      expect(redemptionRejection(subject, ctx)).toBe(reason);
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
    ] as const)('%o at %s is %s', (subject, now, status) => {
      expect(discountOfferStatus(subject, now)).toBe(status);
    });
  });

  it('reports the redemptions left, or null when unlimited', () => {
    expect(remainingRedemptions(offer({ redemptionCount: 40 }))).toBe(60);
    expect(remainingRedemptions(offer({ maxTotalRedemptions: null }))).toBe(
      null,
    );
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

  it('compares codes case-insensitively', () => {
    expect(normalizeDiscountCode(' xmas-2026 ')).toBe('XMAS-2026');
  });
});
