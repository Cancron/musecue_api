import { BillingInterval, PaymentStatus } from '@prisma/client';
import {
  addBillingInterval,
  canTransitionPayment,
  getPaidTermRejection,
  isValidBillingPeriod,
  planPriceCents,
  validateNewPayment,
} from './billing.validation';

const utc = (iso: string) => new Date(`${iso}Z`);
const { MONTHLY, YEARLY } = BillingInterval;

describe('billing periods', () => {
  it.each([
    ['2026-03-15T10:20:30.400', MONTHLY, '2026-04-15T10:20:30.400'],
    ['2026-01-31T00:00:00.000', MONTHLY, '2026-02-28T00:00:00.000'],
    ['2028-01-31T00:00:00.000', MONTHLY, '2028-02-29T00:00:00.000'],
    ['2026-03-31T00:00:00.000', MONTHLY, '2026-04-30T00:00:00.000'],
    ['2026-12-31T23:59:59.999', MONTHLY, '2027-01-31T23:59:59.999'],
    ['2026-03-15T10:20:30.400', YEARLY, '2027-03-15T10:20:30.400'],
    ['2028-02-29T12:00:00.000', YEARLY, '2029-02-28T12:00:00.000'],
    ['2027-03-01T00:00:00.000', YEARLY, '2028-03-01T00:00:00.000'],
  ])('%s + one %s ends at %s', (start, interval, end) => {
    expect(addBillingInterval(utc(start), interval)).toEqual(utc(end));
  });

  it('always produces a period the database accepts, for every start day across a leap cycle', () => {
    for (let day = 0; day < 366 * 2; day += 1) {
      const start = new Date(Date.UTC(2027, 0, 1 + day, 7, 45));
      for (const interval of [MONTHLY, YEARLY]) {
        expect(
          isValidBillingPeriod(
            start,
            addBillingInterval(start, interval),
            interval,
          ),
        ).toBe(true);
      }
    }
  });

  it.each([
    [
      'a 28-day "month" (Mar 1 -> Mar 29)',
      '2026-03-01T00:00:00.000',
      '2026-03-29T00:00:00.000',
      MONTHLY,
    ],
    [
      'a 30-day "month" that should be 31 (Mar 1 -> Mar 31)',
      '2026-03-01T00:00:00.000',
      '2026-03-31T00:00:00.000',
      MONTHLY,
    ],
    [
      'Jan 31 -> Mar 3 (31 days, but not a calendar month)',
      '2026-01-31T00:00:00.000',
      '2026-03-03T00:00:00.000',
      MONTHLY,
    ],
    [
      'Jan 31 -> Feb 28 in a leap year (must be Feb 29)',
      '2028-01-31T00:00:00.000',
      '2028-02-28T00:00:00.000',
      MONTHLY,
    ],
    [
      'a period ending 1 ms early',
      '2026-03-01T00:00:00.000',
      '2026-03-31T23:59:59.999',
      MONTHLY,
    ],
    [
      'a 366-day "year" without a leap day (2026-03-01 -> 2027-03-02)',
      '2026-03-01T00:00:00.000',
      '2027-03-02T00:00:00.000',
      YEARLY,
    ],
    [
      'a 365-day "year" across a leap day (2027-03-01 -> 2028-02-29)',
      '2027-03-01T00:00:00.000',
      '2028-02-29T00:00:00.000',
      YEARLY,
    ],
    [
      'Feb 29 -> Mar 1 next year (must be Feb 28)',
      '2028-02-29T00:00:00.000',
      '2029-03-01T00:00:00.000',
      YEARLY,
    ],
  ])(
    'rejects %s, which the old day-range check accepted',
    (_case, start, end, interval) => {
      expect(isValidBillingPeriod(utc(start), utc(end), interval)).toBe(false);
    },
  );

  it.each([
    [
      'Mar 1 -> Apr 1',
      '2026-03-01T00:00:00.000',
      '2026-04-01T00:00:00.000',
      MONTHLY,
    ],
    [
      'Jan 31 -> Feb 28',
      '2026-01-31T00:00:00.000',
      '2026-02-28T00:00:00.000',
      MONTHLY,
    ],
    [
      'Jan 31 -> Feb 29 (leap year)',
      '2028-01-31T00:00:00.000',
      '2028-02-29T00:00:00.000',
      MONTHLY,
    ],
    [
      'Feb 28 -> Mar 28',
      '2026-02-28T06:00:00.000',
      '2026-03-28T06:00:00.000',
      MONTHLY,
    ],
    [
      '2027-03-01 -> 2028-03-01 (366 days)',
      '2027-03-01T00:00:00.000',
      '2028-03-01T00:00:00.000',
      YEARLY,
    ],
    [
      'Feb 29 -> Feb 28',
      '2028-02-29T12:00:00.000',
      '2029-02-28T12:00:00.000',
      YEARLY,
    ],
  ])('accepts the calendar period %s', (_case, start, end, interval) => {
    expect(isValidBillingPeriod(utc(start), utc(end), interval)).toBe(true);
  });

  it('rejects a period that ends before it starts', () => {
    const start = utc('2026-05-01T00:00:00.000');
    expect(
      isValidBillingPeriod(start, addBillingInterval(start, MONTHLY), YEARLY),
    ).toBe(false);
    expect(
      isValidBillingPeriod(start, utc('2026-04-01T00:00:00.000'), MONTHLY),
    ).toBe(false);
  });
});

