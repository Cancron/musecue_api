import { BillingInterval, Prisma, type PrismaClient } from '@prisma/client';
import type { PaidPeriod } from '../../src/credits/interfaces/credit-wallet.interface';
import { givenProPurchased } from './subscription-fixtures';

/**
 * Purchased and referral credits are not issued by the application yet; they
 * are set up directly in PostgreSQL. This runs the SQL documented in the
 * README ("AI credit wallet and ledger"), so the documented statement is what
 * the tests exercise. It locks the wallet like the application does and
 * writes the allocation, its GRANT transaction and ledger entry together, so
 * the database's ledger checks accept it.
 */
export function manualCreditGrantSql(grant: {
  authId: string;
  source: 'PURCHASE' | 'REFERRAL';
  sourceReference: string;
  amount: string;
}): string {
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  if (!/^\d+(\.\d{1,6})?$/.test(grant.amount)) {
    throw new Error(`Invalid amount ${grant.amount}`);
  }
  return `
DO $$
DECLARE
  v_auth_id     text := ${literal(grant.authId)};
  v_source      "CreditSource" := ${literal(grant.source)};  -- 'PURCHASE' or 'REFERRAL'
  v_reference   text := ${literal(grant.sourceReference)};  -- unique per user and source
  v_amount      numeric(18, 6) := ${grant.amount};
  v_wallet      text;
  v_allocation  text := gen_random_uuid()::text;
  v_transaction text := gen_random_uuid()::text;
  v_balance     numeric(18, 6);
BEGIN
  INSERT INTO "CreditWallet" ("id", "authId")
  VALUES (gen_random_uuid()::text, v_auth_id)
  ON CONFLICT ("authId") DO NOTHING;
  SELECT "id" INTO v_wallet FROM "CreditWallet" WHERE "authId" = v_auth_id FOR UPDATE;
  SELECT COALESCE((SELECT "balanceAfter" FROM "CreditTransaction"
                   WHERE "walletId" = v_wallet ORDER BY "sequence" DESC LIMIT 1), 0)
    INTO v_balance;

  INSERT INTO "CreditAllocation" ("id", "walletId", "authId", "source", "sourceReference",
                                  "amount", "remaining", "grantedAt", "expiresAt", "updatedAt")
  VALUES (v_allocation, v_wallet, v_auth_id, v_source, v_reference,
          v_amount, v_amount, now(), NULL, now());
  INSERT INTO "CreditTransaction" ("id", "walletId", "authId", "type", "amount", "balanceAfter",
                                   "idempotencyKey", "description", "occurredAt")
  VALUES (v_transaction, v_wallet, v_auth_id, 'GRANT', v_amount, v_balance + v_amount,
          'grant:' || v_source || ':' || v_reference, 'Set up in PostgreSQL', now());
  INSERT INTO "CreditLedgerEntry" ("id", "walletId", "transactionId", "allocationId", "amount")
  VALUES (gen_random_uuid()::text, v_wallet, v_transaction, v_allocation, v_amount);
END $$;`;
}

/** Gives a user purchased or referral credits directly in PostgreSQL. */
export async function givenCreditsInPostgres(
  client: PrismaClient,
  authId: string,
  source: 'PURCHASE' | 'REFERRAL',
  amount: string,
  sourceReference = `manual-${source.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
): Promise<void> {
  await client.$executeRawUnsafe(
    manualCreditGrantSql({ authId, source, sourceReference, amount }),
  );
}

/**
 * Re-checks a user's ledger from the stored rows: entries add up to each
 * allocation's remaining credits and each transaction's amount, and every
 * balanceAfter continues the previous one, ending at what the allocations
 * hold. Returns the rows for further assertions.
 */
export async function expectConsistentLedger(
  client: PrismaClient,
  authId: string,
) {
  const allocations = await client.creditAllocation.findMany({
    where: { authId },
    include: { entries: true },
  });
  for (const allocation of allocations) {
    const total = allocation.entries.reduce(
      (sum, entry) => sum.plus(entry.amount),
      new Prisma.Decimal(0),
    );
    expect(allocation.remaining.toFixed()).toBe(total.toFixed());
  }
  const transactions = await client.creditTransaction.findMany({
    where: { authId },
    orderBy: { sequence: 'asc' },
    include: { entries: true },
  });
  let balance = new Prisma.Decimal(0);
  for (const transaction of transactions) {
    balance = balance.plus(transaction.amount);
    expect(transaction.balanceAfter.toFixed()).toBe(balance.toFixed());
  }
  const remaining = allocations.reduce(
    (sum, allocation) => sum.plus(allocation.remaining),
    new Prisma.Decimal(0),
  );
  expect(balance.toFixed()).toBe(remaining.toFixed());
  return { allocations, transactions };
}

/**
 * A successful Pro payment for `authId` covering [periodStart, one billing
 * interval later), recorded as the repository's payment fixtures do (a
 * SUCCEEDED PaymentTransaction and its CREATED event), so that SUBSCRIPTION
 * credits can be granted for it. Returns the wallet's `paidPeriod`.
 */
export async function givenPaidPeriod(
  client: PrismaClient,
  authId: string,
  periodStart: Date,
  billingInterval: BillingInterval = BillingInterval.MONTHLY,
): Promise<PaidPeriod> {
  await client.userSubscription.upsert({
    where: { authId },
    create: { authId },
    update: {},
  });
  const subscription = await givenProPurchased(client, authId, {
    billingInterval,
    startedAt: periodStart,
  });
  const payment = await client.paymentTransaction.findFirstOrThrow({
    where: { subscriptionId: subscription.id, periodStart },
  });
  return {
    subscriptionId: subscription.id,
    paymentId: payment.id,
    periodStart: payment.periodStart,
    periodEnd: payment.periodEnd,
  };
}
