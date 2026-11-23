import {
  fulfillmentErrorCode,
  giftCreditReference,
  MAX_FULFILLMENT_ATTEMPTS,
  recipientHoldReason,
  retryDelayMs,
} from './credit-fulfillment.policy';

describe('credit package fulfillment policy', () => {
  const account = (overrides: Record<string, unknown> = {}) => ({
    verified: true,
    status: 'ACTIVE',
    deletedAt: null,
    ...overrides,
  });

  it('lets verified, active accounts receive credits', () => {
    expect(recipientHoldReason(account())).toBeNull();
  });

  it.each([
    ['a deleted account', null, 'RECIPIENT_DELETED'],
    [
      'a soft-deleted account',
      account({ deletedAt: new Date() }),
      'RECIPIENT_DELETED',
    ],
    ['a DELETED account', account({ status: 'DELETED' }), 'RECIPIENT_DELETED'],
    [
      'an unverified account',
      account({ verified: false }),
      'RECIPIENT_UNVERIFIED',
    ],
    [
      'a suspended account',
      account({ status: 'SUSPENDED' }),
      'RECIPIENT_INACTIVE',
    ],
    ['a blocked account', account({ status: 'BLOCKED' }), 'RECIPIENT_INACTIVE'],
    [
      'an inactive account',
      account({ status: 'INACTIVE' }),
      'RECIPIENT_INACTIVE',
    ],
    [
      'an account pending deletion',
      account({ status: 'PENDING_DELETION' }),
      'RECIPIENT_INACTIVE',
    ],
  ])('holds credits for %s', (_, recipient, reason) => {
    expect(recipientHoldReason(recipient)).toBe(reason);
  });

  it('backs off between attempts and gives up after the last one', () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelayMs)).toEqual([
      30_000, 120_000, 600_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
    expect(MAX_FULFILLMENT_ATTEMPTS).toBe(5);
  });

  it('records error codes, never messages', () => {
    expect(fulfillmentErrorCode(new TypeError('secret details'))).toBe(
      'TypeError',
    );
    expect(fulfillmentErrorCode({ code: 'P2034', message: 'x' })).toBe(
      'db:P2034',
    );
    expect(fulfillmentErrorCode('boom')).toBe('unknown');
  });

  it('references gift credits by gift', () => {
    expect(giftCreditReference('g1')).toBe('credit-gift:g1');
  });
});
