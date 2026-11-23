import { CreditSource, Prisma } from '@prisma/client';
import {
  compareSpendingOrder,
  creditSourceExpires,
  decideOverage,
  getGrantExpiryRejection,
  getReferenceRejection,
  isAllocationAvailable,
  isAllocationDueForExpiration,
  planDebit,
  type SpendableAllocation,
} from './credit-ledger.policy';

const D = (value: string | number) => new Prisma.Decimal(value);
const NOW = new Date('2026-11-23T12:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const HOUR = 60 * 60 * 1000;

const allocation = (
  id: string,
  remaining: string,
  expiresAt: Date | null,
  grantedAt = at(-24 * HOUR),
  source: CreditSource = expiresAt
    ? CreditSource.SUBSCRIPTION
    : CreditSource.PURCHASE,
): SpendableAllocation => ({
  id,
  source,
  remaining: D(remaining),
  expiresAt,
  grantedAt,
});

describe('credit ledger policy', () => {
  describe('expiration by source', () => {
    it.each([
      [CreditSource.TRIAL, true],
      [CreditSource.SUBSCRIPTION, true],
      [CreditSource.PURCHASE, false],
      [CreditSource.REFERRAL, false],
    ])('%s credits expire: %p', (source, expires) => {
      expect(creditSourceExpires(source)).toBe(expires);
    });

    it.each([CreditSource.TRIAL, CreditSource.SUBSCRIPTION])(
      '%s credits need a future expiration date',
      (source) => {
        expect(getGrantExpiryRejection(source, at(HOUR), NOW)).toBeNull();
        expect(getGrantExpiryRejection(source, null, NOW)).toMatch(
          /require an expiration date/,
        );
        expect(getGrantExpiryRejection(source, undefined, NOW)).toMatch(
          /require an expiration date/,
        );
        expect(getGrantExpiryRejection(source, NOW, NOW)).toMatch(/future/);
        expect(getGrantExpiryRejection(source, at(-1), NOW)).toMatch(/future/);
        expect(
          getGrantExpiryRejection(source, new Date('invalid'), NOW),
        ).toMatch(/Invalid/);
      },
    );

    it.each([CreditSource.PURCHASE, CreditSource.REFERRAL])(
      '%s credits never expire',
      (source) => {
        expect(getGrantExpiryRejection(source, null, NOW)).toBeNull();
        expect(getGrantExpiryRejection(source, undefined, NOW)).toBeNull();
        expect(getGrantExpiryRejection(source, at(HOUR), NOW)).toMatch(
          /never expire/,
        );
      },
    );
  });

  describe('references', () => {
    it.each([
      ['', /required/],
      ['   ', /required/],
      ['x'.repeat(201), /at most 200/],
    ])('rejects %p', (value, message) => {
      expect(getReferenceRejection('sourceReference', value)).toMatch(message);
    });

    it('accepts a normal reference', () => {
      expect(
        getReferenceRejection('sourceReference', 'sub_1:2026-11'),
      ).toBeNull();
      expect(
        getReferenceRejection('sourceReference', 'x'.repeat(200)),
      ).toBeNull();
    });
  });

  describe('availability and expiration', () => {
    it('counts unexpired credits and never-expiring credits', () => {
      expect(isAllocationAvailable(allocation('a', '1', at(1)), NOW)).toBe(
        true,
      );
      expect(isAllocationAvailable(allocation('a', '1', null), NOW)).toBe(true);
    });

    it('does not count credits from the exact expiry instant on', () => {
      expect(isAllocationAvailable(allocation('a', '1', NOW), NOW)).toBe(false);
      expect(isAllocationAvailable(allocation('a', '1', at(-1)), NOW)).toBe(
        false,
      );
      expect(isAllocationDueForExpiration(allocation('a', '1', NOW), NOW)).toBe(
        true,
      );
    });

    it('ignores used-up allocations', () => {
      expect(isAllocationAvailable(allocation('a', '0', null), NOW)).toBe(
        false,
      );
      expect(
        isAllocationDueForExpiration(allocation('a', '0', at(-1)), NOW),
      ).toBe(false);
    });

    it('never expires credits without an expiration date', () => {
      expect(
        isAllocationDueForExpiration(allocation('a', '5', null), NOW),
      ).toBe(false);
    });
  });

  describe('spending order', () => {
    it('spends the soonest-expiring credits first and never-expiring credits last', () => {
      const list = [
        allocation('purchase', '1', null),
        allocation('subscription', '1', at(30 * 24 * HOUR)),
        allocation('trial', '1', at(HOUR)),
      ];
      expect(list.sort(compareSpendingOrder).map((a) => a.id)).toEqual([
        'trial',
        'subscription',
        'purchase',
      ]);
    });

    it('breaks ties by grant time, then ID', () => {
      const list = [
        allocation('b', '1', null, at(-HOUR)),
        allocation('c', '1', null, at(-2 * HOUR)),
        allocation('a', '1', null, at(-HOUR)),
      ];
      expect(list.sort(compareSpendingOrder).map((a) => a.id)).toEqual([
        'c',
        'a',
        'b',
      ]);
    });
  });

  describe('planDebit', () => {
    it('takes from several allocations in spending order with exact fractions', () => {
      const plan = planDebit(
        [
          allocation('purchase', '10', null),
          allocation('trial', '0.3', at(HOUR)),
          allocation('subscription', '1.25', at(2 * HOUR)),
        ],
        D('1.6'),
        NOW,
      );
      expect(
        plan.takes.map((take) => [take.allocationId, take.amount.toFixed()]),
      ).toEqual([
        ['trial', '0.3'],
        ['subscription', '1.25'],
        ['purchase', '0.05'],
      ]);
      expect(plan.consumed.toFixed()).toBe('1.6');
      expect(plan.shortfall.toFixed()).toBe('0');
    });

    it('never touches expired or empty allocations', () => {
      const plan = planDebit(
        [
          allocation('expired', '100', NOW),
          allocation('empty', '0', null),
          allocation('ok', '2', null),
        ],
        D('1'),
        NOW,
      );
      expect(plan.takes.map((take) => take.allocationId)).toEqual(['ok']);
    });

    it('reports the part the balance cannot cover', () => {
      const plan = planDebit(
        [allocation('a', '0.75', null), allocation('expired', '9', at(-1))],
        D('2'),
        NOW,
      );
      expect(plan.consumed.toFixed()).toBe('0.75');
      expect(plan.shortfall.toFixed()).toBe('1.25');
    });

    it('covers nothing from an empty wallet', () => {
      const plan = planDebit([], D('0.5'), NOW);
      expect(plan.takes).toEqual([]);
      expect(plan.consumed.toFixed()).toBe('0');
      expect(plan.shortfall.toFixed()).toBe('0.5');
    });

    it('does not mutate the allocations it plans over', () => {
      const list = [allocation('b', '1', null), allocation('a', '1', at(HOUR))];
      planDebit(list, D('1.5'), NOW);
      expect(list.map((a) => [a.id, a.remaining.toFixed()])).toEqual([
        ['b', '1'],
        ['a', '1'],
      ]);
    });
  });

  describe('decideOverage', () => {
    it('allows overage up to the session limit, exactly', () => {
      expect(decideOverage(D(5), D('4.5'), D('0.5'))).toMatchObject({
        allowed: true,
      });
      expect(decideOverage(D(5), D(0), D(5)).usedAfter.toFixed()).toBe('5');
    });

    it('refuses overage beyond the session limit', () => {
      const decision = decideOverage(D(5), D('4.5'), D('0.500001'));
      expect(decision.allowed).toBe(false);
      expect(decision.remainingBefore.toFixed()).toBe('0.5');
    });

    it('refuses any overage when the limit is zero', () => {
      expect(decideOverage(D(0), D(0), D('0.000001')).allowed).toBe(false);
    });
  });
});
