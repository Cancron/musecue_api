-- Removes the idle lapse of session reservations (migration
-- 20261127120000_session_credit_overage): an unfinished makeup session now
-- keeps its reserved credit and its overage allowance until it is completed
-- (or deleted), however long it is idle. Sessions that had lapsed are
-- initialized again, as they were before they lapsed (their reservation had
-- already been released).

-- Without LAPSED, a reservation is never renewed: it is only used up or
-- released. The limit stays fixed and overage usage only grows.
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
  IF NEW."reservationRemaining" > OLD."reservationRemaining"
    OR NEW."reservedCredits" IS DISTINCT FROM OLD."reservedCredits"
    OR NEW."initializedAt" IS DISTINCT FROM OLD."initializedAt" THEN
    RAISE EXCEPTION 'CreditSessionOverage reservation can only be used up or released'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE "CreditSessionOverage" DROP CONSTRAINT "CreditSessionOverage_lapsed_holds_nothing";

-- AlterTable
ALTER TABLE "CreditSessionOverage" DROP COLUMN "lastActivityAt",
DROP COLUMN "status";

-- DropEnum
DROP TYPE "CreditSessionStatus";
