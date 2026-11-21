import { CreditSource, Prisma } from '@prisma/client';
import {
  summarizeAllocation,
  summarizeSource,
  type AllocationRecord,
} from './credit-account.policy';

const D = (value: string | number) => new Prisma.Decimal(value);
const NOW = new Date('2026-12-01T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

const record = (
  overrides: Partial<AllocationRecord> = {},
): AllocationRecord => ({
  id: 'a-1',
  source: CreditSource.SUBSCRIPTION,
  amount: D(1000),
  remaining: D(1000),
  grantedAt: at(-10),
  periodStart: at(-10),
  expiresAt: at(20),
  ...overrides,
});
const numbers = (summary: ReturnType<typeof summarizeAllocation>) => [
  summary.state,
  summary.available.toFixed(),
  summary.upcoming.toFixed(),
  summary.used.toFixed(),
  summary.expired.toFixed(),
];

describe('credit account balance policy', () => {
  it('splits an allocation into available, used and expired credits that add up to the grant', () => {
    expect(
      numbers(
        summarizeAllocation(
          record({ remaining: D('987.5') }),
          { used: D('12.5'), expired: D(0), expiredAt: null },
          NOW,
        ),
      ),
    ).toEqual(['AVAILABLE', '987.5', '0', '12.5', '0']);
  });

  it('counts credits past their expiry as expired even before the expiration was recorded', () => {
    const summary = summarizeAllocation(
      record({ remaining: D(40), expiresAt: at(-1) }),
      { used: D(960), expired: D(0), expiredAt: null },
      NOW,
    );
    expect(numbers(summary)).toEqual(['EXPIRED', '0', '0', '960', '40']);
    expect(summary.expiredAt).toEqual(at(-1));
  });

  it('takes recorded expirations, including early ones, with their time', () => {
    const summary = summarizeAllocation(
      record({ source: CreditSource.TRIAL, amount: D(50), remaining: D(0) }),
      { used: D(10), expired: D(40), expiredAt: at(-3) },
      NOW,
    );
    expect(numbers(summary)).toEqual(['EXPIRED', '0', '0', '10', '40']);
    expect(summary.expiredAt).toEqual(at(-3));
  });

  it('reports credits of a month that has not started as upcoming', () => {
    expect(
      numbers(
        summarizeAllocation(record({ periodStart: at(5) }), undefined, NOW),
      ),
    ).toEqual(['UPCOMING', '0', '1000', '0', '0']);
  });

  it('never expires purchased credits', () => {
    expect(
      numbers(
        summarizeAllocation(
          record({
            source: CreditSource.PURCHASE,
            periodStart: null,
            expiresAt: null,
            remaining: D(0),
            amount: D(5),
          }),
          { used: D(5), expired: D(0), expiredAt: null },
          NOW,
        ),
      ),
    ).toEqual(['USED_UP', '0', '0', '5', '0']);
  });

  it('sums a source and names its next expiry', () => {
    const summaries = [
      summarizeAllocation(
        record({ id: 'old', expiresAt: at(-1), remaining: D(3) }),
        undefined,
        NOW,
      ),
      summarizeAllocation(
        record({ id: 'now', remaining: D(900) }),
        { used: D(100), expired: D(0), expiredAt: null },
        NOW,
      ),
      summarizeAllocation(
        record({ id: 'next', periodStart: at(20), expiresAt: at(50) }),
        undefined,
        NOW,
      ),
    ];
    expect(summarizeSource(CreditSource.SUBSCRIPTION, summaries, true)).toEqual(
      {
        source: CreditSource.SUBSCRIPTION,
        granted: '3000',
        available: '900',
        upcoming: '1000',
        used: '100',
        expired: '3',
        expires: true,
        usableNow: true,
        nextExpiresAt: at(20).toISOString(),
      },
    );
    expect(
      summarizeSource(CreditSource.REFERRAL, summaries, true),
    ).toMatchObject({
      granted: '0',
      expires: false,
      nextExpiresAt: null,
    });
  });
});
