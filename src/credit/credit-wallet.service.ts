import { Injectable } from '@nestjs/common';
import {
  CreditSource,
  CreditTransactionType,
  Prisma,
  type CreditAllocation,
  type CreditTransaction,
  type CreditTransactionEntry,
} from '@prisma/client';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import {
  assertAllocationExpiry,
  type CreditAmount,
  CreditRuleViolation,
  formatCredits,
  isDueForExpiry,
  minCredits,
  parseCreditAmount,
  planDeduction,
  planOverageSettlement,
  sessionOverageRoom,
  ZERO_CREDITS,
} from './credit-ledger.policy';
import { CreditSettingsService } from './credit-settings.service';
import { CreditConflictError, InsufficientCreditsError } from './credit.errors';
import type {
  AllocateCreditsInput,
  AllocationResult,
  CreditAllocationView,
  CreditBalanceView,
  CreditTransactionView,
  DeductCreditsInput,
  DeductionResult,
  ExpirationSweepResult,
} from './interfaces/credit-wallet.interface';

type Tx = Prisma.TransactionClient;

/** The wallet's running totals while one locked transaction writes to it. */
interface LedgerCursor {
  walletId: string;
  sequence: number;
  balance: CreditAmount;
  overage: CreditAmount;
}

interface LedgerWrite {
  type: CreditTransactionType;
  amount: CreditAmount;
  overageChange?: CreditAmount;
  idempotencyKey: string;
  allocationId?: string;
  sessionId?: string;
  reference?: string;
  effectiveAt: Date;
  entries: { allocationId: string; amount: CreditAmount }[];
}

type TransactionWithEntries = CreditTransaction & {
  entries: CreditTransactionEntry[];
};

/**
 * Interactive transactions queue on the wallet row lock, so allow for
 * waiting behind other operations of the same user.
 */
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;
const MAX_KEY_LENGTH = 150;
const MAX_REFERENCE_LENGTH = 200;
const MAX_SESSION_ID_LENGTH = 64;
const SWEEP_BATCH_DEFAULT = 100;
/** Reference of EXPIRATION transactions that end trial credits at Pro activation. */
export const TRIAL_ENDED_BY_PRO_REFERENCE = 'trial-ended:pro-activated';

/**
 * The persistent credit wallet and ledger. Every balance change runs in one
 * PostgreSQL transaction that first locks the user's wallet row, so
 * concurrent operations for a user are applied one at a time, and writes an
 * append-only ledger transaction with per-allocation entries. Operations are
 * idempotent: an allocation is keyed by its source event, a deduction by its
 * idempotency key, and expirations and settlements by their allocation.
 *
 * Expired credits are never spendable: due allocations are expired (with an
 * EXPIRATION transaction) at the start of every wallet operation and by
 * `expireAllDueCredits`, and balance reads exclude them regardless.
 *
 * This is the foundation only: nothing calls it yet (trial activation,
 * subscription renewals, purchases, referrals and AI runs will).
 */
