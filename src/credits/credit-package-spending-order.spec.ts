import { CreditSource, Prisma } from '@prisma/client';
import {
  compareSpendingOrder,
  planDebit,
  SPENDING_TIER,
  type SpendableAllocation,
} from './credit-ledger.policy';

const NOW = new Date('2031-05-10T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const allocation = (
  id: string,
  source: CreditSource,
  grantedAgoDays: number,
  remaining = '1',
  expiresInDays: number | null = null,
): SpendableAllocation => ({
  id,
  source,
  remaining: new Prisma.Decimal(remaining),
  grantedAt: at(-grantedAgoDays * DAY),
  expiresAt: expiresInDays === null ? null : at(expiresInDays * DAY),
});

/**
 * Which credits are spent first once credit packages can be bought: free
 * credits (trial, subscription, daily reward, loyalty mission) by closest
 * expiration, then the oldest grant; then referral credits; then purchased
 * and gift credits, oldest first, even when older than referral credits.
 */
describe('credit package spending order', () => {
  it('puts every source in a tier: free, referral, purchased', () => {
    expect(SPENDING_TIER).toEqual({
      TRIAL: 0,
      SUBSCRIPTION: 0,
      DAILY_REWARD: 0,
      MISSION_REWARD: 0,
      REFERRAL: 1,
      PURCHASE: 2,
      GIFT: 2,
    });
  });

  it('spends free credits, then referral credits, then purchased credits, even when purchased credits are older', () => {
    const list = [
      allocation('purchase-old', CreditSource.PURCHASE, 90),
      allocation('gift', CreditSource.GIFT, 60),
      allocation('purchase-new', CreditSource.PURCHASE, 1),
      allocation('referral-new', CreditSource.REFERRAL, 2),
      allocation('referral-old', CreditSource.REFERRAL, 30),
      allocation('mission', CreditSource.MISSION_REWARD, 5),
      allocation('daily', CreditSource.DAILY_REWARD, 6),
      allocation('subscription', CreditSource.SUBSCRIPTION, 10, '1', 20),
      allocation('trial', CreditSource.TRIAL, 1, '1', 2),
    ];
    expect(list.sort(compareSpendingOrder).map((a) => a.id)).toEqual([
      // Free credits: closest expiration first, then the oldest grant.
      'trial',
      'subscription',
      'daily',
      'mission',
      // Referral credits, oldest first.
      'referral-old',
      'referral-new',
      // Purchased and gift credits last, oldest first.
      'purchase-old',
      'gift',
      'purchase-new',
    ]);
  });

  it('takes a debit across tiers in that order, leaving purchased credits for last', () => {
    const plan = planDebit(
      [
        allocation('purchase', CreditSource.PURCHASE, 100, '250'),
        allocation('referral', CreditSource.REFERRAL, 3, '40'),
        allocation('daily', CreditSource.DAILY_REWARD, 1, '10'),
        allocation('trial', CreditSource.TRIAL, 1, '50', 5),
      ],
      new Prisma.Decimal('105'),
      NOW,
    );
    expect(
      plan.takes.map((take) => [take.allocationId, take.amount.toFixed()]),
    ).toEqual([
      ['trial', '50'],
      ['daily', '10'],
      ['referral', '40'],
      ['purchase', '5'],
    ]);
    expect(plan.shortfall.toFixed()).toBe('0');
  });

  it('never spends expired or not yet started credits', () => {
    const plan = planDebit(
      [
        allocation('expired-trial', CreditSource.TRIAL, 10, '50', -1),
        allocation('purchase', CreditSource.PURCHASE, 5, '3'),
      ],
      new Prisma.Decimal('5'),
      NOW,
    );
    expect(plan.takes.map((take) => take.allocationId)).toEqual(['purchase']);
    expect(plan.shortfall.toFixed()).toBe('2');
  });
});
