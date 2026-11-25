-- AI credit wallet and ledger: per-user wallets, credit allocations from a
-- source (trial, subscription, purchase, referral), an append-only ledger of
-- additions, deductions, expirations and overage settlements with per-
-- allocation entries, and per-session overage. Amounts are NUMERIC(20,6).
--
-- Besides the tables generated from prisma/schema/credit.prisma, this
-- migration adds database rules Prisma does not model (CHECK constraints,
-- partial unique indexes and triggers), so that no write path can duplicate
-- an allocation, rewrite history or leave balances inconsistent.

-- CreateEnum
CREATE TYPE "CreditSource" AS ENUM ('TRIAL', 'SUBSCRIPTION', 'PURCHASE', 'REFERRAL');

-- CreateEnum
CREATE TYPE "CreditTransactionType" AS ENUM ('ALLOCATION', 'DEDUCTION', 'EXPIRATION', 'OVERAGE_SETTLEMENT');

-- CreateTable
CREATE TABLE "CreditWallet" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "balanceCredits" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "outstandingOverageCredits" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditAllocation" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "source" "CreditSource" NOT NULL,
    "sourceReference" VARCHAR(200) NOT NULL,
    "grantedCredits" DECIMAL(20,6) NOT NULL,
    "remainingCredits" DECIMAL(20,6) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditTransaction" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" "CreditTransactionType" NOT NULL,
    "amountCredits" DECIMAL(20,6) NOT NULL,
    "overageChangeCredits" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "balanceAfterCredits" DECIMAL(20,6) NOT NULL,
    "outstandingOverageAfterCredits" DECIMAL(20,6) NOT NULL,
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "allocationId" TEXT,
    "sessionId" VARCHAR(64),
    "reference" VARCHAR(200),
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditTransactionEntry" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "allocationId" TEXT NOT NULL,
    "amountCredits" DECIMAL(20,6) NOT NULL,

    CONSTRAINT "CreditTransactionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditSessionOverage" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "sessionId" VARCHAR(64) NOT NULL,
    "limitCredits" DECIMAL(20,6) NOT NULL,
    "overageCredits" DECIMAL(20,6) NOT NULL,
    "settledCredits" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditSessionOverage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditWallet_authId_key" ON "CreditWallet"("authId");

