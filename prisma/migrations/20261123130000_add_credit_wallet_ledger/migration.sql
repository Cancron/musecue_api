-- AI credit wallet and ledger foundation (see prisma/schema/credit.prisma).
--
-- Guarantees enforced here, beyond the Prisma schema:
--   * ownership: every allocation, transaction, entry and session overage is
--     keyed by (walletId, authId) or (walletId, ...) so it can only belong to
--     the wallet of the same user, and entries can only link a transaction
--     and an allocation of the same wallet;
--   * sources: TRIAL and SUBSCRIPTION allocations must expire (after they
--     were granted); PURCHASE and REFERRAL allocations never expire; at most
--     one TRIAL allocation per wallet;
--   * amounts: NUMERIC(18, 6), positive grants, 0 <= remaining <= amount,
--     never a negative balance, overage never above the session's limit;
--   * history: transactions and entries are append-only; allocations only
--     lose credits and never change what, when or from where they were
--     granted; nothing can be deleted while its owner exists (deleting the
--     user still cascades);
--   * consistency (checked at commit): an allocation's remaining credits equal
--     the sum of its entries, a transaction's amount equals the sum of its
--     entries, each transaction's balanceAfter continues the wallet's previous
--     balance, and the latest balanceAfter equals the wallet's remaining
--     credits.
-- Triggers address tables through TG_TABLE_SCHEMA, so they work in any schema.

-- CreateEnum
CREATE TYPE "CreditSource" AS ENUM ('TRIAL', 'SUBSCRIPTION', 'PURCHASE', 'REFERRAL');

-- CreateEnum
CREATE TYPE "CreditTransactionType" AS ENUM ('GRANT', 'DEBIT', 'EXPIRATION');

-- CreateTable
CREATE TABLE "CreditWallet" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditAllocation" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "source" "CreditSource" NOT NULL,
    "sourceReference" VARCHAR(255) NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,
    "remaining" DECIMAL(18,6) NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditTransaction" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "walletId" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "type" "CreditTransactionType" NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,
    "overageAmount" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "balanceAfter" DECIMAL(18,6) NOT NULL,
    "idempotencyKey" VARCHAR(255) NOT NULL,
    "sessionId" VARCHAR(64),
    "description" VARCHAR(255),
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedgerEntry" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "allocationId" TEXT NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditSessionOverage" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "sessionId" VARCHAR(64) NOT NULL,
    "overageLimit" DECIMAL(18,6) NOT NULL,
    "overageUsed" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditSessionOverage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditWallet_authId_key" ON "CreditWallet"("authId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditWallet_id_authId_key" ON "CreditWallet"("id", "authId");