describe('pricing', () => {
  const defaults = { monthlyPriceUsdCents: 1900, yearlyPriceUsdCents: 19000 };
  const payment = (overrides = {}) => ({
    provider: 'stripe',
    providerPaymentId: 'pi_123',
    amountCents: 1900,
    currency: 'USD',
    billingInterval: MONTHLY,
    periodStart: utc('2026-03-01T00:00:00.000'),
    periodEnd: utc('2026-04-01T00:00:00.000'),
    ...overrides,
  });

  it('prices the monthly and yearly options from the plan', () => {
    expect(planPriceCents(defaults, MONTHLY)).toBe(1900);
    expect(planPriceCents(defaults, YEARLY)).toBe(19000);
  });

  it('accepts a monthly and a yearly payment at the plan price', () => {
    expect(validateNewPayment(payment(), defaults)).toEqual([]);
    expect(
      validateNewPayment(
        payment({
          amountCents: 19000,
          billingInterval: YEARLY,
          periodEnd: utc('2027-03-01T00:00:00.000'),
        }),
        defaults,
      ),
    ).toEqual([]);
  });

  it('checks the amount against the current (admin-configured) price', () => {
    const repriced = { monthlyPriceUsdCents: 2400, yearlyPriceUsdCents: 24000 };
    expect(validateNewPayment(payment(), repriced)).toEqual([
      'AMOUNT_DOES_NOT_MATCH_PRICE',
    ]);
    expect(
      validateNewPayment(payment({ amountCents: 2400 }), repriced),
    ).toEqual([]);
  });

  it.each([
    [
      'the yearly price for a monthly period',
      { amountCents: 19000 },
      ['AMOUNT_DOES_NOT_MATCH_PRICE'],
    ],
    [
      'dollars instead of cents',
      { amountCents: 19 },
      ['AMOUNT_DOES_NOT_MATCH_PRICE'],
    ],
    ['another currency', { currency: 'EUR' }, ['CURRENCY_NOT_SUPPORTED']],
    ['a lowercase currency', { currency: 'usd' }, ['CURRENCY_NOT_SUPPORTED']],
    [
      'a blank provider payment ID',
      { providerPaymentId: '  ' },
      ['MISSING_PROVIDER_ID'],
    ],
    [
      'a yearly interval with a monthly period',
      { billingInterval: YEARLY, amountCents: 19000 },
      ['INVALID_BILLING_PERIOD'],
    ],
    [
      'everything wrong at once',
      {
        provider: '',
        currency: 'EUR',
        amountCents: 1,
        periodEnd: utc('2026-03-02T00:00:00.000'),
      },
      [
        'MISSING_PROVIDER_ID',
        'CURRENCY_NOT_SUPPORTED',
        'AMOUNT_DOES_NOT_MATCH_PRICE',
        'INVALID_BILLING_PERIOD',
      ],
    ],
  ])('rejects %s', (_case, overrides, errors) => {
    expect(validateNewPayment(payment(overrides), defaults)).toEqual(errors);
  });
});

