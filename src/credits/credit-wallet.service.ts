import { Injectable } from '@nestjs/common';
import {
  CreditSource,
  CreditTransactionType,
  Prisma,
  type CreditAllocation,
  type CreditLedgerEntry,
  type CreditSessionOverage,
  type CreditTransaction,
} from '@prisma/client';
import { PrismaService } from '../common/services/prisma.service';
import {
  formatCredits,
  InvalidCreditAmountError,
  parseCreditAmount,
  sumCredits,
  ZERO_CREDITS,
} from './credit-amount';
import {
  compareSpendingOrder,
  getGrantExpiryRejection,
  getPaymentLinkRejection,
  hasAllocationStarted,
  getReferenceRejection,
  isAllocationAvailable,
  planDebit,
} from './credit-ledger.policy';
import {
  capReservations,
  freeCredits,
  overageRemaining,
  reservationAfterCharge,
  reservationFor,
} from './credit-session.policy';
import { CreditSettingsService } from './credit-settings.service';
import {
  CreditConflictError,
  CreditOwnerNotFoundError,
  CreditSessionNotFoundError,
  InsufficientCreditsError,
  InvalidCreditOperationError,
} from './credit-wallet.errors';
import type {
  CreditAllocationView,
  CreditBalanceView,
  CreditTransactionView,
  DebitCreditsInput,
  DebitCreditsResult,
  ExpireDueCreditsResult,
  GrantCreditsInput,
  GrantCreditsResult,
  SessionCreditInput,
  SessionCreditView,
  SessionUseView,
} from './interfaces/credit-wallet.interface';

type Tx = Prisma.TransactionClient;
type TransactionWithEntries = CreditTransaction & {
  entries: CreditLedgerEntry[];
};

interface LockedWallet {
  id: string;
  authId: string;
  /** Taken after the lock was acquired. */
  now: Date;
  /** Expirations recorded when the wallet was locked. */
  expired: number;
}

export interface WalletOperationOptions {
  /**
   * Run inside this (caller's) transaction instead of a new one, so the
   * credit change commits or rolls back together with the caller's writes.
   * The wallet stays locked until that transaction ends.
   */
  tx?: Prisma.TransactionClient;
  /**
   * When the change takes effect (grant time, expiry checks, occurredAt),
   * for a change that belongs to an event with its own time, such as a
   * trial starting. Defaults to the time the wallet lock was acquired.
   */
  at?: Date;
}

/**
 * Waiting for another operation's wallet lock counts towards the
 * transaction timeout; operations on one wallet are short.
 */
const WALLET_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

/**
 * Persistent credit wallet and append-only ledger.
 *
 * Every change runs in one database transaction that locks the user's
 * CreditWallet row (SELECT ... FOR UPDATE), so concurrent grants, debits and
 * expirations of one user are applied one at a time against the latest
 * state; different users do not block each other. Grants are idempotent per
 * (user, source, sourceReference) and debits per (user, idempotencyKey), and
 * the database enforces the same uniqueness. Before any change, expired
 * allocations are closed with EXPIRATION transactions, so each transaction's
 * `balanceAfter` is what the wallet holds at that moment: the available
 * balance plus any credits allocated for a period that has not started yet.
 * Reads never count expired credits, even before their expiration has been
 * recorded, nor credits whose period has not started.
 *
 * Makeup sessions: a session is initialized (initializeSession, or
 * prepareSessionUse before an AI request) under the same lock with free
 * credits, i.e. the usable balance minus the credits the user's other
 * sessions have reserved, and reserves up to one of them; without free
 * credits it is refused (403 "Insufficient credits"). Debits for a session
 * use its reservation and the free balance, then its overage allowance
 * (fixed at initialization); other debits cannot spend reserved credits.
 * Because every step runs under the wallet lock, concurrent sessions and
 * requests can neither spend a credit twice nor obtain overage without
 * credits of their own. An unfinished session keeps its reservation;
 * reservations of completed or deleted sessions are released whenever the
 * wallet is locked.
 */
