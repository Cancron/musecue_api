import { Prisma } from '@prisma/client';
import { ZERO_CREDITS } from './credit-amount';
import { SESSION_RESERVATION_CREDITS } from './credit-settings.constants';

/**
 * Pure rules of session credits (no database access), used by
 * CreditWalletService under the wallet lock. See CreditSessionOverage in
 * prisma/schema/credit.prisma.
 */

/** The stored credit state of one makeup session. */
export interface SessionCreditState {
  reservationRemaining: Prisma.Decimal;
  overageLimit: Prisma.Decimal;
  overageUsed: Prisma.Decimal;
}

/**
 * Credits a session (or a debit without a session) may take from the
 * balance: the usable balance minus what the user's other sessions have
 * reserved. Never negative.
 */
export function freeCredits(
  available: Prisma.Decimal,
  reservedByOthers: Prisma.Decimal,
): Prisma.Decimal {
  return Prisma.Decimal.max(available.minus(reservedByOthers), ZERO_CREDITS);
}

/** Credits a session reserves when it is initialized with `free` credits. */
export function reservationFor(free: Prisma.Decimal): Prisma.Decimal {
  return Prisma.Decimal.min(
    free,
    new Prisma.Decimal(SESSION_RESERVATION_CREDITS),
  );
}

/** Overage the session can still use. */
export function overageRemaining(
  state: Pick<SessionCreditState, 'overageLimit' | 'overageUsed'>,
): Prisma.Decimal {
  return Prisma.Decimal.max(
    state.overageLimit.minus(state.overageUsed),
    ZERO_CREDITS,
  );
}

/**
 * The session's unused reservation after a charge that took `consumed`
 * credits from the balance and `overage` beyond it: the balance is used
 * first, and a charge that needed overage has used up the reservation.
 */
export function reservationAfterCharge(
  reservationRemaining: Prisma.Decimal,
  consumed: Prisma.Decimal,
  overage: Prisma.Decimal,
): Prisma.Decimal {
  if (overage.gt(0)) return ZERO_CREDITS;
  return Prisma.Decimal.max(reservationRemaining.minus(consumed), ZERO_CREDITS);
}

/**
 * Reservations can only hold credits that still exist: when credits expire,
 * the reservations of unfinished sessions are reduced (oldest session
 * first) until together they fit in the credits left. Returns the new
 * reservation of every session that changes. Pure.
 */
export function capReservations(
  reservations: Array<{
    id: string;
    reservationRemaining: Prisma.Decimal;
    initializedAt: Date;
  }>,
  available: Prisma.Decimal,
): Array<{ id: string; reservationRemaining: Prisma.Decimal }> {
  let excess = reservations
    .reduce((sum, row) => sum.plus(row.reservationRemaining), ZERO_CREDITS)
    .minus(available);
  const changes: Array<{ id: string; reservationRemaining: Prisma.Decimal }> =
    [];
  const oldestFirst = [...reservations].sort(
    (a, b) =>
      a.initializedAt.getTime() - b.initializedAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  for (const row of oldestFirst) {
    if (excess.lte(0)) break;
    const cut = Prisma.Decimal.min(row.reservationRemaining, excess);
    changes.push({
      id: row.id,
      reservationRemaining: row.reservationRemaining.minus(cut),
    });
    excess = excess.minus(cut);
  }
  return changes;
}
