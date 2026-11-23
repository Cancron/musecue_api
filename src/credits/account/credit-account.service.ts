import { Injectable } from '@nestjs/common';
import {
  CreditSource,
  CreditTransactionType,
  Prisma,
  type AiUsage,
  type CreditLedgerEntry,
  type CreditTransaction,
} from '@prisma/client';
import AppError from '../../common/errors/app.error';
import { PrismaService } from '../../common/services/prisma.service';
import { CreditEligibilityService } from '../../subscription/credit-eligibility.service';
import { formatCredits, sumCredits, ZERO_CREDITS } from '../credit-amount';
import { compareSpendingOrder } from '../credit-ledger.policy';
import { formatUsdMicros } from '../credit-settings.constants';
import {
  summarizeAllocation,
  summarizeSource,
  toAllocationView,
  type AllocationMovements,
} from './credit-account.policy';
import {
  SESSION_OVERAGE_SOURCE,
  type CreditAccountBalanceView,
  type CreditHistoryItemView,
  type CreditHistoryPageView,
  type CreditHistorySourceView,
  type CreditHistoryType,
} from './credit-account.interface';
import type {
  CreditHistoryFilter,
  ListCreditTransactionsDto,
} from './dto/list-credit-transactions.dto';

const DEFAULT_PAGE_SIZE = 50;

const HISTORY_TYPE: Record<CreditTransactionType, CreditHistoryType> = {
  GRANT: 'ALLOCATION',
  DEBIT: 'DEDUCTION',
  EXPIRATION: 'EXPIRATION',
};

const FILTERS: Record<CreditHistoryFilter, Prisma.CreditTransactionWhereInput> =
  {
    ALLOCATION: { type: CreditTransactionType.GRANT },
    DEDUCTION: { type: CreditTransactionType.DEBIT },
    EXPIRATION: { type: CreditTransactionType.EXPIRATION },
    OVERAGE: { type: CreditTransactionType.DEBIT, overageAmount: { gt: 0 } },
  };

type HistoryRow = CreditTransaction & {
  entries: Array<
    CreditLedgerEntry & {
      allocation: {
        source: CreditSource;
        expiresAt: Date | null;
        grantedAt: Date;
      };
    }
  >;
  aiUsage: AiUsage | null;
};

/**
 * The signed-in user's own credits (read-only): the balance by source with
 * used, expired and upcoming credits and expiry dates, and the transaction
 * history (allocations, deductions with their session overage, and
 * expirations) with the makeup session and AI request each belongs to.
 * Every query is scoped to the caller's user ID; nothing takes a user ID
 * from the request. History stays readable after credits or the
 * subscription expired, and after a session was deleted.
 */
