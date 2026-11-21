-- Session credit overage and concurrency control (see prisma/schema/credit.prisma,
-- CreditSessionOverage). A makeup session is initialized under the wallet lock
-- with free credits (the usable balance minus what the user's other sessions
-- have reserved), reserves up to one credit of them and fixes its overage limit;
-- its charges use its reservation and the free balance, then its overage. One
-- credit can therefore never initialize two sessions, and overage is only
-- available to initialized sessions. Also makes exact fractional deductions
-- the default ($0.025 at $0.005 per credit -> 5 credits, $0.023 -> 4.6).

-- CreateEnum
CREATE TYPE "CreditSessionStatus" AS ENUM ('ACTIVE', 'LAPSED');

-- AlterTable
ALTER TABLE "CreditSessionOverage" ADD COLUMN     "initializedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "reservationRemaining" DECIMAL(18,6) NOT NULL DEFAULT 0,
ADD COLUMN     "reservedCredits" DECIMAL(18,6) NOT NULL DEFAULT 0,
ADD COLUMN     "status" "CreditSessionStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "CreditSettings" ALTER COLUMN "deductionStepMicroCredits" SET DEFAULT 1;

-- Sessions that used overage before this release were initialized when they
-- first did; they keep their overage and reserve nothing.
UPDATE "CreditSessionOverage"
SET "initializedAt" = "createdAt", "lastActivityAt" = "updatedAt";

-- The new default deduction step (exact) replaces the previous default
-- (whole credits) unless an administrator chose the step explicitly.
UPDATE "CreditSettings" s
SET "deductionStepMicroCredits" = 1, "updatedAt" = CURRENT_TIMESTAMP
WHERE s."deductionStepMicroCredits" = 1000000
  AND NOT EXISTS (
    SELECT 1
    FROM "ActivityLogEvent" e
    JOIN "ActivityLogEventDetail" d ON d."eventId" = e."id"
    WHERE e."tableName" = 'CreditSettings'
      AND d."fieldName" = 'deductionStepMicroCredits'
  );

ALTER TABLE "CreditSessionOverage"
  ADD CONSTRAINT "CreditSessionOverage_reservation_range" CHECK (
    "reservedCredits" >= 0
    AND "reservationRemaining" >= 0
    AND "reservationRemaining" <= "reservedCredits"
  ),
  ADD CONSTRAINT "CreditSessionOverage_lapsed_holds_nothing" CHECK (
    "status" = 'ACTIVE' OR "reservationRemaining" = 0
  );

-- The limit is fixed, overage usage only grows, and reserved credits are
-- only used up or released; a new reservation is only possible when a
-- LAPSED session is initialized again.
CREATE OR REPLACE FUNCTION "CreditSessionOverage_protect"() RETURNS trigger
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
  IF (NEW."reservationRemaining" > OLD."reservationRemaining"
      OR NEW."reservedCredits" IS DISTINCT FROM OLD."reservedCredits"
      OR NEW."initializedAt" IS DISTINCT FROM OLD."initializedAt")
    AND NOT (OLD."status" = 'LAPSED' AND NEW."status" = 'ACTIVE') THEN
    RAISE EXCEPTION 'CreditSessionOverage reservation can only be renewed when a lapsed session is initialized again'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Deferred to commit: a session's recorded overage is exactly the overage of
-- its DEBIT transactions, and overage is never used without the session's
-- record (so it is always within the session's limit).
CREATE FUNCTION "CreditSessionOverage_consistency_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  recorded numeric;
  debited numeric;
  wallet_exists boolean;
BEGIN
  EXECUTE format(
    'SELECT "overageUsed" FROM %I."CreditSessionOverage" WHERE "walletId" = $1 AND "sessionId" = $2',
    TG_TABLE_SCHEMA
  ) INTO recorded USING NEW."walletId", NEW."sessionId";
  IF recorded IS NULL THEN
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I."CreditWallet" WHERE "id" = $1)', TG_TABLE_SCHEMA)
      INTO wallet_exists USING NEW."walletId";
    IF NOT wallet_exists THEN
      RETURN NULL; -- deleted with its wallet
    END IF;
    RAISE EXCEPTION 'Overage was used for session % without its CreditSessionOverage record', NEW."sessionId"
      USING ERRCODE = 'check_violation';
  END IF;
  EXECUTE format(
    'SELECT COALESCE(SUM("overageAmount"), 0) FROM %I."CreditTransaction" WHERE "walletId" = $1 AND "sessionId" = $2 AND "type" = ''DEBIT''',
    TG_TABLE_SCHEMA
  ) INTO debited USING NEW."walletId", NEW."sessionId";
  IF recorded <> debited THEN
    RAISE EXCEPTION 'CreditSessionOverage of session % records % overage but its debits used %',
      NEW."sessionId", recorded, debited
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "CreditSessionOverage_consistency_check"
  AFTER INSERT OR UPDATE ON "CreditSessionOverage"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "CreditSessionOverage_consistency_check"();

CREATE CONSTRAINT TRIGGER "CreditTransaction_overage_consistency_check"
  AFTER INSERT ON "CreditTransaction"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."overageAmount" > 0)
  EXECUTE FUNCTION "CreditSessionOverage_consistency_check"();

-- Existing data must already satisfy the rule.
DO $$
DECLARE
  inconsistent integer;
BEGIN
  SELECT count(*) INTO inconsistent
  FROM (
    SELECT o."walletId", o."sessionId"
    FROM "CreditSessionOverage" o
    LEFT JOIN "CreditTransaction" t
      ON t."walletId" = o."walletId" AND t."sessionId" = o."sessionId" AND t."type" = 'DEBIT'
    GROUP BY o."walletId", o."sessionId", o."overageUsed"
    HAVING o."overageUsed" <> COALESCE(SUM(t."overageAmount"), 0)
    UNION ALL
    SELECT t."walletId", t."sessionId"
    FROM "CreditTransaction" t
    WHERE t."overageAmount" > 0
      AND NOT EXISTS (
        SELECT 1 FROM "CreditSessionOverage" o
        WHERE o."walletId" = t."walletId" AND o."sessionId" = t."sessionId"
      )
  ) problems;
  IF inconsistent > 0 THEN
    RAISE EXCEPTION '% session overage records do not match their debits', inconsistent;
  END IF;
END $$;