@Injectable()
export class CreditWalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CreditSettingsService,
  ) {}

  // ------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------

  /** Spendable balance at `now`; expired credits are never included. */
  async getBalance(
    authId: string,
    now: Date = new Date(),
  ): Promise<CreditBalanceView> {
    const [wallet, open] = await this.prisma.$transaction(
      [
        this.prisma.creditWallet.findUnique({ where: { authId } }),
        this.prisma.creditAllocation.findMany({
          where: {
            wallet: { authId },
            remainingCredits: { gt: 0 },
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          select: { source: true, remainingCredits: true, expiresAt: true },
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const bySource = Object.fromEntries(
      Object.values(CreditSource).map((source) => [source, ZERO_CREDITS]),
    ) as Record<CreditSource, CreditAmount>;
    let available = ZERO_CREDITS;
    let next: { expiresAt: Date; credits: CreditAmount } | null = null;
    for (const allocation of open) {
      available = available.plus(allocation.remainingCredits);
      bySource[allocation.source] = bySource[allocation.source].plus(
        allocation.remainingCredits,
      );
      const expiresAt = allocation.expiresAt;
      if (!expiresAt) continue;
      if (!next || expiresAt.getTime() < next.expiresAt.getTime()) {
        next = { expiresAt, credits: allocation.remainingCredits };
      } else if (expiresAt.getTime() === next.expiresAt.getTime()) {
        next.credits = next.credits.plus(allocation.remainingCredits);
      }
    }

    return {
      availableCredits: formatCredits(available),
      availableBySource: Object.fromEntries(
        Object.entries(bySource).map(([source, amount]) => [
          source,
          formatCredits(amount),
        ]),
      ) as Record<CreditSource, string>,
      outstandingOverageCredits: formatCredits(
        wallet?.outstandingOverageCredits ?? ZERO_CREDITS,
      ),
      nextExpiration: next
        ? {
            expiresAt: next.expiresAt.toISOString(),
            credits: formatCredits(next.credits),
          }
        : null,
    };
  }

  /** Ledger history, newest first. */
  async listTransactions(
    authId: string,
    options: { take?: number; beforeSequence?: number } = {},
  ): Promise<CreditTransactionView[]> {
    const take = Math.min(Math.max(Math.trunc(options.take ?? 50), 1), 200);
    const rows = await this.prisma.creditTransaction.findMany({
      where: {
        wallet: { authId },
        ...(options.beforeSequence !== undefined
          ? { sequence: { lt: options.beforeSequence } }
          : {}),
      },
      orderBy: { sequence: 'desc' },
      take,
      include: { entries: { orderBy: { id: 'asc' } } },
    });
    return rows.map((row) => this.transactionView(row));
  }

  /** Every allocation of the user, oldest first (including expired ones). */
  async listAllocations(authId: string): Promise<CreditAllocationView[]> {
    const rows = await this.prisma.creditAllocation.findMany({
      where: { wallet: { authId } },
      orderBy: [{ grantedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => this.allocationView(row));
  }

  // ------------------------------------------------------------------
  // Writes
  // ------------------------------------------------------------------

  /**
   * Adds credits from one source event to the user's wallet. Repeating the
   * same allocation (same user, source, reference, amount and expiry)
   * returns the existing one; reusing the source event with other terms or
   * for another user, or a second trial allocation, is refused. Outstanding
   * session overage is repaid from the new credits first.
   */
  async allocate(input: AllocateCreditsInput): Promise<AllocationResult> {
    const request = this.allocationRequest(input);
    return this.write((tx) => this.allocateLocked(tx, input.authId, request));
  }

  /**
   * `allocate` inside the caller's transaction, so the allocation commits or
   * rolls back together with the caller's writes (e.g. trial activation).
   * Takes the wallet lock for the rest of that transaction.
   */
  async allocateInTransaction(
    tx: Tx,
    input: AllocateCreditsInput,
  ): Promise<AllocationResult> {
    const request = this.allocationRequest(input);
    return this.allocateLocked(tx, input.authId, request);
  }

  /**
   * Ends the user's trial credits early, inside the caller's transaction
   * (used when a paid Pro term starts during the trial). Allocations already
   * past their expiry are expired as usual (dated at `expiresAt`); unused
   * trial credits that have not expired yet get an EXPIRATION transaction
   * dated `now` with reference `trial-ended:pro-activated`. Purchased,
   * referral and subscription credits are not touched. Idempotent: returns
   * the number of trial allocations ended early (0 when there are none).
   */
  async expireTrialCredits(
    tx: Tx,
    authId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const cursor = await this.lockExistingWallet(tx, { authId });
    if (!cursor) return 0;
    await this.expireDue(tx, cursor, now);

    const open = await tx.creditAllocation.findMany({
      where: {
        walletId: cursor.walletId,
        source: CreditSource.TRIAL,
        remainingCredits: { gt: 0 },
      },
      orderBy: [{ grantedAt: 'asc' }, { id: 'asc' }],
    });
    for (const allocation of open) {
      const lost = allocation.remainingCredits.neg();
      await this.append(tx, cursor, {
        type: CreditTransactionType.EXPIRATION,
        amount: lost,
        idempotencyKey: `expiration:${allocation.id}`,
        allocationId: allocation.id,
        reference: TRIAL_ENDED_BY_PRO_REFERENCE,
        effectiveAt: now,
        entries: [{ allocationId: allocation.id, amount: lost }],
      });
      await tx.creditAllocation.update({
        where: { id: allocation.id },
        data: { remainingCredits: ZERO_CREDITS, expiredAt: now },
      });
    }
    await this.saveWallet(tx, cursor);
    return open.length;
  }

  private allocationRequest(input: AllocateCreditsInput) {
    const now = input.now ?? new Date();
    const credits = this.rule(() => parseCreditAmount(input.credits));
    const sourceReference = this.requireText(
      input.sourceReference,
      'sourceReference',
      MAX_REFERENCE_LENGTH,
    );
    const expiresAt = input.expiresAt ?? null;
    this.rule(() => assertAllocationExpiry(input.source, expiresAt, now));
    return { source: input.source, now, credits, sourceReference, expiresAt };
  }

  private async allocateLocked(
    tx: Tx,
    authId: string,
    request: ReturnType<CreditWalletService['allocationRequest']>,
  ): Promise<AllocationResult> {
    const { source, now, credits, sourceReference, expiresAt } = request;
    const cursor = await this.openWallet(tx, authId);

    const existing = await tx.creditAllocation.findUnique({
      where: {
        source_sourceReference: { source, sourceReference },
      },
    });
    if (existing) {
      const same =
        existing.walletId === cursor.walletId &&
        existing.grantedCredits.eq(credits) &&
        (existing.expiresAt?.getTime() ?? null) ===
          (expiresAt?.getTime() ?? null);
      if (!same) {
        throw new CreditConflictError(
          'This credit source was already allocated with different terms or to another user',
        );
      }
      return { created: false, allocation: this.allocationView(existing) };
    }
    if (source === CreditSource.TRIAL) {
      const trial = await tx.creditAllocation.findFirst({
        where: { walletId: cursor.walletId, source: CreditSource.TRIAL },
        select: { id: true },
      });
      if (trial) {
        throw new CreditConflictError(
          'Trial credits were already allocated to this user',
        );
      }
    }

    await this.expireDue(tx, cursor, now);

    const allocation = await tx.creditAllocation.create({
      data: {
        walletId: cursor.walletId,
        source,
        sourceReference,
        grantedCredits: credits,
        remainingCredits: credits,
        expiresAt,
        grantedAt: now,
      },
    });
    await this.append(tx, cursor, {
      type: CreditTransactionType.ALLOCATION,
      amount: credits,
      idempotencyKey: `allocation:${allocation.id}`,
      allocationId: allocation.id,
      effectiveAt: now,
      entries: [{ allocationId: allocation.id, amount: credits }],
    });

    let remaining = credits;
    if (cursor.overage.gt(0)) {
      remaining = remaining.minus(
        await this.settleOverage(tx, cursor, allocation.id, credits, now),
      );
    }
    const stored = remaining.eq(credits)
      ? allocation
      : await tx.creditAllocation.update({
          where: { id: allocation.id },
          data: { remainingCredits: remaining },
        });

    await this.saveWallet(tx, cursor);
    return { created: true, allocation: this.allocationView(stored) };
  }

  /**
   * Uses credits, soonest-expiring first. With a `sessionId`, a shortfall may
   * be charged as that session's overage, up to the per-session allowance
   * (from the credit settings, fixed when the session first uses overage).
   * A deduction that does not fit is refused as a whole. Repeating the same
   * idempotency key returns the original transaction.
   */
  async deduct(input: DeductCreditsInput): Promise<DeductionResult> {
    const now = input.now ?? new Date();
    const credits = this.rule(() => parseCreditAmount(input.credits));
    const key = `deduction:${this.requireText(input.idempotencyKey, 'idempotencyKey', MAX_KEY_LENGTH)}`;
    const sessionId =
      input.sessionId === undefined
        ? undefined
        : this.requireText(input.sessionId, 'sessionId', MAX_SESSION_ID_LENGTH);
    const reference =
      input.reference === undefined
        ? undefined
        : this.requireText(input.reference, 'reference', MAX_REFERENCE_LENGTH);

    return this.write(async (tx) => {
      const cursor = await this.openWallet(tx, input.authId);

      const existing = await tx.creditTransaction.findUnique({
        where: {
          walletId_idempotencyKey: {
            walletId: cursor.walletId,
            idempotencyKey: key,
          },
        },
        include: { entries: { orderBy: { id: 'asc' } } },
      });
      if (existing) {
        const total = existing.overageChangeCredits.minus(
          existing.amountCredits,
        );
        if (!total.eq(credits) || existing.sessionId !== (sessionId ?? null)) {
          throw new CreditConflictError(
            'This idempotency key was already used for a different deduction',
          );
        }
        return { duplicate: true, transaction: this.transactionView(existing) };
      }

      if (sessionId !== undefined) {
        const session = await tx.makeupSession.findFirst({
          where: { id: sessionId, authId: input.authId },
          select: { id: true },
        });
        if (!session) throw AppError.notFound('Makeup session not found');
      }

      await this.expireDue(tx, cursor, now);

      const allocations = await tx.creditAllocation.findMany({
        where: {
          walletId: cursor.walletId,
          remainingCredits: { gt: 0 },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      });

      let overageRow: { id: string; overageCredits: CreditAmount } | null =
        null;
      let overageLimit = ZERO_CREDITS;
      let overageRoom = ZERO_CREDITS;
      if (sessionId !== undefined) {
        const row = await tx.creditSessionOverage.findUnique({
          where: { sessionId },
        });
        if (row && row.walletId !== cursor.walletId) {
          throw new CreditConflictError(
            'The session overage belongs to another user',
          );
        }
        overageRow = row;
        overageLimit =
          row?.limitCredits ??
          new Prisma.Decimal(
            (await this.settings.getSettings(tx))
              .sessionOverageAllowanceCredits,
          );
        overageRoom = sessionOverageRoom(
          overageLimit,
          row?.overageCredits ?? ZERO_CREDITS,
        );
      }

      const plan = planDeduction(allocations, credits, overageRoom, now);
      if (!plan.ok) {
        throw new InsufficientCreditsError({
          requestedCredits: formatCredits(credits),
          availableCredits: formatCredits(plan.available),
          overageRoomCredits: formatCredits(plan.overageRoom),
        });
      }

      const transaction = await this.append(tx, cursor, {
        type: CreditTransactionType.DEDUCTION,
        amount: plan.fromBalance.isZero()
          ? ZERO_CREDITS
          : plan.fromBalance.neg(),
        overageChange: plan.overage,
        idempotencyKey: key,
        sessionId,
        reference,
        effectiveAt: now,
        entries: plan.entries.map((entry) => ({
          allocationId: entry.allocationId,
          amount: entry.credits.neg(),
        })),
      });

      const byId = new Map(allocations.map((a) => [a.id, a]));
      for (const entry of plan.entries) {
        const allocation = byId.get(entry.allocationId) as CreditAllocation;
        await tx.creditAllocation.update({
          where: { id: entry.allocationId },
          data: {
            remainingCredits: allocation.remainingCredits.minus(entry.credits),
          },
        });
      }

      if (plan.overage.gt(0) && sessionId !== undefined) {
        if (overageRow) {
          await tx.creditSessionOverage.update({
            where: { id: overageRow.id },
            data: {
              overageCredits: overageRow.overageCredits.plus(plan.overage),
            },
          });
        } else {
          await tx.creditSessionOverage.create({
            data: {
              walletId: cursor.walletId,
              sessionId,
              limitCredits: overageLimit,
              overageCredits: plan.overage,
            },
          });
        }
      }

      await this.saveWallet(tx, cursor);
      return { duplicate: false, transaction };
    });
  }

  /**
   * Expires the user's allocations whose expiry has passed, writing one
   * EXPIRATION transaction per allocation. Returns how many were expired.
   */
  async expireDueCredits(
    authId: string,
    now: Date = new Date(),
  ): Promise<number> {
    return this.write(async (tx) => {
      const cursor = await this.lockExistingWallet(tx, { authId });
      if (!cursor) return 0;
      const expired = await this.expireDue(tx, cursor, now);
      await this.saveWallet(tx, cursor);
      return expired;
    });
  }

  /**
   * Expiry sweep across wallets (run by CreditExpirySweepService): processes
   * up to `batchSize` wallets with due allocations, oldest expiry first, each
   * in its own transaction. A wallet that fails is counted and skipped, so it
   * cannot stop the others from being expired.
   */
  async expireAllDueCredits(
    options: { now?: Date; batchSize?: number } = {},
  ): Promise<ExpirationSweepResult> {
    const now = options.now ?? new Date();
    const due = await this.prisma.creditAllocation.findMany({
      where: { expiresAt: { lte: now }, remainingCredits: { gt: 0 } },
      select: { walletId: true },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      distinct: ['walletId'],
      take: options.batchSize ?? SWEEP_BATCH_DEFAULT,
    });

    let expiredAllocations = 0;
    let failedWallets = 0;
    for (const { walletId } of due) {
      try {
        expiredAllocations += await this.write(async (tx) => {
          const cursor = await this.lockExistingWallet(tx, { id: walletId });
          if (!cursor) return 0;
          const expired = await this.expireDue(tx, cursor, now);
          await this.saveWallet(tx, cursor);
          return expired;
        });
      } catch {
        failedWallets += 1;
      }
    }
    return { wallets: due.length, expiredAllocations, failedWallets };
  }

  // ------------------------------------------------------------------
  // Ledger internals (always inside a transaction holding the wallet lock)
  // ------------------------------------------------------------------

  /** Creates the wallet if needed and locks it for this transaction. */
  private async openWallet(tx: Tx, authId: string): Promise<LedgerCursor> {
    const user = await tx.authUser.findUnique({
      where: { id: authId },
      select: { id: true },
    });
    if (!user) throw AppError.notFound('User not found');
    // INSERT ... ON CONFLICT DO NOTHING: concurrent first operations create
    // exactly one wallet.
    await tx.creditWallet.createMany({
      data: [{ authId }],
      skipDuplicates: true,
    });
    return (await this.lockExistingWallet(tx, { authId })) as LedgerCursor;
  }

  /** Locks an existing wallet (SELECT ... FOR UPDATE); null if none. */
  private async lockExistingWallet(
    tx: Tx,
    where: { authId: string } | { id: string },
  ): Promise<LedgerCursor | null> {
    const locked =
      'authId' in where
        ? await tx.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "CreditWallet" WHERE "authId" = ${where.authId} FOR UPDATE`
        : await tx.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "CreditWallet" WHERE "id" = ${where.id} FOR UPDATE`;
    if (locked.length === 0) return null;

    const walletId = locked[0].id;
    const wallet = await tx.creditWallet.findUniqueOrThrow({
      where: { id: walletId },
    });
    const last = await tx.creditTransaction.findFirst({
      where: { walletId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    return {
      walletId,
      sequence: last?.sequence ?? 0,
      balance: wallet.balanceCredits,
      overage: wallet.outstandingOverageCredits,
    };
  }

  /** Expires every due allocation of the locked wallet. */
  private async expireDue(
    tx: Tx,
    cursor: LedgerCursor,
    now: Date,
  ): Promise<number> {
    const due = await tx.creditAllocation.findMany({
      where: {
        walletId: cursor.walletId,
        remainingCredits: { gt: 0 },
        expiresAt: { lte: now },
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    });
    let expired = 0;
    for (const allocation of due) {
      if (!isDueForExpiry(allocation, now) || !allocation.expiresAt) continue;
      const lost = allocation.remainingCredits.neg();
      await this.append(tx, cursor, {
        type: CreditTransactionType.EXPIRATION,
        amount: lost,
        idempotencyKey: `expiration:${allocation.id}`,
        allocationId: allocation.id,
        effectiveAt: allocation.expiresAt,
        entries: [{ allocationId: allocation.id, amount: lost }],
      });
      await tx.creditAllocation.update({
        where: { id: allocation.id },
        data: { remainingCredits: ZERO_CREDITS, expiredAt: now },
      });
      expired += 1;
    }
    return expired;
  }

  /**
   * Repays outstanding overage from a new allocation, oldest session first.
   * Returns the credits used.
   */
  private async settleOverage(
    tx: Tx,
    cursor: LedgerCursor,
    allocationId: string,
    granted: CreditAmount,
    now: Date,
  ): Promise<CreditAmount> {
    const sessions = (
      await tx.creditSessionOverage.findMany({
        where: { walletId: cursor.walletId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    )
      .map((row) => ({
        row,
        unsettled: row.overageCredits.minus(row.settledCredits),
      }))
      .filter(({ unsettled }) => unsettled.gt(0));

    const plan = planOverageSettlement(
      minCredits(granted, cursor.overage),
      sessions.map(({ row, unsettled }) => ({ id: row.id, unsettled })),
    );
    if (plan.settled.lte(0)) return ZERO_CREDITS;

    await this.append(tx, cursor, {
      type: CreditTransactionType.OVERAGE_SETTLEMENT,
      amount: plan.settled.neg(),
      overageChange: plan.settled.neg(),
      idempotencyKey: `overage-settlement:${allocationId}`,
      allocationId,
      effectiveAt: now,
      entries: [{ allocationId, amount: plan.settled.neg() }],
    });
    const rows = new Map(sessions.map(({ row }) => [row.id, row]));
    for (const repayment of plan.bySession) {
      const row = rows.get(repayment.id);
      if (!row) continue;
      await tx.creditSessionOverage.update({
        where: { id: row.id },
        data: { settledCredits: row.settledCredits.plus(repayment.credits) },
      });
    }
    return plan.settled;
  }

  /** Appends one ledger transaction with its entries and advances the cursor. */
  private async append(
    tx: Tx,
    cursor: LedgerCursor,
    write: LedgerWrite,
  ): Promise<CreditTransactionView> {
    const overageChange = write.overageChange ?? ZERO_CREDITS;
    cursor.sequence += 1;
    cursor.balance = cursor.balance.plus(write.amount);
    cursor.overage = cursor.overage.plus(overageChange);

    const transaction = await tx.creditTransaction.create({
      data: {
        walletId: cursor.walletId,
        sequence: cursor.sequence,
        type: write.type,
        amountCredits: write.amount,
        overageChangeCredits: overageChange,
        balanceAfterCredits: cursor.balance,
        outstandingOverageAfterCredits: cursor.overage,
        idempotencyKey: write.idempotencyKey,
        allocationId: write.allocationId ?? null,
        sessionId: write.sessionId ?? null,
        reference: write.reference ?? null,
        effectiveAt: write.effectiveAt,
      },
    });
    const entries = write.entries.filter((entry) => !entry.amount.isZero());
    if (entries.length > 0) {
      await tx.creditTransactionEntry.createMany({
        data: entries.map((entry) => ({
          transactionId: transaction.id,
          walletId: cursor.walletId,
          allocationId: entry.allocationId,
          amountCredits: entry.amount,
        })),
      });
    }
    return this.transactionView({
      ...transaction,
      entries: entries.map((entry, index) => ({
        id: String(index),
        transactionId: transaction.id,
        walletId: cursor.walletId,
        allocationId: entry.allocationId,
        amountCredits: entry.amount,
      })),
    });
  }

  private async saveWallet(tx: Tx, cursor: LedgerCursor): Promise<void> {
    await tx.creditWallet.update({
      where: { id: cursor.walletId },
      data: {
        balanceCredits: cursor.balance,
        outstandingOverageCredits: cursor.overage,
      },
    });
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private async write<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(work, TX_OPTIONS);
    } catch (error) {
      // With the wallet lock, a unique violation means another user already
      // holds the same source event (or an equivalent concurrent write).
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new CreditConflictError(
          'A conflicting credit operation was already recorded',
        );
      }
      throw error;
    }
  }

  private rule<T>(check: () => T): T {
    try {
      return check();
    } catch (error) {
      if (error instanceof CreditRuleViolation) {
        throw AppError.badRequest(error.message);
      }
      throw error;
    }
  }

  private requireText(value: unknown, field: string, max: number): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw AppError.badRequest(`${field} is required`);
    }
    const text = value.trim();
    if (text.length > max) {
      throw AppError.badRequest(`${field} must be at most ${max} characters`);
    }
    return text;
  }

  private allocationView(row: CreditAllocation): CreditAllocationView {
    return {
      id: row.id,
      source: row.source,
      sourceReference: row.sourceReference,
      grantedCredits: formatCredits(row.grantedCredits),
      remainingCredits: formatCredits(row.remainingCredits),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      expiredAt: row.expiredAt?.toISOString() ?? null,
      grantedAt: row.grantedAt.toISOString(),
    };
  }

  private transactionView(row: TransactionWithEntries): CreditTransactionView {
    return {
      id: row.id,
      sequence: row.sequence,
      type: row.type,
      amountCredits: formatCredits(row.amountCredits),
      overageChangeCredits: formatCredits(row.overageChangeCredits),
      balanceAfterCredits: formatCredits(row.balanceAfterCredits),
      outstandingOverageAfterCredits: formatCredits(
        row.outstandingOverageAfterCredits,
      ),
      allocationId: row.allocationId,
      sessionId: row.sessionId,
      reference: row.reference,
      effectiveAt: row.effectiveAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      entries: row.entries.map((entry) => ({
        allocationId: entry.allocationId,
        amountCredits: formatCredits(entry.amountCredits),
      })),
    };
  }
}