describe('payment status transitions', () => {
  const all = Object.values(PaymentStatus);
  const allowed = new Set([
    'PENDING->SUCCEEDED',
    'PENDING->FAILED',
    'SUCCEEDED->PARTIALLY_REFUNDED',
    'SUCCEEDED->REFUNDED',
    'PARTIALLY_REFUNDED->REFUNDED',
  ]);

  it.each(all.flatMap((from) => all.map((to) => [from, to] as const)))(
    '%s -> %s',
    (from, to) => {
      expect(canTransitionPayment(from, to)).toBe(
        from === to || allowed.has(`${from}->${to}`),
      );
    },
  );
});

describe('a payment grants access only for the period it covers', () => {
  const d = (iso: string) => utc(`${iso}T00:00:00.000`);
  const none = { proStartedAt: null, proExpiresAt: null };
  const paid = (
    periodStart: string,
    periodEnd: string,
    overrides: Partial<{
      status: PaymentStatus;
      billingInterval: BillingInterval;
      subscriptionId: string;
    }> = {},
  ) => ({
    subscriptionId: 's1',
    status: PaymentStatus.SUCCEEDED,
    billingInterval: MONTHLY,
    periodStart: d(periodStart),
    periodEnd: d(periodEnd),
    ...overrides,
  });
  const term = (
    from: string,
    to: string,
    billingInterval: BillingInterval = MONTHLY,
  ) => ({
    billingInterval,
    proStartedAt: d(from),
    proExpiresAt: d(to),
  });
  const current = (from: string, to: string) => ({
    proStartedAt: d(from),
    proExpiresAt: d(to),
  });

  describe('verification', () => {
    it('accepts a SUCCEEDED payment for exactly the new term', () => {
      expect(
        getPaidTermRejection(
          paid('2026-03-01', '2026-04-01'),
          's1',
          none,
          term('2026-03-01', '2026-04-01'),
        ),
      ).toBeNull();
    });

    it.each(['PENDING', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const)(
      'rejects a %s payment',
      (status) => {
        expect(
          getPaidTermRejection(
            paid('2026-03-01', '2026-04-01', { status }),
            's1',
            none,
            term('2026-03-01', '2026-04-01'),
          ),
        ).toBe('PAYMENT_NOT_VERIFIED');
      },
    );

    it('rejects a payment of another subscription', () => {
      expect(
        getPaidTermRejection(
          paid('2026-03-01', '2026-04-01', { subscriptionId: 's2' }),
          's1',
          none,
          term('2026-03-01', '2026-04-01'),
        ),
      ).toBe('PAYMENT_BELONGS_TO_ANOTHER_SUBSCRIPTION');
    });

    it('rejects a payment with another billing interval', () => {
      expect(
        getPaidTermRejection(
          paid('2026-03-01', '2027-03-01', { billingInterval: YEARLY }),
          's1',
          none,
          term('2026-03-01', '2027-03-01'),
        ),
      ).toBe('INTERVAL_MISMATCH');
    });

    it('rejects a term that runs past the paid period', () => {
      expect(
        getPaidTermRejection(
          paid('2026-03-01', '2026-04-01'),
          's1',
          none,
          term('2026-03-01', '2026-04-02'),
        ),
      ).toBe('TERM_DOES_NOT_END_WITH_PAID_PERIOD');
    });
  });

  describe('initial term (regression: could start before its paid period)', () => {
    it('rejects a term starting before the paid period', () => {
      expect(
        getPaidTermRejection(
          paid('2026-03-20', '2026-04-20'),
          's1',
          none,
          term('2026-03-01', '2026-04-20'),
        ),
      ).toBe('TERM_STARTS_BEFORE_PAID_PERIOD');
    });

    it('accepts a term starting at or after the paid period start', () => {
      expect(
        getPaidTermRejection(
          paid('2026-03-20', '2026-04-20'),
          's1',
          none,
          term('2026-03-20', '2026-04-20'),
        ),
      ).toBeNull();
      expect(
        getPaidTermRejection(
          paid('2026-03-20', '2026-04-20'),
          's1',
          none,
          term('2026-03-25', '2026-04-20'),
        ),
      ).toBeNull();
    });

    it('rejects a repurchase after a lapse that starts before its paid period', () => {
      expect(
        getPaidTermRejection(
          paid('2026-05-10', '2026-06-10'),
          's1',
          current('2026-03-01', '2026-04-01'),
          term('2026-05-01', '2026-06-10'),
        ),
      ).toBe('TERM_STARTS_BEFORE_PAID_PERIOD');
    });

    it('accepts a repurchase after a lapse that starts with its paid period', () => {
      expect(
        getPaidTermRejection(
          paid('2026-05-10', '2026-06-10'),
          's1',
          current('2026-03-01', '2026-04-01'),
          term('2026-05-10', '2026-06-10'),
        ),
      ).toBeNull();
    });

    it('treats moving the start earlier as a new term that must be paid from its new start', () => {
      expect(
        getPaidTermRejection(
          paid('2026-04-01', '2026-05-01'),
          's1',
          current('2026-03-01', '2026-04-01'),
          term('2026-02-01', '2026-05-01'),
        ),
      ).toBe('TERM_STARTS_BEFORE_PAID_PERIOD');
    });
  });

  describe('renewal (regression: could bridge an unpaid gap)', () => {
    it('rejects a renewal whose paid period starts after the current expiry', () => {
      expect(
        getPaidTermRejection(
          paid('2026-05-01', '2026-06-01'),
          's1',
          current('2026-03-01', '2026-04-01'),
          term('2026-03-01', '2026-06-01'),
        ),
      ).toBe('UNPAID_GAP');
    });

    it('rejects a gap of a single millisecond', () => {
      expect(
        getPaidTermRejection(
          {
            ...paid('2026-04-01', '2026-05-01'),
            periodStart: new Date(d('2026-04-01').getTime() + 1),
            periodEnd: new Date(d('2026-05-01').getTime() + 1),
          },
          's1',
          current('2026-03-01', '2026-04-01'),
          {
            ...term('2026-03-01', '2026-05-01'),
            proExpiresAt: new Date(d('2026-05-01').getTime() + 1),
          },
        ),
      ).toBe('UNPAID_GAP');
    });

    it('accepts a renewal that starts exactly at the current expiry', () => {
      expect(
        getPaidTermRejection(
          paid('2026-04-01', '2026-05-01'),
          's1',
          current('2026-03-01', '2026-04-01'),
          term('2026-03-01', '2026-05-01'),
        ),
      ).toBeNull();
    });

    it('accepts an early renewal whose period overlaps the current term', () => {
      expect(
        getPaidTermRejection(
          paid('2026-03-25', '2026-04-25'),
          's1',
          current('2026-03-01', '2026-04-01'),
          term('2026-03-01', '2026-04-25'),
        ),
      ).toBeNull();
    });

    it('accepts a change from monthly to yearly at renewal and mid-term', () => {
      expect(
        getPaidTermRejection(
          paid('2026-04-01', '2027-04-01', { billingInterval: YEARLY }),
          's1',
          current('2026-03-01', '2026-04-01'),
          term('2026-03-01', '2027-04-01', YEARLY),
        ),
      ).toBeNull();
      expect(
        getPaidTermRejection(
          paid('2026-03-15', '2027-03-15', { billingInterval: YEARLY }),
          's1',
          current('2026-03-01', '2026-04-01'),
          term('2026-03-01', '2027-03-15', YEARLY),
        ),
      ).toBeNull();
    });
  });

  it('needs no payment for changes that grant nothing new (cancel or shorten)', () => {
    const unverified = paid('2026-01-01', '2026-02-01', { status: 'FAILED' });
    expect(
      getPaidTermRejection(
        unverified,
        's1',
        current('2026-03-01', '2026-04-01'),
        term('2026-03-01', '2026-04-01'),
      ),
    ).toBeNull();
    expect(
      getPaidTermRejection(
        unverified,
        's1',
        current('2026-03-01', '2026-04-01'),
        term('2026-03-01', '2026-03-20'),
      ),
    ).toBeNull();
  });
});
