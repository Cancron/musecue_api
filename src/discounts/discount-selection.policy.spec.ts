import type { DiscountCandidate } from './discount-selection.policy';
import { selectBestDiscount } from './discount-selection.policy';

const candidate = (
  overrides: Partial<DiscountCandidate>,
): DiscountCandidate => ({
  source: 'CAMPAIGN',
  percent: 10,
  offerId: null,
  code: null,
  name: 'x',
  endsAt: null,
  ...overrides,
});

describe('selectBestDiscount', () => {
  it('returns null without candidates or with only 0% ones', () => {
    expect(selectBestDiscount([])).toBeNull();
    expect(selectBestDiscount([candidate({ percent: 0 })])).toBeNull();
  });

  it('applies the highest percentage, whatever its source', () => {
    const best = selectBestDiscount([
      candidate({ source: 'FIRST_PURCHASE', percent: 20 }),
      candidate({ source: 'REFERRAL', percent: 25 }),
      candidate({ source: 'CODE', percent: 30, offerId: 'code', code: 'X' }),
      candidate({ source: 'CAMPAIGN', percent: 35, offerId: 'camp' }),
    ]);
    expect(best).toMatchObject({ source: 'CAMPAIGN', percent: 35 });
  });

  it('prefers the one-time discounts over limited offers on a tie, then a code over a campaign', () => {
    const code = candidate({ source: 'CODE', percent: 20, offerId: 'c' });
    const campaign = candidate({
      source: 'CAMPAIGN',
      percent: 20,
      offerId: 'a',
    });
    const first = candidate({ source: 'FIRST_PURCHASE', percent: 20 });
    const referral = candidate({ source: 'REFERRAL', percent: 20 });
    expect(selectBestDiscount([campaign, code, referral, first])?.source).toBe(
      'FIRST_PURCHASE',
    );
    expect(selectBestDiscount([campaign, code, referral])?.source).toBe(
      'REFERRAL',
    );
    expect(selectBestDiscount([campaign, code])?.source).toBe('CODE');
  });

  it('between equal campaigns, takes the one ending soonest, then the lowest id', () => {
    const later = candidate({ offerId: 'a', endsAt: new Date('2031-01-02') });
    const sooner = candidate({ offerId: 'b', endsAt: new Date('2031-01-01') });
    const twin = candidate({ offerId: 'c', endsAt: new Date('2031-01-01') });
    expect(selectBestDiscount([later, twin, sooner])?.offerId).toBe('b');
  });
});
