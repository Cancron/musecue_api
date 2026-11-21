import { Prisma } from '@prisma/client';
import {
  capReservations,
  freeCredits,
  overageRemaining,
  reservationAfterCharge,
  reservationFor,
} from './credit-session.policy';

const D = (value: string | number) => new Prisma.Decimal(value);

describe('session credit policy', () => {
  it.each([
    ['10', '3', '7'],
    ['1', '1', '0'],
    ['0.5', '1', '0'],
    ['0', '0', '0'],
  ])(
    'has %s usable minus %s reserved by other sessions = %s free',
    (available, reserved, free) => {
      expect(freeCredits(D(available), D(reserved)).toFixed()).toBe(free);
    },
  );

  it.each([
    ['1000', '1'],
    ['1', '1'],
    ['0.4', '0.4'],
  ])('reserves at most one credit: %s free -> %s', (free, reserved) => {
    expect(reservationFor(D(free)).toFixed()).toBe(reserved);
  });

  it('has the rest of the overage allowance left, never below zero', () => {
    const state = { overageLimit: D(5), overageUsed: D('1.25') };
    expect(overageRemaining(state).toFixed()).toBe('3.75');
    expect(overageRemaining({ ...state, overageUsed: D(5) }).toFixed()).toBe(
      '0',
    );
  });

  it('uses the reservation with the balance, and ends it once overage is needed', () => {
    expect(reservationAfterCharge(D(1), D('0.4'), D(0)).toFixed()).toBe('0.6');
    expect(reservationAfterCharge(D(1), D(3), D(0)).toFixed()).toBe('0');
    expect(reservationAfterCharge(D('0.5'), D(0), D(2)).toFixed()).toBe('0');
  });

  describe('capReservations', () => {
    const row = (id: string, reserved: string, minutes: number) => ({
      id,
      reservationRemaining: D(reserved),
      initializedAt: new Date(Date.UTC(2026, 11, 1, 12, minutes)),
    });

    it('changes nothing while the reserved credits still exist', () => {
      expect(
        capReservations([row('a', '1', 0), row('b', '1', 1)], D(2)),
      ).toEqual([]);
    });

    it('reduces the oldest reservations first to the credits left after an expiry', () => {
      const changes = capReservations(
        [row('new', '1', 5), row('old', '1', 1), row('mid', '0.5', 3)],
        D('1.2'),
      );
      expect(
        changes.map((c) => [c.id, c.reservationRemaining.toFixed()]),
      ).toEqual([
        ['old', '0'],
        ['mid', '0.2'],
      ]);
    });

    it('ends every reservation when no credits are left', () => {
      expect(
        capReservations([row('a', '1', 0), row('b', '0.4', 1)], D(0)).map((c) =>
          c.reservationRemaining.toFixed(),
        ),
      ).toEqual(['0', '0']);
    });
  });
});
