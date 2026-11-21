-- Monthly Pro credits belong to the successful Stripe payment that paid for
-- them. Each SUBSCRIPTION allocation records the UserSubscription, the
-- PaymentTransaction and the month [periodStart, expiresAt) it is for; its
-- credits count from periodStart (a renewal paid before its period starts is
-- allocated at payment time but only counts once the period begins).
--
-- Guarantees:
--   * SUBSCRIPTION allocations always have these links; other sources never;
--   * one allocation per payment and month (unique index);
--   * a new SUBSCRIPTION allocation is accepted only for a SUCCEEDED payment
--     of the same user's subscription that created or renewed the paid term
--     (CREATED/RENEWED event), inside the payment's period (trigger);
--   * the links never change afterwards.

-- AlterTable
ALTER TABLE "CreditAllocation" ADD COLUMN     "paymentId" TEXT,
ADD COLUMN     "periodStart" TIMESTAMP(3),
ADD COLUMN     "subscriptionId" TEXT;

-- Monthly Pro credits granted before this migration (on first use, with the
-- reference 'pro:<proStartedAt>:<monthStart>', both 24-character ISO times)
-- are linked to the payment whose period contains their month.
UPDATE "CreditAllocation" a
SET "periodStart" = m."monthStart",
    "paymentId" = m."paymentId",
    "subscriptionId" = m."subscriptionId"
FROM (
  SELECT a2."id",
         (right(a2."sourceReference", 24)::timestamptz AT TIME ZONE 'UTC') AS "monthStart",
         p."id" AS "paymentId",
         p."subscriptionId"
  FROM "CreditAllocation" a2
  JOIN "UserSubscription" s ON s."authId" = a2."authId"
  JOIN LATERAL (
    SELECT pt."id", pt."subscriptionId"
    FROM "PaymentTransaction" pt
    WHERE pt."subscriptionId" = s."id"
      AND pt."periodStart" <= (right(a2."sourceReference", 24)::timestamptz AT TIME ZONE 'UTC')
      AND (right(a2."sourceReference", 24)::timestamptz AT TIME ZONE 'UTC') < pt."periodEnd"
    ORDER BY pt."periodStart" DESC
    LIMIT 1
  ) p ON true
  WHERE a2."source" = 'SUBSCRIPTION'
    AND a2."paymentId" IS NULL
    AND a2."sourceReference" LIKE 'pro:%'
) m
WHERE a."id" = m."id";

-- The update queued the deferred ledger-consistency check; run it now, so
-- the table has no pending trigger events before it is altered below.
SET CONSTRAINTS "CreditAllocation_consistency_check" IMMEDIATE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "CreditAllocation"
    WHERE "source" = 'SUBSCRIPTION' AND "paymentId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Some SUBSCRIPTION credit allocations could not be linked to the payment of their month; link or review them, then rerun this migration';
  END IF;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX "CreditAllocation_paymentId_periodStart_key" ON "CreditAllocation"("paymentId", "periodStart");

-- AddForeignKey
ALTER TABLE "CreditAllocation" ADD CONSTRAINT "CreditAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "PaymentTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CreditAllocation"
  ADD CONSTRAINT "CreditAllocation_payment_link" CHECK (
    ("source" = 'SUBSCRIPTION') = ("paymentId" IS NOT NULL)
    AND ("paymentId" IS NULL) = ("subscriptionId" IS NULL)
    AND ("paymentId" IS NULL) = ("periodStart" IS NULL)
    AND ("periodStart" IS NULL OR "periodStart" < "expiresAt")
  );

SET CONSTRAINTS "CreditAllocation_consistency_check" DEFERRED;

-- The links are part of the grant: they never change.
CREATE OR REPLACE FUNCTION "CreditAllocation_protect"() RETURNS trigger
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
    OR NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId"
    OR NEW."paymentId" IS DISTINCT FROM OLD."paymentId"
    OR NEW."periodStart" IS DISTINCT FROM OLD."periodStart"
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

-- Monthly Pro credits only for a successful payment that created or renewed
-- the same user's paid term, and only within the period it paid for.
CREATE FUNCTION "CreditAllocation_subscription_payment_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_subscription_id text;
  v_status text;
  v_period_start timestamp(3);
  v_period_end timestamp(3);
  v_owner text;
  v_granted_term boolean;
BEGIN
  IF NEW."source" <> 'SUBSCRIPTION' THEN
    RETURN NEW;
  END IF;

  EXECUTE format(
    'SELECT "subscriptionId", "status"::text, "periodStart", "periodEnd" FROM %I."PaymentTransaction" WHERE "id" = $1',
    TG_TABLE_SCHEMA
  ) INTO v_subscription_id, v_status, v_period_start, v_period_end USING NEW."paymentId";
  IF v_status IS NULL OR v_subscription_id IS DISTINCT FROM NEW."subscriptionId" THEN
    RAISE EXCEPTION 'Monthly Pro credits must belong to a payment of their subscription'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_status <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'Monthly Pro credits require a successful payment (payment is %)', v_status
      USING ERRCODE = 'check_violation';
  END IF;

  EXECUTE format('SELECT "authId" FROM %I."UserSubscription" WHERE "id" = $1', TG_TABLE_SCHEMA)
    INTO v_owner USING NEW."subscriptionId";
  IF v_owner IS DISTINCT FROM NEW."authId" THEN
    RAISE EXCEPTION 'Monthly Pro credits must belong to the subscription''s user'
      USING ERRCODE = 'check_violation';
  END IF;

  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I."SubscriptionEvent" WHERE "paymentId" = $1 AND "type" IN (''CREATED'', ''RENEWED''))',
    TG_TABLE_SCHEMA
  ) INTO v_granted_term USING NEW."paymentId";
  IF NOT v_granted_term THEN
    RAISE EXCEPTION 'Monthly Pro credits require a payment that created or renewed the paid term'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."periodStart" < v_period_start OR NEW."expiresAt" > v_period_end THEN
    RAISE EXCEPTION 'Monthly Pro credits must lie within the paid period'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditAllocation_subscription_payment_check"
  BEFORE INSERT ON "CreditAllocation"
  FOR EACH ROW EXECUTE FUNCTION "CreditAllocation_subscription_payment_check"();
