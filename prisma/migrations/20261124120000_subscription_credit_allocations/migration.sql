-- Monthly Pro credits are granted for successful payments: every new
-- SUBSCRIPTION allocation records the user's subscription, the payment that
-- paid for it and the billing period it covers, and expires at the end of
-- that period (the billing boundary). See prisma/schema/credit.prisma.
--
-- Guarantees:
--   * a new SUBSCRIPTION allocation must reference a SUCCEEDED (or, for
--     later months of a yearly payment, PARTIALLY_REFUNDED) payment of the
--     same subscription, which belongs to the allocation's user, that paid
--     for Pro (it created or renewed the paid term: a CREATED or RENEWED
--     SubscriptionEvent; duplicate charges kept for refunds do not count),
--     and its period must lie within the payment's period (insert trigger);
--   * at most one allocation per user and billing period start (partial
--     unique index), so a payment, a retried or duplicated webhook, or a
--     second payment for the same period cannot grant a period twice;
--   * the link and period never change afterwards (CreditAllocation_protect);
--   * deleting the user still removes everything: the subscription (deleted
--     only with its user) cascades to its allocations, so the ledger's delete
--     guard now allows deletes once the user is gone, whichever cascade
--     reaches a row first (previously: once the wallet was gone).
-- Existing SUBSCRIPTION allocations from before this migration have no
-- payment link; the columns stay NULL for them and for other sources.

-- AlterTable
ALTER TABLE "CreditAllocation" ADD COLUMN     "paymentId" TEXT,
ADD COLUMN     "periodEnd" TIMESTAMP(3),
ADD COLUMN     "periodStart" TIMESTAMP(3),
ADD COLUMN     "subscriptionId" TEXT;

-- CreateIndex
CREATE INDEX "CreditAllocation_paymentId_idx" ON "CreditAllocation"("paymentId");

-- CreateIndex
CREATE INDEX "CreditAllocation_subscriptionId_idx" ON "CreditAllocation"("subscriptionId");

-- AddForeignKey
ALTER TABLE "CreditAllocation" ADD CONSTRAINT "CreditAllocation_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "UserSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditAllocation" ADD CONSTRAINT "CreditAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "PaymentTransaction"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- The paid-period columns are set together, only for SUBSCRIPTION credits,
-- and the credits expire exactly at the end of the period.
ALTER TABLE "CreditAllocation"
  ADD CONSTRAINT "CreditAllocation_paid_period_complete" CHECK (
    ("subscriptionId" IS NULL) = ("paymentId" IS NULL)
    AND ("paymentId" IS NULL) = ("periodStart" IS NULL)
    AND ("periodStart" IS NULL) = ("periodEnd" IS NULL)
  ),
  ADD CONSTRAINT "CreditAllocation_paid_period_subscription_only" CHECK (
    "paymentId" IS NULL OR "source" = 'SUBSCRIPTION'
  ),
  ADD CONSTRAINT "CreditAllocation_paid_period_valid" CHECK (
    "periodStart" IS NULL
    OR ("periodStart" < "periodEnd" AND "expiresAt" = "periodEnd")
  );

-- One allocation per user and billing period.
CREATE UNIQUE INDEX "CreditAllocation_one_per_paid_period"
  ON "CreditAllocation" ("walletId", "periodStart")
  WHERE "source" = 'SUBSCRIPTION' AND "periodStart" IS NOT NULL;

-- New SUBSCRIPTION credits must be paid for by this user's subscription.
CREATE FUNCTION "CreditAllocation_paid_period_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  payment_status text;
  payment_subscription text;
  payment_start timestamp(3);
  payment_end timestamp(3);
  subscription_owner text;
  paid_for_pro boolean;
BEGIN
  IF NEW."source" = 'SUBSCRIPTION' AND NEW."paymentId" IS NULL THEN
    RAISE EXCEPTION 'SUBSCRIPTION credits require the successful payment that paid for them'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."paymentId" IS NULL THEN
    RETURN NEW;
  END IF;

  EXECUTE format(
    'SELECT p."status"::text, p."subscriptionId", p."periodStart", p."periodEnd", s."authId"
       FROM %1$I."PaymentTransaction" p
       LEFT JOIN %1$I."UserSubscription" s ON s."id" = p."subscriptionId"
      WHERE p."id" = $1',
    TG_TABLE_SCHEMA
  ) INTO payment_status, payment_subscription, payment_start, payment_end, subscription_owner
    USING NEW."paymentId";

  IF payment_status IS NULL OR payment_status NOT IN ('SUCCEEDED', 'PARTIALLY_REFUNDED') THEN
    RAISE EXCEPTION 'SUBSCRIPTION credits require a successful payment (payment %)', NEW."paymentId"
      USING ERRCODE = 'check_violation';
  END IF;
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I."SubscriptionEvent"
                     WHERE "paymentId" = $1 AND "type" IN (''CREATED'', ''RENEWED''))',
    TG_TABLE_SCHEMA
  ) INTO paid_for_pro USING NEW."paymentId";
  IF NOT paid_for_pro THEN
    RAISE EXCEPTION 'SUBSCRIPTION credits require a payment that created or renewed the paid term'
      USING ERRCODE = 'check_violation';
  END IF;
  IF payment_subscription IS DISTINCT FROM NEW."subscriptionId"
    OR subscription_owner IS DISTINCT FROM NEW."authId" THEN
    RAISE EXCEPTION 'SUBSCRIPTION credits must belong to the user and subscription of their payment'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."periodStart" < payment_start OR NEW."periodEnd" > payment_end THEN
    RAISE EXCEPTION 'SUBSCRIPTION credits must cover a period within the paid period'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditAllocation_paid_period_check"
  BEFORE INSERT ON "CreditAllocation"
  FOR EACH ROW EXECUTE FUNCTION "CreditAllocation_paid_period_check"();

-- The payment link and period are grant details: they never change.
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
    OR NEW."periodEnd" IS DISTINCT FROM OLD."periodEnd"
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

-- Ledger rows may be deleted only as part of deleting their user. During the
-- account deletion cascade the user row is already gone, but the wallet may
-- not be yet (the subscription's cascade can reach allocations first).
CREATE OR REPLACE FUNCTION "Credit_wallet_child_delete_guard"(p_schema text, p_wallet_id text, p_table text)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  owner_exists boolean;
BEGIN
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %1$I."CreditWallet" w
                      JOIN %1$I."authUser" u ON u."id" = w."authId"
                     WHERE w."id" = $1)',
    p_schema
  ) INTO owner_exists USING p_wallet_id;
  IF owner_exists THEN
    RAISE EXCEPTION '% history cannot be deleted while its user exists', p_table
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;
