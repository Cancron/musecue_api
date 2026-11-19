import type { PrismaClient } from '@prisma/client';

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