-- CreateIndex
CREATE INDEX "CreditAllocation_walletId_expiresAt_idx" ON "CreditAllocation"("walletId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditAllocation_walletId_source_sourceReference_key" ON "CreditAllocation"("walletId", "source", "sourceReference");

-- CreateIndex
CREATE UNIQUE INDEX "CreditAllocation_walletId_id_key" ON "CreditAllocation"("walletId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CreditTransaction_sequence_key" ON "CreditTransaction"("sequence");

-- CreateIndex
CREATE INDEX "CreditTransaction_walletId_sequence_idx" ON "CreditTransaction"("walletId", "sequence");

-- CreateIndex
CREATE INDEX "CreditTransaction_sessionId_idx" ON "CreditTransaction"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditTransaction_walletId_idempotencyKey_key" ON "CreditTransaction"("walletId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "CreditTransaction_walletId_id_key" ON "CreditTransaction"("walletId", "id");

-- CreateIndex
CREATE INDEX "CreditLedgerEntry_walletId_allocationId_idx" ON "CreditLedgerEntry"("walletId", "allocationId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedgerEntry_transactionId_allocationId_key" ON "CreditLedgerEntry"("transactionId", "allocationId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditSessionOverage_walletId_sessionId_key" ON "CreditSessionOverage"("walletId", "sessionId");

-- AddForeignKey
ALTER TABLE "CreditWallet" ADD CONSTRAINT "CreditWallet_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditAllocation" ADD CONSTRAINT "CreditAllocation_walletId_authId_fkey" FOREIGN KEY ("walletId", "authId") REFERENCES "CreditWallet"("id", "authId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_walletId_authId_fkey" FOREIGN KEY ("walletId", "authId") REFERENCES "CreditWallet"("id", "authId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_walletId_transactionId_fkey" FOREIGN KEY ("walletId", "transactionId") REFERENCES "CreditTransaction"("walletId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_walletId_allocationId_fkey" FOREIGN KEY ("walletId", "allocationId") REFERENCES "CreditAllocation"("walletId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditSessionOverage" ADD CONSTRAINT "CreditSessionOverage_walletId_authId_fkey" FOREIGN KEY ("walletId", "authId") REFERENCES "CreditWallet"("id", "authId") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- CHECK constraints
-- ---------------------------------------------------------------------------

ALTER TABLE "CreditAllocation"
  ADD CONSTRAINT "CreditAllocation_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "CreditAllocation_remaining_range" CHECK ("remaining" >= 0 AND "remaining" <= "amount"),
  ADD CONSTRAINT "CreditAllocation_sourceReference_present" CHECK (btrim("sourceReference") <> ''),
  ADD CONSTRAINT "CreditAllocation_expiry_by_source" CHECK (
    ("source" IN ('TRIAL', 'SUBSCRIPTION') AND "expiresAt" IS NOT NULL AND "expiresAt" > "grantedAt")
    OR ("source" IN ('PURCHASE', 'REFERRAL') AND "expiresAt" IS NULL)
  );

-- A user can receive trial credits only once.
CREATE UNIQUE INDEX "CreditAllocation_one_trial_per_wallet"
  ON "CreditAllocation" ("walletId") WHERE "source" = 'TRIAL';

-- Finds allocations whose expiration still has to be recorded.
CREATE INDEX "CreditAllocation_due_expiration_idx"
  ON "CreditAllocation" ("expiresAt") WHERE "remaining" > 0 AND "expiresAt" IS NOT NULL;

ALTER TABLE "CreditTransaction"
  ADD CONSTRAINT "CreditTransaction_amount_by_type" CHECK (
    ("type" = 'GRANT' AND "amount" > 0 AND "overageAmount" = 0)
    OR ("type" = 'DEBIT' AND "amount" <= 0 AND "overageAmount" >= 0 AND ("amount" < 0 OR "overageAmount" > 0))
    OR ("type" = 'EXPIRATION' AND "amount" < 0 AND "overageAmount" = 0)
  ),
  ADD CONSTRAINT "CreditTransaction_session_only_on_debit" CHECK ("sessionId" IS NULL OR "type" = 'DEBIT'),
  ADD CONSTRAINT "CreditTransaction_overage_needs_session" CHECK ("overageAmount" = 0 OR "sessionId" IS NOT NULL),
  ADD CONSTRAINT "CreditTransaction_balanceAfter_non_negative" CHECK ("balanceAfter" >= 0),
  ADD CONSTRAINT "CreditTransaction_idempotencyKey_present" CHECK (btrim("idempotencyKey") <> '');

ALTER TABLE "CreditLedgerEntry"
  ADD CONSTRAINT "CreditLedgerEntry_amount_non_zero" CHECK ("amount" <> 0);

ALTER TABLE "CreditSessionOverage"
  ADD CONSTRAINT "CreditSessionOverage_range" CHECK (
    "overageLimit" >= 0 AND "overageUsed" >= 0 AND "overageUsed" <= "overageLimit"
  ),
  ADD CONSTRAINT "CreditSessionOverage_sessionId_present" CHECK (btrim("sessionId") <> '');

-- ---------------------------------------------------------------------------
-- Deletion: only together with the owner (ON DELETE CASCADE from authUser).
-- During the cascade the parent row is already gone.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "CreditWallet_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_exists boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I."authUser" WHERE "id" = $1)',
      TG_TABLE_SCHEMA
    ) INTO owner_exists USING OLD."authId";
    IF owner_exists THEN
      RAISE EXCEPTION 'CreditWallet cannot be deleted while its user exists'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."authId" IS DISTINCT FROM OLD."authId" THEN
    RAISE EXCEPTION 'CreditWallet owner cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditWallet_protect"
  BEFORE UPDATE OR DELETE ON "CreditWallet"
  FOR EACH ROW EXECUTE FUNCTION "CreditWallet_protect"();

-- Shared by the wallet's child tables: refuses a delete while the wallet exists.
CREATE FUNCTION "Credit_wallet_child_delete_guard"(p_schema text, p_wallet_id text, p_table text)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  wallet_exists boolean;
BEGIN
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I."CreditWallet" WHERE "id" = $1)',
    p_schema
  ) INTO wallet_exists USING p_wallet_id;
  IF wallet_exists THEN
    RAISE EXCEPTION '% history cannot be deleted while its wallet exists', p_table
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- Transactions and entries: append-only.
CREATE FUNCTION "Credit_ledger_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "Credit_wallet_child_delete_guard"(TG_TABLE_SCHEMA, OLD."walletId", TG_TABLE_NAME);
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "CreditTransaction_append_only"
  BEFORE UPDATE OR DELETE ON "CreditTransaction"
  FOR EACH ROW EXECUTE FUNCTION "Credit_ledger_append_only"();

CREATE TRIGGER "CreditLedgerEntry_append_only"
  BEFORE UPDATE OR DELETE ON "CreditLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION "Credit_ledger_append_only"();

-- Allocations: only `remaining` (downwards) and `updatedAt` may change.
CREATE FUNCTION "CreditAllocation_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "Credit_wallet_child_delete_guard"(TG_TABLE_SCHEMA, OLD."walletId", TG_TABLE_NAME);
    RETURN OLD;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."walletId" IS DISTINCT FROM OLD."walletId"
    OR NEW."authId" IS DISTINCT FROM OLD."authId"
    OR NEW."source" IS DISTINCT FROM OLD."source"
    OR NEW."sourceReference" IS DISTINCT FROM OLD."sourceReference"
    OR NEW."amount" IS DISTINCT FROM OLD."amount"
    OR NEW."grantedAt" IS DISTINCT FROM OLD."grantedAt"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'CreditAllocation grant details cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."remaining" > OLD."remaining" THEN
    RAISE EXCEPTION 'CreditAllocation remaining credits can only decrease'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditAllocation_protect"
  BEFORE UPDATE OR DELETE ON "CreditAllocation"
  FOR EACH ROW EXECUTE FUNCTION "CreditAllocation_protect"();

-- Session overage: the limit is fixed and usage only grows.
CREATE FUNCTION "CreditSessionOverage_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "Credit_wallet_child_delete_guard"(TG_TABLE_SCHEMA, OLD."walletId", TG_TABLE_NAME);
    RETURN OLD;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."walletId" IS DISTINCT FROM OLD."walletId"
    OR NEW."authId" IS DISTINCT FROM OLD."authId"
    OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
    OR NEW."overageLimit" IS DISTINCT FROM OLD."overageLimit"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'CreditSessionOverage session and limit cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."overageUsed" < OLD."overageUsed" THEN
    RAISE EXCEPTION 'CreditSessionOverage usage can only grow'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditSessionOverage_protect"
  BEFORE UPDATE OR DELETE ON "CreditSessionOverage"
  FOR EACH ROW EXECUTE FUNCTION "CreditSessionOverage_protect"();

-- ---------------------------------------------------------------------------
-- Ledger consistency
-- ---------------------------------------------------------------------------

-- Immediate: an entry's sign matches its transaction (GRANT adds, DEBIT and
-- EXPIRATION remove credits).
CREATE FUNCTION "CreditLedgerEntry_sign_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tx_type text;
BEGIN
  EXECUTE format(
    'SELECT "type"::text FROM %I."CreditTransaction" WHERE "id" = $1',
    TG_TABLE_SCHEMA
  ) INTO tx_type USING NEW."transactionId";
  IF (tx_type = 'GRANT') <> (NEW."amount" > 0) THEN
    RAISE EXCEPTION 'CreditLedgerEntry amount % does not match a % transaction', NEW."amount", tx_type
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditLedgerEntry_sign_check"
  BEFORE INSERT ON "CreditLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION "CreditLedgerEntry_sign_check"();

-- Immediate: balanceAfter continues the wallet's previous balance. Writers
-- lock the wallet, so transactions of one wallet are inserted one at a time.
CREATE FUNCTION "CreditTransaction_balance_chain_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous_balance numeric;
BEGIN
  EXECUTE format(
    'SELECT "balanceAfter" FROM %I."CreditTransaction" WHERE "walletId" = $1 ORDER BY "sequence" DESC LIMIT 1',
    TG_TABLE_SCHEMA
  ) INTO previous_balance USING NEW."walletId";
  IF NEW."balanceAfter" <> COALESCE(previous_balance, 0) + NEW."amount" THEN
    RAISE EXCEPTION 'CreditTransaction balanceAfter % does not continue the previous balance % with amount %',
      NEW."balanceAfter", COALESCE(previous_balance, 0), NEW."amount"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditTransaction_balance_chain_check"
  BEFORE INSERT ON "CreditTransaction"
  FOR EACH ROW EXECUTE FUNCTION "CreditTransaction_balance_chain_check"();

-- Deferred to commit, so a transaction, its entries and the allocation
-- updates can be written in any order within one database transaction.
CREATE FUNCTION "CreditAllocation_consistency_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allocation_id text;
  current_remaining numeric;
  entry_total numeric;
BEGIN
  -- IF, not CASE: PL/pgSQL resolves every field a CASE expression names,
  -- and each table has only one of these columns.
  IF TG_TABLE_NAME = 'CreditLedgerEntry' THEN
    allocation_id := NEW."allocationId";
  ELSE
    allocation_id := NEW."id";
  END IF;
  EXECUTE format('SELECT "remaining" FROM %I."CreditAllocation" WHERE "id" = $1', TG_TABLE_SCHEMA)
    INTO current_remaining USING allocation_id;
  IF current_remaining IS NULL THEN
    RETURN NULL; -- deleted with its wallet
  END IF;
  EXECUTE format('SELECT COALESCE(SUM("amount"), 0) FROM %I."CreditLedgerEntry" WHERE "allocationId" = $1', TG_TABLE_SCHEMA)
    INTO entry_total USING allocation_id;
  IF current_remaining <> entry_total THEN
    RAISE EXCEPTION 'CreditAllocation % remaining % does not match its ledger entries %',
      allocation_id, current_remaining, entry_total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "CreditAllocation_consistency_check"
  AFTER INSERT OR UPDATE ON "CreditAllocation"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "CreditAllocation_consistency_check"();

CREATE CONSTRAINT TRIGGER "CreditLedgerEntry_allocation_consistency_check"
  AFTER INSERT ON "CreditLedgerEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "CreditAllocation_consistency_check"();

CREATE FUNCTION "CreditTransaction_consistency_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  transaction_id text;
  wallet_id text;
  tx_amount numeric;
  tx_balance_after numeric;
  entry_total numeric;
  latest_id text;
  wallet_remaining numeric;
BEGIN
  IF TG_TABLE_NAME = 'CreditLedgerEntry' THEN
    transaction_id := NEW."transactionId";
  ELSE
    transaction_id := NEW."id";
  END IF;
  EXECUTE format('SELECT "walletId", "amount", "balanceAfter" FROM %I."CreditTransaction" WHERE "id" = $1', TG_TABLE_SCHEMA)
    INTO wallet_id, tx_amount, tx_balance_after USING transaction_id;
  IF wallet_id IS NULL THEN
    RETURN NULL; -- deleted with its wallet
  END IF;

  EXECUTE format('SELECT COALESCE(SUM("amount"), 0) FROM %I."CreditLedgerEntry" WHERE "transactionId" = $1', TG_TABLE_SCHEMA)
    INTO entry_total USING transaction_id;
  IF tx_amount <> entry_total THEN
    RAISE EXCEPTION 'CreditTransaction % amount % does not match its ledger entries %',
      transaction_id, tx_amount, entry_total
      USING ERRCODE = 'check_violation';
  END IF;

  -- The wallet's latest balance is what its allocations still hold.
  EXECUTE format('SELECT "id" FROM %I."CreditTransaction" WHERE "walletId" = $1 ORDER BY "sequence" DESC LIMIT 1', TG_TABLE_SCHEMA)
    INTO latest_id USING wallet_id;
  IF latest_id = transaction_id THEN
    EXECUTE format('SELECT COALESCE(SUM("remaining"), 0) FROM %I."CreditAllocation" WHERE "walletId" = $1', TG_TABLE_SCHEMA)
      INTO wallet_remaining USING wallet_id;
    IF tx_balance_after <> wallet_remaining THEN
      RAISE EXCEPTION 'CreditTransaction % balanceAfter % does not match the wallet''s remaining credits %',
        transaction_id, tx_balance_after, wallet_remaining
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "CreditTransaction_consistency_check"
  AFTER INSERT ON "CreditTransaction"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "CreditTransaction_consistency_check"();

CREATE CONSTRAINT TRIGGER "CreditLedgerEntry_transaction_consistency_check"
  AFTER INSERT ON "CreditLedgerEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "CreditTransaction_consistency_check"();