@Injectable()
export class CreditWalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CreditSettingsService,
  ) {}

  /**
   * Grants credits from one source event. Re-granting the same
   * (source, sourceReference) with the same amount and expiry returns the
   * existing grant (`replayed: true`) without adding credits; with different
   * values it is rejected. A user can receive TRIAL credits only once.
   */
  async grant(
    input: GrantCreditsInput,
    options: WalletOperationOptions = {},
  ): Promise<GrantCreditsResult> {
    const amount = this.parseAmount(input.amount);
    this.assertReference('sourceReference', input.sourceReference);
    if (!Object.values(CreditSource).includes(input.source)) {
      throw new InvalidCreditOperationError('Unknown credit source');
    }
    const expiresAt = input.expiresAt ?? null;
    const linkRejection = getPaymentLinkRejection(
      input.source,
      input.payment,
      expiresAt,
    );
    if (linkRejection) throw new InvalidCreditOperationError(linkRejection);
    const idempotencyKey = `grant:${input.source}:${input.sourceReference}`;

    return this.withLockedWallet(
      input.authId,
      async (tx, wallet) => {
        const existing = await tx.creditAllocation.findUnique({
          where: {
            walletId_source_sourceReference: {
              walletId: wallet.id,
              source: input.source,
              sourceReference: input.sourceReference,
            },
          },
        });
        if (existing) {
          const same =
            existing.amount.eq(amount) &&
            (existing.expiresAt?.getTime() ?? null) ===
              (expiresAt?.getTime() ?? null);
          if (!same && !input.keepExistingGrant) {
            throw new CreditConflictError(
              'These credits were already granted with a different amount or expiration',
            );
          }
          const transaction = await this.findTransaction(
            tx,
            wallet.id,
            idempotencyKey,
          );
          return {
            allocation: this.toAllocationView(existing),
            transaction: this.toTransactionView(transaction),
            replayed: true,
          };
        }

        // Checked after the replay lookup, so a retried grant is still
        // recognized once its credits have expired.
        const expiryRejection = getGrantExpiryRejection(
          input.source,
          expiresAt,
          wallet.now,
        );
        if (expiryRejection) {
          throw new InvalidCreditOperationError(expiryRejection);
        }

        if (input.source === CreditSource.TRIAL) {
          const trial = await tx.creditAllocation.findFirst({
            where: { walletId: wallet.id, source: CreditSource.TRIAL },
            select: { id: true },
          });
          if (trial) {
            throw new CreditConflictError('Trial credits were already granted');
          }
        }

        const balanceBefore = await this.remainingCredits(tx, wallet.id);
        const allocation = await tx.creditAllocation.create({
          data: {
            walletId: wallet.id,
            authId: wallet.authId,
            source: input.source,
            sourceReference: input.sourceReference,
            amount,
            remaining: amount,
            grantedAt: wallet.now,
            expiresAt,
            subscriptionId: input.payment?.subscriptionId ?? null,
            paymentId: input.payment?.paymentId ?? null,
            periodStart: input.payment?.periodStart ?? null,
          },
        });
        const transaction = await tx.creditTransaction.create({
          data: {
            walletId: wallet.id,
            authId: wallet.authId,
            type: CreditTransactionType.GRANT,
            amount,
            balanceAfter: balanceBefore.plus(amount),
            idempotencyKey,
            description: input.description,
            occurredAt: wallet.now,
            entries: {
              create: [{ allocationId: allocation.id, amount }],
            },
          },
          include: { entries: true },
        });
        return {
          allocation: this.toAllocationView(allocation),
          transaction: this.toTransactionView(transaction),
          replayed: false,
        };
      },
      options,
    );
  }

  /**
   * Expires all unused credits of `source` now, before their expiry date
   * (for example trial credits when paid Pro starts): one EXPIRATION
   * transaction per allocation, effective now, with `description`. Credits
   * of other sources are never touched. Returns how many allocations were
   * closed. Creates no wallet: a user without one has nothing to expire.
   * Pass the caller's transaction to commit it together with the event that
   * ends the credits.
   */
  expireSourceNow(
    authId: string,
    source: CreditSource,
    description: string,
    options: WalletOperationOptions = {},
  ): Promise<number> {
    return this.expireNow(authId, { source }, description, options);
  }

  /**
   * Expires the unused credits of one payment now (SUBSCRIPTION months it
   * paid for), e.g. when the payment was refunded: one EXPIRATION
   * transaction per allocation, effective now. Returns how many allocations
   * were closed.
   */
  expirePaymentCreditsNow(
    authId: string,
    paymentId: string,
    description: string,
    options: WalletOperationOptions = {},
  ): Promise<number> {
    return this.expireNow(authId, { paymentId }, description, options);
  }

  private async expireNow(
    authId: string,
    filter: { source?: CreditSource; paymentId?: string },
    description: string,
    options: WalletOperationOptions,
  ): Promise<number> {
    const client = options.tx ?? this.prisma;
    const hasWallet = await client.creditWallet.findUnique({
      where: { authId },
      select: { id: true },
    });
    if (!hasWallet) return 0;
    return this.withLockedWallet(
      authId,
      async (tx, wallet) => {
        const open = await tx.creditAllocation.findMany({
          where: { walletId: wallet.id, ...filter, remaining: { gt: 0 } },
          orderBy: [{ grantedAt: 'asc' }, { id: 'asc' }],
        });
        let balance = await this.remainingCredits(tx, wallet.id);
        for (const allocation of open) {
          balance = balance.minus(allocation.remaining);
          await this.closeAllocation(tx, wallet, allocation, {
            balanceAfter: balance,
            occurredAt: wallet.now,
            description,
          });
        }
        return open.length;
      },
      options,
    );
  }

  /**
   * Debits credits, spending the credits that expire soonest first, but
   * never credits reserved by the user's other sessions. If the free
   * balance cannot cover a debit for an initialized makeup session, the rest
   * may come from the session's overage allowance (fixed when the session
   * was initialized); otherwise the debit is rejected and nothing is
   * written. Retrying with the same idempotency key returns the original
   * debit.
   */
  async debit(
    input: DebitCreditsInput,
    options: WalletOperationOptions = {},
  ): Promise<DebitCreditsResult> {
    const requested = this.parseAmount(input.amount);
    this.assertReference('idempotencyKey', input.idempotencyKey);
    const sessionId = input.sessionId ?? null;
    if (sessionId !== null) this.assertReference('sessionId', sessionId);
    const idempotencyKey = `debit:${input.idempotencyKey}`;

    return this.withLockedWallet(
      input.authId,
      async (tx, wallet) => {
        const previous = await tx.creditTransaction.findUnique({
          where: {
            walletId_idempotencyKey: { walletId: wallet.id, idempotencyKey },
          },
          include: { entries: true },
        });
        if (previous) {
          const previousRequested = previous.amount
            .negated()
            .plus(previous.overageAmount);
          if (
            // A partial debit may have collected less than was requested.
            (!input.partial && !previousRequested.eq(requested)) ||
            previous.sessionId !== sessionId
          ) {
            throw new CreditConflictError(
              'This idempotency key was already used for a different debit',
            );
          }
          return this.toDebitResult(previous, true, requested);
        }

        let sessionCredit: CreditSessionOverage | null = null;
        if (sessionId !== null) {
          const session = await tx.makeupSession.findFirst({
            where: { id: sessionId, authId: wallet.authId },
            select: { id: true },
          });
          if (!session) throw new CreditSessionNotFoundError();
          sessionCredit = await tx.creditSessionOverage.findUnique({
            where: { walletId_sessionId: { walletId: wallet.id, sessionId } },
          });
        }

        const allocations = await tx.creditAllocation.findMany({
          where: { walletId: wallet.id, remaining: { gt: 0 } },
        });
        const spendable = input.sources
          ? allocations.filter((allocation) =>
              input.sources?.includes(allocation.source),
            )
          : allocations;
        const available = sumCredits(
          spendable
            .filter((allocation) =>
              isAllocationAvailable(allocation, wallet.now),
            )
            .map((allocation) => allocation.remaining),
        );
        // Everything the wallet holds (due expirations are already recorded),
        // including credits of periods that have not started.
        const held = sumCredits(
          allocations.map((allocation) => allocation.remaining),
        );
        // Credits reserved by the user's other sessions are not spendable.
        const free = freeCredits(
          available,
          await this.reservedByOthers(tx, wallet.id, sessionId),
        );
        const plan = planDebit(
          spendable,
          Prisma.Decimal.min(requested, free),
          wallet.now,
        );
        const shortfall = requested.minus(plan.consumed);

        const overage = shortfall.gt(0)
          ? this.decideSessionOverage(sessionId, sessionCredit, {
              requested,
              free,
              shortfall,
              partial: input.partial === true,
            })
          : ZERO_CREDITS;

        for (const take of plan.takes) {
          const { count } = await tx.creditAllocation.updateMany({
            where: { id: take.allocationId, remaining: { gte: take.amount } },
            data: { remaining: { decrement: take.amount } },
          });
          if (count !== 1) {
            // Cannot happen while the wallet is locked; never debit silently.
            throw new Error('Credit allocation changed during a locked debit');
          }
        }
        const transaction = await tx.creditTransaction.create({
          data: {
            walletId: wallet.id,
            authId: wallet.authId,
            type: CreditTransactionType.DEBIT,
            amount: plan.consumed.negated(),
            overageAmount: overage,
            balanceAfter: held.minus(plan.consumed),
            idempotencyKey,
            sessionId,
            description: input.description,
            usageCostUsd: input.usage?.costUsd ?? null,
            creditCostUsdMicros: input.usage?.creditCostUsdMicros ?? null,
            occurredAt: wallet.now,
            entries: {
              create: plan.takes.map((take) => ({
                allocationId: take.allocationId,
                amount: take.amount.negated(),
              })),
            },
          },
          include: { entries: true },
        });
        if (sessionCredit) {
          await tx.creditSessionOverage.update({
            where: { id: sessionCredit.id },
            data: {
              overageUsed: sessionCredit.overageUsed.plus(overage),
              reservationRemaining: reservationAfterCharge(
                sessionCredit.reservationRemaining,
                plan.consumed,
                overage,
              ),
            },
          });
        }
        return this.toDebitResult(transaction, false, requested);
      },
      options,
    );
  }

  /**
   * The user's available balance now. Read-only; expired credits and
   * credits whose period has not started never count (the latter are
   * reported as `upcoming`).
   */
  async getBalance(authId: string): Promise<CreditBalanceView> {
    const now = new Date();
    const unexpired = await this.prisma.creditAllocation.findMany({
      where: {
        authId,
        remaining: { gt: 0 },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
    const allocations = unexpired
      .filter((allocation) => isAllocationAvailable(allocation, now))
      .sort(compareSpendingOrder);
    const upcoming = sumCredits(
      unexpired
        .filter((allocation) => !hasAllocationStarted(allocation, now))
        .map((allocation) => allocation.remaining),
    );

    const bySource = Object.fromEntries(
      Object.values(CreditSource).map((source) => [
        source,
        formatCredits(
          sumCredits(
            allocations
              .filter((allocation) => allocation.source === source)
              .map((allocation) => allocation.remaining),
          ),
        ),
      ]),
    ) as Record<CreditSource, string>;

    const expiring = allocations.filter(
      (allocation) => allocation.expiresAt !== null,
    );
    const nextExpiresAt = expiring[0]?.expiresAt ?? null;
    return {
      available: formatCredits(
        sumCredits(allocations.map((allocation) => allocation.remaining)),
      ),
      upcoming: formatCredits(upcoming),
      bySource,
      nextExpiration: nextExpiresAt
        ? {
            expiresAt: nextExpiresAt.toISOString(),
            amount: formatCredits(
              sumCredits(
                expiring
                  .filter(
                    (allocation) =>
                      allocation.expiresAt?.getTime() ===
                      nextExpiresAt.getTime(),
                  )
                  .map((allocation) => allocation.remaining),
              ),
            ),
          }
        : null,
      allocations: allocations.map((allocation) =>
        this.toAllocationView(allocation),
      ),
      asOf: now.toISOString(),
    };
  }

  /** The user's ledger, newest first. */
  async listTransactions(
    authId: string,
    options: { limit?: number } = {},
  ): Promise<CreditTransactionView[]> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
    const transactions = await this.prisma.creditTransaction.findMany({
      where: { authId },
      orderBy: { sequence: 'desc' },
      take: limit,
      include: { entries: true },
    });
    return transactions.map((transaction) =>
      this.toTransactionView(transaction),
    );
  }

  /** Records the expiration of the user's expired credits; returns how many. */
  async expireCredits(authId: string): Promise<number> {
    const hasWallet = await this.prisma.creditWallet.findUnique({
      where: { authId },
      select: { id: true },
    });
    if (!hasWallet) return 0;
    return this.withLockedWallet(authId, (_tx, wallet) =>
      Promise.resolve(wallet.expired),
    );
  }

  /**
   * Records expirations for up to `limit` wallets that have expired credits,
   * oldest expiry first, whether or not the wallet is otherwise active. Safe
   * to run concurrently and repeatedly (CreditExpirationSweepService runs it
   * periodically): every expiration is written once, under the wallet's lock.
   * A wallet that fails is counted and skipped; it is retried next time.
   * Balances never depend on it, because reads exclude expired credits.
   */
  async expireDueCredits(
    options: { limit?: number } = {},
  ): Promise<ExpireDueCreditsResult> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 1000);
    const due = await this.prisma.creditAllocation.findMany({
      where: { remaining: { gt: 0 }, expiresAt: { lte: new Date() } },
      select: { authId: true },
      distinct: ['authId'],
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
    const result: ExpireDueCreditsResult = {
      wallets: due.length,
      expirations: 0,
      failed: 0,
    };
    for (const { authId } of due) {
      try {
        result.expirations += await this.expireCredits(authId);
      } catch {
        // For example, the account was deleted meanwhile (its credits went
        // with it). Other wallets are still processed.
        result.failed += 1;
      }
    }
    return result;
  }

  /**
   * Initializes a makeup session of the user (when it is created): under
   * the wallet lock it needs free credits (the usable balance minus what the
   * user's other sessions have reserved), reserves up to one of them for
   * the session and fixes its overage limit (the settings'
   * sessionOverageCredits). Without free credits it throws
   * InsufficientCreditsError (403 "Insufficient credits") and writes
   * nothing. Initializing an initialized session only records activity.
   * Pass the transaction that creates the session, so both commit together.
   */
  async initializeSession(
    input: SessionCreditInput,
    options: WalletOperationOptions = {},
  ): Promise<SessionUseView> {
    this.assertReference('sessionId', input.sessionId);
    return this.withLockedWallet(
      input.authId,
      (tx, wallet) => this.admitSession(tx, wallet, input, false),
      options,
    );
  }

  /**
   * Checks, before an AI request of a makeup session, that the session may
   * use credits: it is initialized (a session that never was, e.g. one
   * created before credits existed, is initialized now if free credits
   * exist) and it has free credits or overage left. Otherwise throws
   * InsufficientCreditsError.
   */
  async prepareSessionUse(
    input: SessionCreditInput,
    options: WalletOperationOptions = {},
  ): Promise<SessionUseView> {
    this.assertReference('sessionId', input.sessionId);
    return this.withLockedWallet(
      input.authId,
      (tx, wallet) => this.admitSession(tx, wallet, input, true),
      options,
    );
  }

  /**
   * The credit state of a makeup session, or null if it was never
   * initialized. Read-only: the reservation of a completed or deleted
   * session is shown as released.
   */
  async getSessionCredits(
    authId: string,
    sessionId: string,
  ): Promise<SessionCreditView | null> {
    const [row, session] = await Promise.all([
      this.prisma.creditSessionOverage.findFirst({
        where: { authId, sessionId },
      }),
      this.prisma.makeupSession.findFirst({
        where: { id: sessionId, authId },
        select: { status: true },
      }),
    ]);
    if (!row) return null;
    if (!session || session.status === 'COMPLETED') {
      return this.toSessionCreditView({
        ...row,
        reservationRemaining: ZERO_CREDITS,
      });
    }
    return this.toSessionCreditView(row);
  }

  /** Whether the user already received credits for this source event. */
  async hasGrant(
    authId: string,
    source: CreditSource,
    sourceReference: string,
  ): Promise<boolean> {
    const found = await this.prisma.creditAllocation.findFirst({
      where: { authId, source, sourceReference },
      select: { id: true },
    });
    return found !== null;
  }

  /**
   * Runs `work` in a transaction holding the user's wallet lock, after
   * creating the wallet if needed and recording due expirations.
   */
  private withLockedWallet<T>(
    authId: string,
    work: (tx: Tx, wallet: LockedWallet) => Promise<T>,
    options: WalletOperationOptions = {},
  ): Promise<T> {
    this.assertReference('authId', authId);
    const run = async (tx: Tx) => {
      const owner = await tx.authUser.findUnique({
        where: { id: authId },
        select: { id: true },
      });
      if (!owner) throw new CreditOwnerNotFoundError();

      await tx.creditWallet.createMany({
        data: [{ authId }],
        skipDuplicates: true,
      });
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "CreditWallet" WHERE "authId" = ${authId} FOR UPDATE
      `;
      if (!locked) throw new CreditOwnerNotFoundError();

      const now = options.at ?? new Date();
      const expired = await this.recordDueExpirations(
        tx,
        locked.id,
        authId,
        now,
      );
      await this.releaseReservations(tx, locked.id, authId, now);
      return work(tx, { id: locked.id, authId, now, expired });
    };
    // Inside the caller's transaction the lock is held until it commits.
    return options.tx
      ? run(options.tx)
      : this.prisma.$transaction(run, WALLET_TRANSACTION_OPTIONS);
  }

  /**
   * Closes every allocation that expired at or before `now` and still holds
   * credits: one EXPIRATION transaction per allocation, effective at its
   * expiry, removing the unused rest. Runs under the wallet lock.
   */
  private async recordDueExpirations(
    tx: Tx,
    walletId: string,
    authId: string,
    now: Date,
  ): Promise<number> {
    const due = await tx.creditAllocation.findMany({
      where: { walletId, remaining: { gt: 0 }, expiresAt: { lte: now } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    });
    if (due.length === 0) return 0;

    let balance = await this.remainingCredits(tx, walletId);
    for (const allocation of due) {
      balance = balance.minus(allocation.remaining);
      await this.closeAllocation(tx, { id: walletId, authId }, allocation, {
        balanceAfter: balance,
        occurredAt: allocation.expiresAt as Date,
        description: `${allocation.source} credits expired`,
      });
    }
    return due.length;
  }

  /**
   * Removes an allocation's unused credits with an EXPIRATION transaction.
   * The idempotency key is per allocation, so an allocation is expired at
   * most once, whether at its expiry or earlier. Runs under the wallet lock.
   */
  private async closeAllocation(
    tx: Tx,
    wallet: { id: string; authId: string },
    allocation: CreditAllocation,
    expiration: {
      balanceAfter: Prisma.Decimal;
      occurredAt: Date;
      description: string;
    },
  ): Promise<void> {
    const expiredCredits = allocation.remaining;
    const { count } = await tx.creditAllocation.updateMany({
      where: { id: allocation.id, remaining: expiredCredits },
      data: { remaining: 0 },
    });
    if (count !== 1) {
      throw new Error('Credit allocation changed during a locked expiration');
    }
    await tx.creditTransaction.create({
      data: {
        walletId: wallet.id,
        authId: wallet.authId,
        type: CreditTransactionType.EXPIRATION,
        amount: expiredCredits.negated(),
        balanceAfter: expiration.balanceAfter,
        idempotencyKey: `expire:${allocation.id}`,
        description: expiration.description,
        occurredAt: expiration.occurredAt,
        entries: {
          create: [
            { allocationId: allocation.id, amount: expiredCredits.negated() },
          ],
        },
      },
    });
  }

  /**
   * The overage a debit may use for `shortfall` (what the free balance could
   * not cover), or rejects the debit. Only an initialized (ACTIVE) session
   * has an overage allowance. A `partial` debit uses whatever overage is
   * left (the rest is uncollected) and is rejected only if nothing at all
   * can be collected.
   */
  private decideSessionOverage(
    sessionId: string | null,
    sessionCredit: CreditSessionOverage | null,
    debit: {
      requested: Prisma.Decimal;
      free: Prisma.Decimal;
      shortfall: Prisma.Decimal;
      partial: boolean;
    },
  ): Prisma.Decimal {
    const remaining =
      sessionId !== null && sessionCredit
        ? overageRemaining(sessionCredit)
        : ZERO_CREDITS;
    if (debit.shortfall.lte(remaining)) return debit.shortfall;

    const collectedFromBalance = debit.requested.minus(debit.shortfall);
    if (debit.partial && (remaining.gt(0) || collectedFromBalance.gt(0))) {
      // Use the rest of the allowance; the remainder stays uncollected.
      return remaining;
    }
    throw new InsufficientCreditsError({
      requested: formatCredits(debit.requested),
      available: formatCredits(debit.free),
      overageRemaining: formatCredits(remaining),
    });
  }

  /**
   * Initializes the session if it is not (or no longer) initialized, with
   * free credits; then, if `requireCredits`, checks that it can pay for
   * something now (free credits or overage left). Records the activity.
   * Runs under the wallet lock.
   */
  private async admitSession(
    tx: Tx,
    wallet: LockedWallet,
    input: SessionCreditInput,
    requireCredits: boolean,
  ): Promise<SessionUseView> {
    const session = await tx.makeupSession.findFirst({
      where: { id: input.sessionId, authId: wallet.authId },
      select: { id: true },
    });
    if (!session) throw new CreditSessionNotFoundError();

    const existing = await tx.creditSessionOverage.findUnique({
      where: {
        walletId_sessionId: { walletId: wallet.id, sessionId: input.sessionId },
      },
    });
    const allocations = await tx.creditAllocation.findMany({
      where: {
        walletId: wallet.id,
        remaining: { gt: 0 },
        ...(input.sources ? { source: { in: input.sources } } : {}),
      },
    });
    const available = sumCredits(
      allocations
        .filter((allocation) => isAllocationAvailable(allocation, wallet.now))
        .map((allocation) => allocation.remaining),
    );
    const free = freeCredits(
      available,
      await this.reservedByOthers(tx, wallet.id, input.sessionId),
    );

    if (existing) {
      const overageLeft = overageRemaining(existing);
      if (requireCredits && free.lte(0) && overageLeft.lte(0)) {
        throw new InsufficientCreditsError({
          available: formatCredits(free),
          overageRemaining: formatCredits(overageLeft),
        });
      }
      return this.toSessionUseView(existing, free, false);
    }

    // Not initialized yet: one credit can initialize one session.
    if (free.lte(0)) {
      throw new InsufficientCreditsError({ available: formatCredits(free) });
    }
    const reserved = reservationFor(free);
    const initialized = await tx.creditSessionOverage.create({
      data: {
        walletId: wallet.id,
        authId: wallet.authId,
        sessionId: input.sessionId,
        overageLimit: new Prisma.Decimal(
          (await this.settings.getSettings(tx)).sessionOverageCredits,
        ),
        reservedCredits: reserved,
        reservationRemaining: reserved,
        initializedAt: wallet.now,
      },
    });
    return this.toSessionUseView(initialized, free, true);
  }

  /** Unused credits reserved by the wallet's sessions except `sessionId`. */
  private async reservedByOthers(
    tx: Tx,
    walletId: string,
    sessionId: string | null,
  ): Promise<Prisma.Decimal> {
    const { _sum } = await tx.creditSessionOverage.aggregate({
      where: {
        walletId,
        ...(sessionId === null ? {} : { sessionId: { not: sessionId } }),
      },
      _sum: { reservationRemaining: true },
    });
    return _sum.reservationRemaining ?? ZERO_CREDITS;
  }

  /**
   * Releases the unused reservations of sessions that were completed or
   * deleted. Unfinished sessions keep theirs, however long they are idle,
   * as far as the reserved credits still exist: once credits expired, the
   * reservations are reduced to what is left (see capReservations). Runs
   * under the wallet lock, before every change, after due expirations.
   */
  private async releaseReservations(
    tx: Tx,
    walletId: string,
    authId: string,
    now: Date,
  ): Promise<void> {
    const holding = await tx.creditSessionOverage.findMany({
      where: { walletId, reservationRemaining: { gt: 0 } },
      select: {
        id: true,
        sessionId: true,
        reservationRemaining: true,
        initializedAt: true,
      },
    });
    if (holding.length === 0) return;

    const open = new Set(
      (
        await tx.makeupSession.findMany({
          where: {
            id: { in: holding.map((row) => row.sessionId) },
            authId,
            status: { not: 'COMPLETED' },
          },
          select: { id: true },
        })
      ).map((session) => session.id),
    );
    const closed = holding.filter((row) => !open.has(row.sessionId));
    if (closed.length > 0) {
      await tx.creditSessionOverage.updateMany({
        where: { id: { in: closed.map((row) => row.id) } },
        data: { reservationRemaining: 0 },
      });
    }

    const unfinished = holding.filter((row) => open.has(row.sessionId));
    if (unfinished.length === 0) return;
    const allocations = await tx.creditAllocation.findMany({
      where: { walletId, remaining: { gt: 0 } },
      select: { remaining: true, expiresAt: true, periodStart: true },
    });
    const available = sumCredits(
      allocations
        .filter((allocation) => isAllocationAvailable(allocation, now))
        .map((allocation) => allocation.remaining),
    );
    for (const change of capReservations(unfinished, available)) {
      await tx.creditSessionOverage.update({
        where: { id: change.id },
        data: { reservationRemaining: change.reservationRemaining },
      });
    }
  }

  private async remainingCredits(
    tx: Tx,
    walletId: string,
  ): Promise<Prisma.Decimal> {
    const { _sum } = await tx.creditAllocation.aggregate({
      where: { walletId },
      _sum: { remaining: true },
    });
    return _sum.remaining ?? ZERO_CREDITS;
  }

  private async findTransaction(
    tx: Tx,
    walletId: string,
    idempotencyKey: string,
  ): Promise<TransactionWithEntries> {
    return tx.creditTransaction.findUniqueOrThrow({
      where: { walletId_idempotencyKey: { walletId, idempotencyKey } },
      include: { entries: true },
    });
  }

  private parseAmount(value: GrantCreditsInput['amount']): Prisma.Decimal {
    try {
      return parseCreditAmount(value);
    } catch (error) {
      if (error instanceof InvalidCreditAmountError) {
        throw new InvalidCreditOperationError(error.message);
      }
      throw error;
    }
  }

  private assertReference(name: string, value: string): void {
    const rejection = getReferenceRejection(name, value);
    if (rejection) throw new InvalidCreditOperationError(rejection);
  }

  private toDebitResult(
    transaction: TransactionWithEntries,
    replayed: boolean,
    requested: Prisma.Decimal,
  ): DebitCreditsResult {
    const collected = transaction.amount
      .negated()
      .plus(transaction.overageAmount);
    return {
      transaction: this.toTransactionView(transaction),
      consumed: formatCredits(transaction.amount.negated()),
      overage: formatCredits(transaction.overageAmount),
      uncollected: formatCredits(
        Prisma.Decimal.max(requested.minus(collected), ZERO_CREDITS),
      ),
      replayed,
    };
  }

  private toSessionCreditView(row: CreditSessionOverage): SessionCreditView {
    return {
      sessionId: row.sessionId,
      reservedCredits: formatCredits(row.reservedCredits),
      reservationRemaining: formatCredits(row.reservationRemaining),
      overageLimit: formatCredits(row.overageLimit),
      overageUsed: formatCredits(row.overageUsed),
      overageRemaining: formatCredits(overageRemaining(row)),
      initializedAt: row.initializedAt.toISOString(),
    };
  }

  private toSessionUseView(
    row: CreditSessionOverage,
    free: Prisma.Decimal,
    initialized: boolean,
  ): SessionUseView {
    return {
      ...this.toSessionCreditView(row),
      freeCredits: formatCredits(free),
      initialized,
    };
  }

  private toAllocationView(allocation: CreditAllocation): CreditAllocationView {
    return {
      id: allocation.id,
      source: allocation.source,
      sourceReference: allocation.sourceReference,
      amount: formatCredits(allocation.amount),
      remaining: formatCredits(allocation.remaining),
      grantedAt: allocation.grantedAt.toISOString(),
      expiresAt: allocation.expiresAt?.toISOString() ?? null,
      periodStart: allocation.periodStart?.toISOString() ?? null,
      subscriptionId: allocation.subscriptionId,
      paymentId: allocation.paymentId,
    };
  }

  private toTransactionView(
    transaction: TransactionWithEntries,
  ): CreditTransactionView {
    return {
      id: transaction.id,
      type: transaction.type,
      amount: formatCredits(transaction.amount),
      usageCostUsd:
        transaction.usageCostUsd === null
          ? null
          : formatCredits(transaction.usageCostUsd),
      creditCostUsdMicros: transaction.creditCostUsdMicros,
      overageAmount: formatCredits(transaction.overageAmount),
      balanceAfter: formatCredits(transaction.balanceAfter),
      sessionId: transaction.sessionId,
      description: transaction.description,
      occurredAt: transaction.occurredAt.toISOString(),
      entries: transaction.entries.map((entry) => ({
        allocationId: entry.allocationId,
        amount: formatCredits(entry.amount),
      })),
    };
  }
}