-- CreateIndex
CREATE INDEX "CreditAllocation_walletId_expiresAt_idx" ON "CreditAllocation"("walletId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditAllocation_source_sourceReference_key" ON "CreditAllocation"("source", "sourceReference");

-- CreateIndex
CREATE UNIQUE INDEX "CreditAllocation_id_walletId_key" ON "CreditAllocation"("id", "walletId");

-- CreateIndex
CREATE INDEX "CreditTransaction_allocationId_idx" ON "CreditTransaction"("allocationId");

-- CreateIndex
CREATE INDEX "CreditTransaction_sessionId_idx" ON "CreditTransaction"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditTransaction_walletId_sequence_key" ON "CreditTransaction"("walletId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "CreditTransaction_walletId_idempotencyKey_key" ON "CreditTransaction"("walletId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "CreditTransaction_id_walletId_key" ON "CreditTransaction"("id", "walletId");

-- CreateIndex
CREATE INDEX "CreditTransactionEntry_allocationId_idx" ON "CreditTransactionEntry"("allocationId");

-- CreateIndex
CREATE INDEX "CreditTransactionEntry_walletId_idx" ON "CreditTransactionEntry"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditTransactionEntry_transactionId_allocationId_key" ON "CreditTransactionEntry"("transactionId", "allocationId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditSessionOverage_sessionId_key" ON "CreditSessionOverage"("sessionId");

-- CreateIndex
CREATE INDEX "CreditSessionOverage_walletId_idx" ON "CreditSessionOverage"("walletId");

-- AddForeignKey
ALTER TABLE "CreditWallet" ADD CONSTRAINT "CreditWallet_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditAllocation" ADD CONSTRAINT "CreditAllocation_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "CreditWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "CreditWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_allocationId_walletId_fkey" FOREIGN KEY ("allocationId", "walletId") REFERENCES "CreditAllocation"("id", "walletId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransactionEntry" ADD CONSTRAINT "CreditTransactionEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "CreditWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransactionEntry" ADD CONSTRAINT "CreditTransactionEntry_transactionId_walletId_fkey" FOREIGN KEY ("transactionId", "walletId") REFERENCES "CreditTransaction"("id", "walletId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransactionEntry" ADD CONSTRAINT "CreditTransactionEntry_allocationId_walletId_fkey" FOREIGN KEY ("allocationId", "walletId") REFERENCES "CreditAllocation"("id", "walletId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditSessionOverage" ADD CONSTRAINT "CreditSessionOverage_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "CreditWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- CHECK constraints
-- ============================================================

ALTER TABLE "CreditWallet"
  ADD CONSTRAINT "CreditWallet_balance_non_negative" CHECK ("balanceCredits" >= 0),
  ADD CONSTRAINT "CreditWallet_overage_non_negative" CHECK ("outstandingOverageCredits" >= 0),
  -- New allocations repay outstanding overage first, so a wallet never has
  -- both a balance and unpaid overage.
  ADD CONSTRAINT "CreditWallet_overage_only_without_balance" CHECK ("outstandingOverageCredits" = 0 OR "balanceCredits" = 0);

ALTER TABLE "CreditAllocation"
  ADD CONSTRAINT "CreditAllocation_granted_positive" CHECK ("grantedCredits" > 0),
  ADD CONSTRAINT "CreditAllocation_remaining_within_granted" CHECK ("remainingCredits" >= 0 AND "remainingCredits" <= "grantedCredits"),
  ADD CONSTRAINT "CreditAllocation_source_reference_present" CHECK (length(btrim("sourceReference")) > 0),
  -- Trial and subscription credits expire after they are granted; purchased
  -- and referral credits never expire.
  ADD CONSTRAINT "CreditAllocation_expiry_matches_source" CHECK (
    ("source" IN ('TRIAL', 'SUBSCRIPTION') AND "expiresAt" IS NOT NULL AND "expiresAt" > "grantedAt")
    OR ("source" IN ('PURCHASE', 'REFERRAL') AND "expiresAt" IS NULL)
  ),
  -- Expired allocations have nothing left, and expire no earlier than expiresAt.
  ADD CONSTRAINT "CreditAllocation_expired_state" CHECK (
    "expiredAt" IS NULL
    OR ("expiresAt" IS NOT NULL AND "expiredAt" >= "expiresAt" AND "remainingCredits" = 0)
  );

ALTER TABLE "CreditTransaction"
  ADD CONSTRAINT "CreditTransaction_sequence_positive" CHECK ("sequence" >= 1),
  ADD CONSTRAINT "CreditTransaction_totals_non_negative" CHECK ("balanceAfterCredits" >= 0 AND "outstandingOverageAfterCredits" >= 0),
  ADD CONSTRAINT "CreditTransaction_idempotency_key_present" CHECK (length(btrim("idempotencyKey")) > 0),
  ADD CONSTRAINT "CreditTransaction_shape_matches_type" CHECK (
    ("type" = 'ALLOCATION' AND "amountCredits" > 0 AND "overageChangeCredits" = 0
      AND "allocationId" IS NOT NULL AND "sessionId" IS NULL)
    OR ("type" = 'DEDUCTION' AND "amountCredits" <= 0 AND "overageChangeCredits" >= 0
      AND ("amountCredits" < 0 OR "overageChangeCredits" > 0) AND "allocationId" IS NULL)
    OR ("type" = 'EXPIRATION' AND "amountCredits" < 0 AND "overageChangeCredits" = 0
      AND "allocationId" IS NOT NULL AND "sessionId" IS NULL)
    OR ("type" = 'OVERAGE_SETTLEMENT' AND "amountCredits" < 0 AND "overageChangeCredits" = "amountCredits"
      AND "allocationId" IS NOT NULL AND "sessionId" IS NULL)
  );

ALTER TABLE "CreditTransactionEntry"
  ADD CONSTRAINT "CreditTransactionEntry_amount_non_zero" CHECK ("amountCredits" <> 0);

ALTER TABLE "CreditSessionOverage"
  ADD CONSTRAINT "CreditSessionOverage_amounts_within_limit" CHECK (
    "limitCredits" >= 0 AND "overageCredits" > 0 AND "overageCredits" <= "limitCredits"
    AND "settledCredits" >= 0 AND "settledCredits" <= "overageCredits"
  );

-- ============================================================
-- Partial indexes
-- ============================================================

-- At most one trial allocation per wallet, whatever its source reference.
CREATE UNIQUE INDEX "CreditAllocation_one_trial_per_wallet" ON "CreditAllocation"("walletId") WHERE "source" = 'TRIAL';
-- An allocation is added, expired and used for overage settlement at most once.
CREATE UNIQUE INDEX "CreditTransaction_one_allocation_per_allocation" ON "CreditTransaction"("allocationId") WHERE "type" = 'ALLOCATION';
CREATE UNIQUE INDEX "CreditTransaction_one_expiration_per_allocation" ON "CreditTransaction"("allocationId") WHERE "type" = 'EXPIRATION';
CREATE UNIQUE INDEX "CreditTransaction_one_settlement_per_allocation" ON "CreditTransaction"("allocationId") WHERE "type" = 'OVERAGE_SETTLEMENT';
-- Spendable allocations of a wallet, and allocations due for expiry.
CREATE INDEX "CreditAllocation_open_by_wallet" ON "CreditAllocation"("walletId") WHERE "remainingCredits" > 0;
CREATE INDEX "CreditAllocation_open_by_expiry" ON "CreditAllocation"("expiresAt") WHERE "remainingCredits" > 0 AND "expiresAt" IS NOT NULL;
CREATE INDEX "CreditSessionOverage_unsettled_by_wallet" ON "CreditSessionOverage"("walletId") WHERE "overageCredits" > "settledCredits";

-- ============================================================
-- Triggers (not modelled by Prisma). Functions keep the search_path of the
-- migration, so unqualified table names resolve to this schema.
-- ============================================================

-- History protection: rows cannot be deleted while their owner exists
-- (deleting the user still cascades), ledger rows never change, and
-- allocations and session overage only change in the permitted direction.
CREATE FUNCTION "Credit_protect_history"() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  owner_exists boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- During a cascade the owner row is already gone.
    IF TG_TABLE_NAME = 'CreditWallet' THEN
      SELECT EXISTS (SELECT 1 FROM "authUser" WHERE "id" = OLD."authId") INTO owner_exists;
    ELSE
      SELECT EXISTS (SELECT 1 FROM "CreditWallet" WHERE "id" = OLD."walletId") INTO owner_exists;
    END IF;
    IF owner_exists THEN
      RAISE EXCEPTION '% rows cannot be deleted while their owner exists', TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_TABLE_NAME IN ('CreditTransaction', 'CreditTransactionEntry') THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;

  IF TG_TABLE_NAME = 'CreditWallet' THEN
    IF NEW."id" <> OLD."id" OR NEW."authId" <> OLD."authId" THEN
      RAISE EXCEPTION 'A credit wallet cannot move to another user' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'CreditAllocation' THEN
    IF NEW."id" <> OLD."id" OR NEW."walletId" <> OLD."walletId" OR NEW."source" <> OLD."source"
       OR NEW."sourceReference" <> OLD."sourceReference" OR NEW."grantedCredits" <> OLD."grantedCredits"
       OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."grantedAt" <> OLD."grantedAt" THEN
      RAISE EXCEPTION 'Credit allocation terms cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."remainingCredits" > OLD."remainingCredits" THEN
      RAISE EXCEPTION 'Remaining credits of an allocation cannot increase' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."expiredAt" IS NOT NULL AND NEW."expiredAt" IS DISTINCT FROM OLD."expiredAt" THEN
      RAISE EXCEPTION 'The expiry of an allocation cannot be changed once recorded' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'CreditSessionOverage' THEN
    IF NEW."id" <> OLD."id" OR NEW."walletId" <> OLD."walletId" OR NEW."sessionId" <> OLD."sessionId"
       OR NEW."limitCredits" <> OLD."limitCredits" THEN
      RAISE EXCEPTION 'Session overage terms cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."overageCredits" < OLD."overageCredits" OR NEW."settledCredits" < OLD."settledCredits" THEN
      RAISE EXCEPTION 'Session overage and its settlement cannot decrease' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditWallet_protect_history" BEFORE UPDATE OR DELETE ON "CreditWallet"
  FOR EACH ROW EXECUTE FUNCTION "Credit_protect_history"();
CREATE TRIGGER "CreditAllocation_protect_history" BEFORE UPDATE OR DELETE ON "CreditAllocation"
  FOR EACH ROW EXECUTE FUNCTION "Credit_protect_history"();
CREATE TRIGGER "CreditTransaction_protect_history" BEFORE UPDATE OR DELETE ON "CreditTransaction"
  FOR EACH ROW EXECUTE FUNCTION "Credit_protect_history"();
CREATE TRIGGER "CreditTransactionEntry_protect_history" BEFORE UPDATE OR DELETE ON "CreditTransactionEntry"
  FOR EACH ROW EXECUTE FUNCTION "Credit_protect_history"();
CREATE TRIGGER "CreditSessionOverage_protect_history" BEFORE UPDATE OR DELETE ON "CreditSessionOverage"
  FOR EACH ROW EXECUTE FUNCTION "Credit_protect_history"();

-- Ledger chain: each wallet's transactions are numbered 1, 2, 3, ... and
-- each one's running totals are the previous totals plus its changes.
CREATE FUNCTION "CreditTransaction_check_chain"() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  prev RECORD;
  prev_sequence integer := 0;
  prev_balance numeric := 0;
  prev_overage numeric := 0;
BEGIN
  SELECT "sequence", "balanceAfterCredits", "outstandingOverageAfterCredits" INTO prev
    FROM "CreditTransaction" WHERE "walletId" = NEW."walletId"
    ORDER BY "sequence" DESC LIMIT 1;
  IF FOUND THEN
    prev_sequence := prev."sequence";
    prev_balance := prev."balanceAfterCredits";
    prev_overage := prev."outstandingOverageAfterCredits";
  END IF;
  IF NEW."sequence" <> prev_sequence + 1 THEN
    RAISE EXCEPTION 'Credit transaction % of wallet % must follow %', NEW."sequence", NEW."walletId", prev_sequence
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."balanceAfterCredits" <> prev_balance + NEW."amountCredits"
     OR NEW."outstandingOverageAfterCredits" <> prev_overage + NEW."overageChangeCredits" THEN
    RAISE EXCEPTION 'Credit transaction totals of wallet % do not follow from the previous transaction', NEW."walletId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditTransaction_check_chain" BEFORE INSERT ON "CreditTransaction"
  FOR EACH ROW EXECUTE FUNCTION "CreditTransaction_check_chain"();

-- Reconciliation, checked when the transaction commits (deferred), so the
-- rows of one operation can be written in any order.
CREATE FUNCTION "Credit_verify_wallet"(wallet_id text) RETURNS void
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  wallet RECORD;
  ledger_balance numeric := 0;
  ledger_overage numeric := 0;
  allocated numeric;
  unsettled numeric;
BEGIN
  SELECT "balanceCredits", "outstandingOverageCredits" INTO wallet FROM "CreditWallet" WHERE "id" = wallet_id;
  IF NOT FOUND THEN
    RETURN; -- deleted later in the same transaction
  END IF;
  SELECT "balanceAfterCredits", "outstandingOverageAfterCredits" INTO ledger_balance, ledger_overage
    FROM "CreditTransaction" WHERE "walletId" = wallet_id ORDER BY "sequence" DESC LIMIT 1;
  IF NOT FOUND THEN
    ledger_balance := 0;
    ledger_overage := 0;
  END IF;
  SELECT COALESCE(SUM("remainingCredits"), 0) INTO allocated
    FROM "CreditAllocation" WHERE "walletId" = wallet_id AND "remainingCredits" > 0;
  SELECT COALESCE(SUM("overageCredits" - "settledCredits"), 0) INTO unsettled
    FROM "CreditSessionOverage" WHERE "walletId" = wallet_id AND "overageCredits" > "settledCredits";

  IF wallet."balanceCredits" <> ledger_balance OR wallet."balanceCredits" <> allocated THEN
    RAISE EXCEPTION 'Credit wallet % balance % does not match its ledger (%) and allocations (%)',
      wallet_id, wallet."balanceCredits", ledger_balance, allocated USING ERRCODE = 'check_violation';
  END IF;
  IF wallet."outstandingOverageCredits" <> ledger_overage OR wallet."outstandingOverageCredits" <> unsettled THEN
    RAISE EXCEPTION 'Credit wallet % overage % does not match its ledger (%) and sessions (%)',
      wallet_id, wallet."outstandingOverageCredits", ledger_overage, unsettled USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE FUNCTION "Credit_verify_transaction"(transaction_id text) RETURNS void
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  amount numeric;
  entries numeric;
BEGIN
  SELECT "amountCredits" INTO amount FROM "CreditTransaction" WHERE "id" = transaction_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT COALESCE(SUM("amountCredits"), 0) INTO entries FROM "CreditTransactionEntry" WHERE "transactionId" = transaction_id;
  IF amount <> entries THEN
    RAISE EXCEPTION 'Credit transaction % amount % does not match its entries (%)', transaction_id, amount, entries
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE FUNCTION "Credit_verify_allocation"(allocation_id text) RETURNS void
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  remaining numeric;
  entries numeric;
BEGIN
  SELECT "remainingCredits" INTO remaining FROM "CreditAllocation" WHERE "id" = allocation_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT COALESCE(SUM("amountCredits"), 0) INTO entries FROM "CreditTransactionEntry" WHERE "allocationId" = allocation_id;
  IF remaining <> entries THEN
    RAISE EXCEPTION 'Credit allocation % remaining % does not match its entries (%)', allocation_id, remaining, entries
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE FUNCTION "Credit_verify_row"() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_TABLE_NAME = 'CreditWallet' THEN
    PERFORM "Credit_verify_wallet"(NEW."id");
  ELSIF TG_TABLE_NAME = 'CreditTransaction' THEN
    PERFORM "Credit_verify_wallet"(NEW."walletId");
    PERFORM "Credit_verify_transaction"(NEW."id");
  ELSIF TG_TABLE_NAME = 'CreditAllocation' THEN
    PERFORM "Credit_verify_wallet"(NEW."walletId");
    PERFORM "Credit_verify_allocation"(NEW."id");
  ELSIF TG_TABLE_NAME = 'CreditTransactionEntry' THEN
    PERFORM "Credit_verify_transaction"(NEW."transactionId");
    PERFORM "Credit_verify_allocation"(NEW."allocationId");
  ELSIF TG_TABLE_NAME = 'CreditSessionOverage' THEN
    PERFORM "Credit_verify_wallet"(NEW."walletId");
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "CreditWallet_verify" AFTER INSERT OR UPDATE ON "CreditWallet"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "Credit_verify_row"();
CREATE CONSTRAINT TRIGGER "CreditAllocation_verify" AFTER INSERT OR UPDATE ON "CreditAllocation"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "Credit_verify_row"();
CREATE CONSTRAINT TRIGGER "CreditTransaction_verify" AFTER INSERT ON "CreditTransaction"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "Credit_verify_row"();
CREATE CONSTRAINT TRIGGER "CreditTransactionEntry_verify" AFTER INSERT ON "CreditTransactionEntry"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "Credit_verify_row"();
CREATE CONSTRAINT TRIGGER "CreditSessionOverage_verify" AFTER INSERT OR UPDATE ON "CreditSessionOverage"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "Credit_verify_row"();