@Injectable()
export class CreditAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: CreditEligibilityService,
  ) {}

  async getBalance(authId: string): Promise<CreditAccountBalanceView> {
    const now = new Date();
    const [allocations, debits, expirations, usableSources, reserved, overage] =
      await Promise.all([
        this.prisma.creditAllocation.findMany({
          where: { authId },
          orderBy: [{ grantedAt: 'desc' }, { id: 'asc' }],
        }),
        this.prisma.creditLedgerEntry.groupBy({
          by: ['allocationId'],
          where: {
            transaction: { authId, type: CreditTransactionType.DEBIT },
          },
          _sum: { amount: true },
        }),
        this.prisma.creditTransaction.findMany({
          where: { authId, type: CreditTransactionType.EXPIRATION },
          select: {
            occurredAt: true,
            entries: { select: { allocationId: true, amount: true } },
          },
        }),
        this.eligibility.usableSources(authId),
        this.reservedCredits(authId),
        this.prisma.creditTransaction.aggregate({
          where: { authId, type: CreditTransactionType.DEBIT },
          _sum: { overageAmount: true },
        }),
      ]);

    const movements = new Map<string, AllocationMovements>();
    const movementsOf = (allocationId: string) => {
      let found = movements.get(allocationId);
      if (!found) {
        found = { used: ZERO_CREDITS, expired: ZERO_CREDITS, expiredAt: null };
        movements.set(allocationId, found);
      }
      return found;
    };
    for (const debit of debits) {
      movementsOf(debit.allocationId).used = (
        debit._sum.amount ?? ZERO_CREDITS
      ).negated();
    }
    for (const expiration of expirations) {
      for (const entry of expiration.entries) {
        const found = movementsOf(entry.allocationId);
        found.expired = found.expired.minus(entry.amount);
        if (!found.expiredAt || expiration.occurredAt > found.expiredAt) {
          found.expiredAt = expiration.occurredAt;
        }
      }
    }

    const summaries = allocations.map((allocation) =>
      summarizeAllocation(allocation, movements.get(allocation.id), now),
    );
    const total = (pick: (s: (typeof summaries)[number]) => Prisma.Decimal) =>
      sumCredits(summaries.map(pick));
    const usable = sumCredits(
      summaries
        .filter((summary) => usableSources.includes(summary.source))
        .map((summary) => summary.available),
    );
    // Reservations only hold credits that can still be spent (they are
    // reduced once their credits expire; see CreditWalletService).
    const held = Prisma.Decimal.min(reserved, usable);

    const expiring = summaries
      .filter((summary) => summary.expiresAt && summary.available.gt(0))
      .sort(
        (a, b) =>
          (a.expiresAt as Date).getTime() - (b.expiresAt as Date).getTime(),
      );
    const nextExpiresAt = expiring[0]?.expiresAt ?? null;
    const next = nextExpiresAt
      ? expiring.filter(
          (summary) => summary.expiresAt?.getTime() === nextExpiresAt.getTime(),
        )
      : [];

    return {
      available: formatCredits(total((s) => s.available)),
      usable: formatCredits(usable),
      reserved: formatCredits(held),
      free: formatCredits(usable.minus(held)),
      upcoming: formatCredits(total((s) => s.upcoming)),
      granted: formatCredits(total((s) => s.granted)),
      used: formatCredits(total((s) => s.used)),
      expired: formatCredits(total((s) => s.expired)),
      overageUsed: formatCredits(overage._sum.overageAmount ?? ZERO_CREDITS),
      nextExpiration: nextExpiresAt
        ? {
            expiresAt: nextExpiresAt.toISOString(),
            amount: formatCredits(sumCredits(next.map((s) => s.available))),
            sources: [...new Set(next.map((s) => s.source))],
          }
        : null,
      sources: Object.values(CreditSource).map((source) =>
        summarizeSource(source, summaries, usableSources.includes(source)),
      ),
      allocations: summaries.map(toAllocationView),
      asOf: now.toISOString(),
    };
  }

  async listTransactions(
    authId: string,
    query: ListCreditTransactionsDto,
  ): Promise<CreditHistoryPageView> {
    if (query.sessionId)
      await this.assertSessionHistory(authId, query.sessionId);
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const rows: HistoryRow[] = await this.prisma.creditTransaction.findMany({
      where: {
        authId,
        ...(query.before ? { sequence: { lt: BigInt(query.before) } } : {}),
        ...(query.sessionId ? { sessionId: query.sessionId } : {}),
        ...(query.type ? FILTERS[query.type] : {}),
      },
      orderBy: { sequence: 'desc' },
      take: limit + 1,
      include: {
        entries: {
          include: {
            allocation: {
              select: { source: true, expiresAt: true, grantedAt: true },
            },
          },
          orderBy: { id: 'asc' },
        },
        aiUsage: true,
      },
    });
    const page = rows.slice(0, limit);

    const sessionIds = [
      ...new Set(
        page
          .map((row) => row.sessionId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const sessions = new Map(
      (sessionIds.length
        ? await this.prisma.makeupSession.findMany({
            where: { id: { in: sessionIds }, authId },
            select: { id: true, status: true, createdAt: true },
          })
        : []
      ).map((session) => [session.id, session]),
    );

    return {
      items: page.map((row) => {
        const session = row.sessionId ? sessions.get(row.sessionId) : null;
        return this.toHistoryItem(
          row,
          session
            ? {
                id: session.id,
                status: session.status,
                createdAt: session.createdAt.toISOString(),
              }
            : null,
        );
      }),
      nextCursor:
        rows.length > limit ? page[page.length - 1].sequence.toString() : null,
    };
  }

  /**
   * A session filter must name one of the caller's sessions, or a deleted
   * one the caller's history still refers to. Another user's session is
   * indistinguishable from a missing one (404).
   */
  private async assertSessionHistory(
    authId: string,
    sessionId: string,
  ): Promise<void> {
    const [session, history] = await Promise.all([
      this.prisma.makeupSession.findFirst({
        where: { id: sessionId, authId },
        select: { id: true },
      }),
      this.prisma.creditTransaction.findFirst({
        where: { authId, sessionId },
        select: { id: true },
      }),
    ]);
    if (!session && !history) throw AppError.notFound('Session not found');
  }

  /** Unused reservations of the caller's unfinished makeup sessions. */
  private async reservedCredits(authId: string): Promise<Prisma.Decimal> {
    const holding = await this.prisma.creditSessionOverage.findMany({
      where: { authId, reservationRemaining: { gt: 0 } },
      select: { sessionId: true, reservationRemaining: true },
    });
    if (holding.length === 0) return ZERO_CREDITS;
    const open = new Set(
      (
        await this.prisma.makeupSession.findMany({
          where: {
            id: { in: holding.map((row) => row.sessionId) },
            authId,
            status: { not: 'COMPLETED' },
          },
          select: { id: true },
        })
      ).map((session) => session.id),
    );
    return sumCredits(
      holding
        .filter((row) => open.has(row.sessionId))
        .map((row) => row.reservationRemaining),
    );
  }

  private toHistoryItem(
    row: HistoryRow,
    session: CreditHistoryItemView['session'],
  ): CreditHistoryItemView {
    // In spending order (the order the credits were taken in).
    const entries = [...row.entries].sort((a, b) =>
      compareSpendingOrder(
        { ...a.allocation, id: a.allocationId, remaining: ZERO_CREDITS },
        { ...b.allocation, id: b.allocationId, remaining: ZERO_CREDITS },
      ),
    );
    const sources: CreditHistorySourceView[] = entries.map((entry) => ({
      source: entry.allocation.source,
      amount: formatCredits(entry.amount),
      allocationId: entry.allocationId,
      expiresAt: entry.allocation.expiresAt?.toISOString() ?? null,
    }));
    if (row.overageAmount.gt(0)) {
      sources.push({
        source: SESSION_OVERAGE_SOURCE,
        amount: formatCredits(row.overageAmount.negated()),
        allocationId: null,
        expiresAt: null,
      });
    }
    const distinct = [...new Set(sources.map((item) => item.source))];
    const usage = row.aiUsage;
    const isDebit = row.type === CreditTransactionType.DEBIT;
    return {
      id: row.id,
      sequence: row.sequence.toString(),
      type: HISTORY_TYPE[row.type],
      amount: formatCredits(row.amount),
      overageAmount: formatCredits(row.overageAmount),
      creditsCharged: isDebit
        ? formatCredits(row.amount.negated().plus(row.overageAmount))
        : null,
      balanceAfter: formatCredits(row.balanceAfter),
      source:
        distinct.length === 1
          ? distinct[0]
          : distinct.length === 0
            ? null
            : 'MIXED',
      sources,
      description: row.description,
      occurredAt: row.occurredAt.toISOString(),
      sessionId: row.sessionId,
      session,
      aiUsage: usage
        ? {
            id: usage.id,
            runId: usage.runId,
            operation: usage.operation,
            model: usage.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            costUsd:
              usage.costUsd === null ? null : formatCredits(usage.costUsd),
            creditCostUsdMicros: usage.creditCostUsdMicros,
            creditCostUsd:
              usage.creditCostUsdMicros === null
                ? null
                : formatUsdMicros(usage.creditCostUsdMicros),
            creditsDue:
              usage.creditsDue === null
                ? null
                : formatCredits(usage.creditsDue),
            creditsCharged:
              usage.creditsCharged === null
                ? null
                : formatCredits(usage.creditsCharged),
          }
        : null,
    };
  }
}
