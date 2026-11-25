-- Pro credits for yearly subscriptions, one month at a time: a paid period
-- funds one SUBSCRIPTION allocation per month (periodIndex 0 for a monthly
-- payment, 0..11 for a yearly payment), each granted when its month begins,
-- so a yearly payment never grants the whole year's credits at once.
--
-- Month k of a paid period is [periodStart + k months, periodStart + (k+1)
-- months), with the last month ending at periodEnd; PostgreSQL's
-- `timestamp + interval` month arithmetic (day clamped to the month's last
-- day, always from the period start) is the rule, and
-- src/credit/credit-subscription.policy.ts computes the same boundaries.

-- Schema changes first: PostgreSQL refuses DDL on a table with pending
-- (deferred) trigger events, which the backfill below creates.

-- AlterTable
ALTER TABLE "CreditAllocation" ADD COLUMN     "periodIndex" INTEGER;

-- One allocation per payment and month (previously: per payment).
DROP INDEX "CreditAllocation_paymentId_key";
CREATE UNIQUE INDEX "CreditAllocation_paymentId_periodIndex_key" ON "CreditAllocation"("paymentId", "periodIndex");

ALTER TABLE "CreditAllocation" DROP CONSTRAINT "CreditAllocation_subscription_period_link";

-- Existing (monthly) allocations are month 0 of their payment.
UPDATE "CreditAllocation" SET "periodIndex" = 0 WHERE "source" = 'SUBSCRIPTION';
-- Run the ledger's deferred reconciliation checks for the backfilled rows
-- now (they would otherwise block the constraint below until commit).
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE "CreditAllocation"
  ADD CONSTRAINT "CreditAllocation_subscription_period_link" CHECK (
    ("source" = 'SUBSCRIPTION' AND "subscriptionId" IS NOT NULL AND "paymentId" IS NOT NULL
      AND "periodStartsAt" IS NOT NULL AND "periodIndex" IS NOT NULL AND "periodIndex" BETWEEN 0 AND 11)
    OR ("source" <> 'SUBSCRIPTION' AND "subscriptionId" IS NULL AND "paymentId" IS NULL
      AND "periodStartsAt" IS NULL AND "periodIndex" IS NULL)
  );

-- At insert, a SUBSCRIPTION allocation must match its payment: SUCCEEDED and
-- granting Pro access, of the same subscription, whose user owns the wallet,
-- and exactly month
-- periodIndex of the paid period (months 0..11 of a yearly payment, month 0
-- of a monthly payment).
CREATE OR REPLACE FUNCTION "CreditAllocation_check_subscription_payment"() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  paid RECORD;
  wallet_owner text;
  months integer;
  month_start timestamp(3);
  month_end timestamp(3);
BEGIN
  IF NEW."source" <> 'SUBSCRIPTION' THEN
    RETURN NEW;
  END IF;
  SELECT p."status", p."subscriptionId", p."billingInterval", p."periodStart", p."periodEnd", s."authId"
    INTO paid
    FROM "PaymentTransaction" p
    LEFT JOIN "UserSubscription" s ON s."id" = p."subscriptionId"
    WHERE p."id" = NEW."paymentId";
  IF NOT FOUND OR paid."status" <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'Subscription credits require a succeeded payment'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Only a payment that granted or extended Pro access (CREATED or RENEWED
  -- event) funds credits: a duplicate payment is recorded as SUCCEEDED so it
  -- can be refunded, but it never grants access and never credits.
  IF NOT EXISTS (
    SELECT 1 FROM "SubscriptionEvent" e
    WHERE e."paymentId" = NEW."paymentId" AND e."type" IN ('CREATED', 'RENEWED')
  ) THEN
    RAISE EXCEPTION 'Subscription credits require a payment that granted Pro access'
      USING ERRCODE = 'check_violation';
  END IF;
  IF paid."subscriptionId" IS DISTINCT FROM NEW."subscriptionId" THEN
    RAISE EXCEPTION 'The payment does not belong to this subscription'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "authId" INTO wallet_owner FROM "CreditWallet" WHERE "id" = NEW."walletId";
  IF paid."authId" IS DISTINCT FROM wallet_owner THEN
    RAISE EXCEPTION 'The subscription belongs to another user'
      USING ERRCODE = 'check_violation';
  END IF;

  months := CASE WHEN paid."billingInterval" = 'YEARLY' THEN 12 ELSE 1 END;
  IF NEW."periodIndex" < 0 OR NEW."periodIndex" >= months THEN
    RAISE EXCEPTION 'Month % is outside the paid period', NEW."periodIndex"
      USING ERRCODE = 'check_violation';
  END IF;
  month_start := paid."periodStart" + make_interval(months => NEW."periodIndex");
  month_end := CASE
    WHEN NEW."periodIndex" = months - 1 THEN paid."periodEnd"
    ELSE paid."periodStart" + make_interval(months => NEW."periodIndex" + 1)
  END;
  IF NEW."periodStartsAt" <> month_start OR NEW."expiresAt" IS DISTINCT FROM month_end THEN
    RAISE EXCEPTION 'Subscription credits must cover exactly one month of the paid period'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- periodIndex is an allocation term: immutable like the others.
CREATE OR REPLACE FUNCTION "Credit_protect_history"() RETURNS trigger
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
       OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."grantedAt" <> OLD."grantedAt"
       OR NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId"
       OR NEW."paymentId" IS DISTINCT FROM OLD."paymentId"
       OR NEW."periodStartsAt" IS DISTINCT FROM OLD."periodStartsAt"
       OR NEW."periodIndex" IS DISTINCT FROM OLD."periodIndex" THEN
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
