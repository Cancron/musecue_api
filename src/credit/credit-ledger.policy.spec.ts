import { CreditSource, Prisma } from '@prisma/client';
import {
  assertAllocationExpiry,
  creditsForCost,
  overageRoomFor,
  parseUsdCost,
  compareSpendingOrder,
  CreditRuleViolation,
  formatCredits,
  isAvailable,
  isDueForExpiry,
  parseCreditAmount,
  planDeduction,
  planOverageSettlement,
  sessionOverageRoom,
  type SpendableAllocation,
} from './credit-ledger.policy';

const d = (value: string | number) => new Prisma.Decimal(value);
const NOW = new Date('2026-11-24T12:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const HOUR = 3_600_000;

const allocation = (
  id: string,
  remaining: string,
  expiresAt: Date | null,
  source: CreditSource = expiresAt
    ? CreditSource.SUBSCRIPTION
    : CreditSource.PURCHASE,
  grantedAt: Date = at(-24 * HOUR),
): SpendableAllocation => ({
  id,
  source,
  remainingCredits: d(remaining),
  expiresAt,
  grantedAt,
});

describe('credit ledger policy', () => {
  describe('parseCreditAmount (fractional amounts)', () => {
    it.each([
      ['1', '1'],
      ['0.5', '0.5'],
      ['0.000001', '0.000001'],
      ['  12.25 ', '12.25'],
      ['1000000000', '1000000000'],
    ])('accepts the string %p as exactly %s', (input, expected) => {
      expect(formatCredits(parseCreditAmount(input))).toBe(expected);
    });

    it('accepts numbers and Decimals', () => {
      expect(formatCredits(parseCreditAmount(0.1))).toBe('0.1');
      expect(formatCredits(parseCreditAmount(d('2.5')))).toBe('2.5');
    });

    it('adds fractions exactly, unlike floating point (0.1 + 0.2 = 0.3)', () => {
      const sum = parseCreditAmount('0.1').plus(parseCreditAmount('0.2'));
      expect(formatCredits(sum)).toBe('0.3');
      expect(0.1 + 0.2).not.toBe(0.3);
    });

    it.each([
      ['zero', '0'],
      ['a negative amount', '-1'],
      ['a negative number', -0.5],
      ['more than 6 decimal places', '0.0000001'],
      ['a number with more than 6 decimal places', 1e-7],
      ['an amount above the maximum', '1000000000.000001'],
      ['exponent notation', '1e3'],
      ['an empty string', ''],
      ['text', 'ten'],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('rejects %s', (_case, input) => {
      expect(() => parseCreditAmount(input)).toThrow(CreditRuleViolation);
    });

    it('rejects non-numeric input types', () => {
      expect(() => parseCreditAmount(null as unknown as string)).toThrow(
        CreditRuleViolation,
      );
      expect(() => parseCreditAmount({} as unknown as string)).toThrow(
        CreditRuleViolation,
      );
    });
  });

  describe('assertAllocationExpiry (expiry by source)', () => {
    it.each([CreditSource.TRIAL, CreditSource.SUBSCRIPTION])(
      '%s credits require a future expiry',
      (source) => {
        expect(() =>
          assertAllocationExpiry(source, at(HOUR), NOW),
        ).not.toThrow();
        expect(() => assertAllocationExpiry(source, null, NOW)).toThrow(
          'require an expiry date',
        );
        expect(() => assertAllocationExpiry(source, undefined, NOW)).toThrow(
          CreditRuleViolation,
        );
        expect(() => assertAllocationExpiry(source, NOW, NOW)).toThrow(
          'expire in the future',
        );
        expect(() =>
          assertAllocationExpiry(source, new Date('invalid'), NOW),
        ).toThrow(CreditRuleViolation);
      },
    );

    it.each([CreditSource.PURCHASE, CreditSource.REFERRAL])(
      '%s credits never expire',
      (source) => {
        expect(() => assertAllocationExpiry(source, null, NOW)).not.toThrow();
        expect(() =>
          assertAllocationExpiry(source, undefined, NOW),
        ).not.toThrow();
        expect(() => assertAllocationExpiry(source, at(HOUR), NOW)).toThrow(
          'never expire',
        );
      },
    );
  });

  describe('availability and expiry', () => {
    it('counts unexpired credits with a remainder as available', () => {
      expect(isAvailable(allocation('a', '1', at(1)), NOW)).toBe(true);
      expect(isAvailable(allocation('a', '1', null), NOW)).toBe(true);
    });

    it('never counts expired credits, including at the exact expiry instant', () => {
      expect(isAvailable(allocation('a', '1', NOW), NOW)).toBe(false);
      expect(isAvailable(allocation('a', '1', at(-1)), NOW)).toBe(false);
      expect(isDueForExpiry(allocation('a', '1', NOW), NOW)).toBe(true);
    });

    it('ignores fully used allocations for both', () => {
      expect(isAvailable(allocation('a', '0', null), NOW)).toBe(false);
      expect(isDueForExpiry(allocation('a', '0', at(-1)), NOW)).toBe(false);
    });

    it('never marks non-expiring credits as due', () => {
      expect(isDueForExpiry(allocation('a', '5', null), NOW)).toBe(false);
    });
  });

  describe('spending order', () => {
    it('spends soonest-expiring credits first, non-expiring credits last', () => {
      const purchase = allocation('purchase', '1', null, CreditSource.PURCHASE);
      const later = allocation('later', '1', at(48 * HOUR));
      const sooner = allocation('sooner', '1', at(HOUR), CreditSource.TRIAL);
      const referral = allocation(
        'referral',
        '1',
        null,
        CreditSource.REFERRAL,
        at(-48 * HOUR),
      );

      const order = [purchase, later, referral, sooner]
        .sort(compareSpendingOrder)
        .map((a) => a.id);

      expect(order).toEqual(['sooner', 'later', 'referral', 'purchase']);
    });
  });

  describe('planDeduction', () => {
    it('takes fractional credits across allocations in spending order', () => {
      const plan = planDeduction(
        [
          allocation('purchase', '10', null),
          allocation('trial', '0.75', at(HOUR), CreditSource.TRIAL),
        ],
        d('1.25'),
        d(0),
        NOW,
      );

      expect(plan).toMatchObject({ ok: true });
      if (!plan.ok) return;
      expect(
        plan.entries.map((e) => [e.allocationId, formatCredits(e.credits)]),
      ).toEqual([
        ['trial', '0.75'],
        ['purchase', '0.5'],
      ]);
      expect(formatCredits(plan.fromBalance)).toBe('1.25');
      expect(formatCredits(plan.overage)).toBe('0');
    });

    it('never spends expired credits', () => {
      const plan = planDeduction(
        [allocation('expired', '100', NOW), allocation('purchase', '1', null)],
        d('2'),
        d(0),
        NOW,
      );

      expect(plan).toMatchObject({ ok: false });
      if (plan.ok) return;
      expect(formatCredits(plan.available)).toBe('1');
      expect(formatCredits(plan.shortfall)).toBe('1');
    });

    it('charges a shortfall as overage within the room', () => {
      const plan = planDeduction(
        [allocation('purchase', '2.5', null)],
        d('6'),
        d('5'),
        NOW,
      );

      expect(plan).toMatchObject({ ok: true });
      if (!plan.ok) return;
      expect(formatCredits(plan.fromBalance)).toBe('2.5');
      expect(formatCredits(plan.overage)).toBe('3.5');
    });

    it('refuses the whole deduction when the overage room is too small', () => {
      const plan = planDeduction(
        [allocation('purchase', '2.5', null)],
        d('7.500001'),
        d('5'),
        NOW,
      );

      expect(plan).toEqual({
        ok: false,
        available: d('2.5'),
        overageRoom: d('5'),
        shortfall: d('0.000001'),
      });
    });

    it('spends exactly the full balance without overage', () => {
      const plan = planDeduction(
        [allocation('a', '0.333333', null), allocation('b', '0.666667', null)],
        d('1'),
        d(0),
        NOW,
      );
      expect(plan).toMatchObject({ ok: true });
      if (plan.ok) expect(formatCredits(plan.overage)).toBe('0');
    });

    it('treats a negative overage room as none', () => {
      expect(planDeduction([], d('1'), d('-3'), NOW)).toMatchObject({
        ok: false,
        overageRoom: d(0),
      });
    });
  });

  describe('session overage', () => {
    it('is the limit minus what the session already used, never negative', () => {
      expect(formatCredits(sessionOverageRoom(d('5'), d('1.5')))).toBe('3.5');
      expect(formatCredits(sessionOverageRoom(d('5'), d('5')))).toBe('0');
      expect(formatCredits(sessionOverageRoom(d('3'), d('5')))).toBe('0');
    });

    it('repays outstanding overage oldest session first, up to the new credits', () => {
      const plan = planOverageSettlement(d('4'), [
        { id: 'old', unsettled: d('2.5') },
        { id: 'settled', unsettled: d('0') },
        { id: 'new', unsettled: d('3') },
      ]);

      expect(formatCredits(plan.settled)).toBe('4');
      expect(
        plan.bySession.map((s) => [s.id, formatCredits(s.credits)]),
      ).toEqual([
        ['old', '2.5'],
        ['new', '1.5'],
      ]);
    });

    it('repays everything when the new credits cover it', () => {
      const plan = planOverageSettlement(d('10'), [
        { id: 'a', unsettled: d('0.25') },
      ]);
      expect(formatCredits(plan.settled)).toBe('0.25');
    });
  });

  describe('AI cost conversion', () => {
    it.each([
      // [cost in USD, rate in micro-dollars per credit, credits]
      ['0.025', 5000, '5'], // $0.005 per credit: $0.025 = 5 credits
      ['0.005', 5000, '1'],
      ['0.0123', 5000, '2.46'],
      ['0.0000123', 5000, '0.00246'],
      ['1.5', 5000, '300'],
      ['0.025', 2500, '10'], // $0.0025 per credit
      ['0.025', 10000, '2.5'],
      ['0.0000000025', 5000, '0.000001'], // rounds half up at 6 places
      ['0.0000000024', 5000, '0'],
      ['0', 5000, '0'],
    ])(
      '$%s at %d micro-dollars per credit = %s credits',
      (cost, rate, credits) => {
        expect(formatCredits(creditsForCost(d(cost), rate))).toBe(credits);
      },
    );

    it('is exact where floating point is not', () => {
      // 0.1 + 0.2 dollars at $0.005 per credit is exactly 60 credits.
      expect(formatCredits(creditsForCost(d('0.1').plus(d('0.2')), 5000))).toBe(
        '60',
      );
    });

    it('refuses a non-positive or fractional rate', () => {
      expect(() => creditsForCost(d('1'), 0)).toThrow(CreditRuleViolation);
      expect(() => creditsForCost(d('1'), 2.5)).toThrow(CreditRuleViolation);
    });

    it.each([
      [0.025, '0.025'],
      ['0.0000123', '0.0000123'],
      [1.23e-7, '0.000000123'],
      // Stored with 12 decimal places, rounded half up like PostgreSQL.
      ['0.0000000000005', '0.000000000001'],
      [0, '0'],
    ])('parses the provider cost %p as $%s', (value, expected) => {
      expect(parseUsdCost(value)?.toFixed()).toBe(expected);
    });

    it.each([
      [-0.01],
      ['-1'],
      [Number.NaN],
      ['1e-3'],
      ['abc'],
      [null],
      [undefined],
    ])('reports no usable cost for %p', (value) => {
      expect(parseUsdCost(value)).toBeNull();
    });
  });

  describe('overageRoomFor', () => {
    const room = (input: {
      sessionLimit?: string;
      sessionUsed?: string;
      walletOutstanding?: string;
      allowance?: string;
      funded?: boolean;
    }) =>
      formatCredits(
        overageRoomFor({
          sessionLimit: d(input.sessionLimit ?? '5'),
          sessionUsed: d(input.sessionUsed ?? '0'),
          walletOutstanding: d(input.walletOutstanding ?? '0'),
          allowance: d(input.allowance ?? '5'),
          funded: input.funded ?? true,
        }),
      );

    it('is the whole allowance for a funded session of a user without overage', () => {
      expect(room({})).toBe('5');
    });

    it("is the session's remaining allowance", () => {
      expect(room({ sessionUsed: '3.5', walletOutstanding: '3.5' })).toBe(
        '1.5',
      );
    });

    it('never exceeds what the user has left across sessions', () => {
      expect(room({ walletOutstanding: '4' })).toBe('1');
      expect(room({ walletOutstanding: '5' })).toBe('0');
      // The allowance was lowered below what is outstanding.
      expect(room({ walletOutstanding: '4', allowance: '2' })).toBe('0');
    });

    it("keeps a session's fixed limit", () => {
      expect(
        room({
          sessionLimit: '2',
          sessionUsed: '1.5',
          walletOutstanding: '1.5',
        }),
      ).toBe('0.5');
    });

    it('is zero for a session never funded with credits', () => {
      expect(room({ funded: false })).toBe('0');
    });
  });
});
