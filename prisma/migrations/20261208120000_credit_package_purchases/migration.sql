-- Credit package purchases through Stripe (Checkout Sessions in payment
-- mode).
--
-- PostgreSQL enforces, independently of the application:
-- - an order carries the terms of an available package when it is created
--   (credits and list price), and its terms, discount and charge never
--   change; its status only moves forward (a verified late payment of a
--   closed order still makes it PAID); orders are never deleted (they are
--   detached when the account is deleted);
-- - credits of an order (`credit-package:<order id>` PURCHASE credits) exist
--   only for a PAID order of the same user, for exactly its credits, once;
--   and a PAID order always has them (checked at commit);
-- - a paid package purchase is a paid purchase: the first-purchase and
--   referral discounts are not available after it, and it can qualify a
--   referral (exactly one qualifying payment or order per referral).

-- CreateEnum
CREATE TYPE "CreditPackageOrderStatus" AS ENUM ('CREATING', 'OPEN', 'PROCESSING', 'PAID', 'EXPIRED', 'FAILED', 'CANCELED');

-- AlterTable
ALTER TABLE "DiscountRedemption" ADD COLUMN     "packageOrderId" TEXT;

-- AlterTable
ALTER TABLE "Referral" ADD COLUMN     "qualifyingPackageOrderId" TEXT;

-- CreateTable
CREATE TABLE "CreditPackageOrder" (
    "id" TEXT NOT NULL,
    "authId" TEXT,
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "packageCode" "CreditPackageCode" NOT NULL,
    "credits" INTEGER NOT NULL,
    "listPriceUsdCents" INTEGER NOT NULL,
    "discountSource" "DiscountSource",
    "discountOfferId" TEXT,
    "discountPercent" INTEGER NOT NULL DEFAULT 0,
    "discountUsdCents" INTEGER NOT NULL DEFAULT 0,
    "amountUsdCents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "requestedDiscountCode" VARCHAR(32),
    "status" "CreditPackageOrderStatus" NOT NULL DEFAULT 'CREATING',
    "provider" VARCHAR(50),
    "providerCustomerId" VARCHAR(255),
    "providerSessionId" VARCHAR(255),
    "providerPaymentIntentId" VARCHAR(255),
    "url" TEXT,
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedReason" VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditPackageOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditPackageOrder_authId_createdAt_idx" ON "CreditPackageOrder"("authId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditPackageOrder_status_createdAt_idx" ON "CreditPackageOrder"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditPackageOrder_authId_idempotencyKey_key" ON "CreditPackageOrder"("authId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "CreditPackageOrder_provider_providerSessionId_key" ON "CreditPackageOrder"("provider", "providerSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditPackageOrder_provider_providerPaymentIntentId_key" ON "CreditPackageOrder"("provider", "providerPaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountRedemption_packageOrderId_key" ON "DiscountRedemption"("packageOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_qualifyingPackageOrderId_key" ON "Referral"("qualifyingPackageOrderId");

-- AddForeignKey
ALTER TABLE "CreditPackageOrder" ADD CONSTRAINT "CreditPackageOrder_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditPackageOrder" ADD CONSTRAINT "CreditPackageOrder_discountOfferId_fkey" FOREIGN KEY ("discountOfferId") REFERENCES "DiscountOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountRedemption" ADD CONSTRAINT "DiscountRedemption_packageOrderId_fkey" FOREIGN KEY ("packageOrderId") REFERENCES "CreditPackageOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_qualifyingPackageOrderId_fkey" FOREIGN KEY ("qualifyingPackageOrderId") REFERENCES "CreditPackageOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------

ALTER TABLE "CreditPackageOrder"
  ADD CONSTRAINT "CreditPackageOrder_terms" CHECK (
    "credits" > 0
    AND "listPriceUsdCents" > 0
    AND "discountPercent" BETWEEN 0 AND 100
    AND "discountUsdCents" BETWEEN 0 AND "listPriceUsdCents"
    AND "amountUsdCents" = "listPriceUsdCents" - "discountUsdCents"
    -- Stripe's minimum charge: $0 (fully discounted) or at least $0.50.
    AND ("amountUsdCents" = 0 OR "amountUsdCents" >= 50)
    AND ("discountSource" IS NULL) = ("discountUsdCents" = 0)
    AND ("discountOfferId" IS NOT NULL) = COALESCE("discountSource" IN ('CODE', 'CAMPAIGN'), false)
    AND "currency" = 'USD'
    -- Nothing to charge: no payment provider.
    AND ("provider" IS NULL) = ("amountUsdCents" = 0)
    AND ("provider" IS NULL OR "providerCustomerId" IS NOT NULL)
    AND length(btrim("idempotencyKey")) > 0
  ),
  ADD CONSTRAINT "CreditPackageOrder_status_facts" CHECK (
    CASE "status"
      WHEN 'CREATING' THEN "paidAt" IS NULL AND "closedAt" IS NULL AND "providerPaymentIntentId" IS NULL
      WHEN 'OPEN' THEN "providerSessionId" IS NOT NULL AND "paidAt" IS NULL AND "closedAt" IS NULL
        AND "providerPaymentIntentId" IS NULL
      WHEN 'PROCESSING' THEN "providerSessionId" IS NOT NULL AND "paidAt" IS NULL AND "closedAt" IS NULL
      WHEN 'PAID' THEN "paidAt" IS NOT NULL
        AND ("amountUsdCents" = 0) = ("providerPaymentIntentId" IS NULL)
      ELSE "closedAt" IS NOT NULL AND "closedReason" IS NOT NULL AND "paidAt" IS NULL
    END
  );

-- An order is created CREATING with the current terms of an available
-- package; its terms never change, its status only moves forward and it is
-- never deleted.
CREATE FUNCTION "CreditPackageOrder_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_credits integer;
  v_price integer;
  v_available boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Credit package orders cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'CREATING' OR NEW."authId" IS NULL THEN
      RAISE EXCEPTION 'A credit package order is created for a user, before any payment'
        USING ERRCODE = 'check_violation';
    END IF;
    EXECUTE format(
      'SELECT "credits", "priceUsdCents", "available" FROM %I."CreditPackage" WHERE "code" = $1',
      TG_TABLE_SCHEMA
    ) INTO v_credits, v_price, v_available USING NEW."packageCode";
    IF v_available IS NOT TRUE OR v_credits <> NEW."credits" OR v_price <> NEW."listPriceUsdCents" THEN
      RAISE EXCEPTION 'A credit package order must carry the current terms of an available package'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR (NEW."authId" IS DISTINCT FROM OLD."authId" AND NEW."authId" IS NOT NULL)
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."packageCode" IS DISTINCT FROM OLD."packageCode"
    OR NEW."credits" IS DISTINCT FROM OLD."credits"
    OR NEW."listPriceUsdCents" IS DISTINCT FROM OLD."listPriceUsdCents"
    OR NEW."discountSource" IS DISTINCT FROM OLD."discountSource"
    OR NEW."discountOfferId" IS DISTINCT FROM OLD."discountOfferId"
    OR NEW."discountPercent" IS DISTINCT FROM OLD."discountPercent"
    OR NEW."discountUsdCents" IS DISTINCT FROM OLD."discountUsdCents"
    OR NEW."amountUsdCents" IS DISTINCT FROM OLD."amountUsdCents"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."requestedDiscountCode" IS DISTINCT FROM OLD."requestedDiscountCode"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."providerCustomerId" IS DISTINCT FROM OLD."providerCustomerId"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR (OLD."providerSessionId" IS NOT NULL AND NEW."providerSessionId" IS DISTINCT FROM OLD."providerSessionId")
    OR (OLD."providerPaymentIntentId" IS NOT NULL AND NEW."providerPaymentIntentId" IS DISTINCT FROM OLD."providerPaymentIntentId")
    OR (OLD."paidAt" IS NOT NULL AND NEW."paidAt" IS DISTINCT FROM OLD."paidAt")
    OR (OLD."closedAt" IS NOT NULL AND (NEW."closedAt" IS DISTINCT FROM OLD."closedAt"
        OR NEW."closedReason" IS DISTINCT FROM OLD."closedReason"))
  THEN
    RAISE EXCEPTION 'The terms of a credit package order cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'CREATING' AND NEW."status" IN ('OPEN', 'PROCESSING', 'PAID', 'EXPIRED', 'FAILED', 'CANCELED'))
    OR (OLD."status" = 'OPEN' AND NEW."status" IN ('PROCESSING', 'PAID', 'EXPIRED', 'FAILED', 'CANCELED'))
    OR (OLD."status" = 'PROCESSING' AND NEW."status" IN ('PAID', 'FAILED'))
    OR (OLD."status" IN ('EXPIRED', 'FAILED', 'CANCELED') AND NEW."status" = 'PAID')
  ) THEN
    RAISE EXCEPTION 'Credit package order status cannot change from % to %', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditPackageOrder_protect"
  BEFORE INSERT OR UPDATE OR DELETE ON "CreditPackageOrder"
  FOR EACH ROW EXECUTE FUNCTION "CreditPackageOrder_protect"();

-- A PAID order has its credits (checked at commit, so the order and its
-- credits are written in one transaction).
CREATE FUNCTION "CreditPackageOrder_paid_has_credits"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF NEW."status" <> 'PAID' OR OLD."status" = 'PAID' THEN
    RETURN NULL;
  END IF;
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I."CreditAllocation"
       WHERE "authId" = $1 AND "source" = ''PURCHASE'' AND "sourceReference" = $2 AND "amount" = $3)',
    TG_TABLE_SCHEMA
  ) INTO v_ok USING NEW."authId", 'credit-package:' || NEW."id", NEW."credits";
  IF NOT v_ok THEN
    RAISE EXCEPTION 'A paid credit package order must grant its credits'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "CreditPackageOrder_paid_has_credits"
  AFTER UPDATE ON "CreditPackageOrder"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "CreditPackageOrder_paid_has_credits"();

-- Credits of an order (`credit-package:<order id>` PURCHASE credits) only
-- for a PAID order of the same user, for exactly its credits (one
-- allocation per reference).
CREATE FUNCTION "CreditAllocation_package_order_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF NEW."source" <> 'PURCHASE' OR NEW."sourceReference" NOT LIKE 'credit-package:%' THEN
    RETURN NEW;
  END IF;
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I."CreditPackageOrder"
       WHERE "id" = $1 AND "authId" = $2 AND "status" = ''PAID'' AND "credits" = $3)',
    TG_TABLE_SCHEMA
  ) INTO v_ok USING substring(NEW."sourceReference" FROM length('credit-package:') + 1), NEW."authId", NEW."amount";
  IF NOT v_ok THEN
    RAISE EXCEPTION 'Credit package credits require a paid order of the same user and credits'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditAllocation_package_order_check"
  BEFORE INSERT ON "CreditAllocation"
  FOR EACH ROW EXECUTE FUNCTION "CreditAllocation_package_order_check"();

-- ---------------------------------------------------------------------------
-- Paid purchases: Pro payments and paid credit package orders
-- ---------------------------------------------------------------------------

CREATE FUNCTION "musecue_has_paid_purchase"(p_schema text, p_auth text) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_paid boolean;
BEGIN
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %1$I."PaymentTransaction" p JOIN %1$I."UserSubscription" s ON s."id" = p."subscriptionId"
       WHERE s."authId" = $1 AND p."status" IN (''SUCCEEDED'', ''PARTIALLY_REFUNDED'', ''REFUNDED''))
     OR EXISTS (SELECT 1 FROM %1$I."CreditPackageOrder" o WHERE o."authId" = $1 AND o."status" = ''PAID'')',
    p_schema
  ) INTO v_paid USING p_auth;
  RETURN v_paid;
END;
$$;

-- Discounts: reserved for a Pro checkout or a package order (not both);
-- the first-purchase and referral discounts are not available after a paid
-- package purchase either.
ALTER TABLE "DiscountRedemption"
  ADD CONSTRAINT "DiscountRedemption_one_purchase" CHECK (
    "checkoutSessionId" IS NULL OR "packageOrderId" IS NULL
  );

CREATE OR REPLACE FUNCTION "DiscountRedemption_enforce_offer"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_active boolean;
  v_percent integer;
  v_starts timestamp(3);
  v_ends timestamp(3);
  v_audience text;
  v_customers text;
  v_products text[];
  v_min_spend integer;
  v_per_user integer;
  v_total integer;
  v_count integer;
  v_budget integer;
  v_spent integer;
  v_budget_reserved integer;
  v_used integer;
  v_targeted boolean;
  v_paid boolean;
  v_at timestamp(3);
  v_capacity_check boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Deleting an account deletes its redemptions: a reservation is given
    -- back; redeemed discounts stay counted.
    IF OLD."offerId" IS NOT NULL AND OLD."status" = 'RESERVED' THEN
      EXECUTE format('SELECT 1 FROM %I."DiscountOffer" WHERE "id" = $1 FOR UPDATE', TG_TABLE_SCHEMA)
        USING OLD."offerId";
      PERFORM "DiscountOffer_apply_counters"(TG_TABLE_SCHEMA, OLD."offerId", -1, -1, 0, -OLD."discountUsdCents");
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."offerId" IS DISTINCT FROM OLD."offerId"
      OR NEW."authId" IS DISTINCT FROM OLD."authId"
      OR NEW."source" IS DISTINCT FROM OLD."source"
      OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
      OR NEW."product" IS DISTINCT FROM OLD."product"
      OR NEW."packageCode" IS DISTINCT FROM OLD."packageCode"
      OR NEW."credits" IS DISTINCT FROM OLD."credits"
      OR NEW."discountPercent" IS DISTINCT FROM OLD."discountPercent"
      OR NEW."originalPriceUsdCents" IS DISTINCT FROM OLD."originalPriceUsdCents"
      OR NEW."discountUsdCents" IS DISTINCT FROM OLD."discountUsdCents"
      OR NEW."finalPriceUsdCents" IS DISTINCT FROM OLD."finalPriceUsdCents"
      OR NEW."reservedAt" IS DISTINCT FROM OLD."reservedAt"
      -- Only cleared when its checkout is deleted with the account.
      OR (NEW."checkoutSessionId" IS DISTINCT FROM OLD."checkoutSessionId" AND NEW."checkoutSessionId" IS NOT NULL)
      OR NEW."packageOrderId" IS DISTINCT FROM OLD."packageOrderId"
      OR (OLD."paymentId" IS NOT NULL AND NEW."paymentId" IS DISTINCT FROM OLD."paymentId")
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    THEN
      RAISE EXCEPTION 'Discount redemptions cannot be changed'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = OLD."status" THEN
      IF NEW."redeemedAt" IS DISTINCT FROM OLD."redeemedAt"
        OR NEW."releasedAt" IS DISTINCT FROM OLD."releasedAt"
        OR NEW."releaseReason" IS DISTINCT FROM OLD."releaseReason"
      THEN
        RAISE EXCEPTION 'Discount redemptions cannot be changed'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF NOT (
      (OLD."status" = 'RESERVED' AND NEW."status" IN ('REDEEMED', 'RELEASED'))
      OR (OLD."status" = 'RELEASED' AND NEW."status" = 'REDEEMED')
    ) THEN
      RAISE EXCEPTION 'Discount redemption status cannot change from % to %', OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."offerId" IS NULL THEN
      -- First-purchase and referral discounts: one-time use is the partial
      -- unique index.
      RETURN NEW;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'RELEASED' THEN
      RAISE EXCEPTION 'A discount redemption cannot be created released'
        USING ERRCODE = 'check_violation';
    END IF;
    v_paid := "musecue_has_paid_purchase"(TG_TABLE_SCHEMA, NEW."authId");
    IF NEW."offerId" IS NULL THEN
      IF v_paid THEN
        RAISE EXCEPTION 'The % discount is only available before the first paid purchase', NEW."source"
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  EXECUTE format(
    'SELECT "active", "discountPercent", "startsAt", "endsAt", "audience"::text,
            "customerEligibility"::text, "eligibleProducts"::text[], "minSpendCents",
            "maxRedemptionsPerUser", "maxTotalRedemptions", "redemptionCount",
            "budgetCents", "budgetSpentCents", "budgetReservedCents"
     FROM %I."DiscountOffer" WHERE "id" = $1 FOR UPDATE',
    TG_TABLE_SCHEMA
  ) INTO v_active, v_percent, v_starts, v_ends, v_audience, v_customers, v_products,
         v_min_spend, v_per_user, v_total, v_count, v_budget, v_spent, v_budget_reserved
    USING NEW."offerId";
  IF v_active IS NULL THEN
    RAISE EXCEPTION 'Unknown discount offer' USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Eligibility is decided when the discount is reserved (or redeemed).
    v_at := COALESCE(NEW."reservedAt", NEW."redeemedAt");
    IF NOT v_active OR v_percent = 0 THEN
      RAISE EXCEPTION 'The discount offer is not active' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."discountPercent" <> v_percent THEN
      RAISE EXCEPTION 'The redemption discount differs from the offer' USING ERRCODE = 'check_violation';
    END IF;
    IF v_at IS NULL OR v_at < v_starts OR v_at >= v_ends THEN
      RAISE EXCEPTION 'The discount offer is not running' USING ERRCODE = 'check_violation';
    END IF;
    IF v_audience = 'SELECTED_USERS' THEN
      EXECUTE format(
        'SELECT EXISTS (SELECT 1 FROM %I."DiscountOfferTarget" WHERE "offerId" = $1 AND "authId" = $2)',
        TG_TABLE_SCHEMA
      ) INTO v_targeted USING NEW."offerId", NEW."authId";
      IF NOT v_targeted THEN
        RAISE EXCEPTION 'The user is not eligible for the discount offer' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF (v_customers = 'NEW_CUSTOMERS' AND v_paid) OR (v_customers = 'RETURNING_CUSTOMERS' AND NOT v_paid) THEN
      RAISE EXCEPTION 'The user is not eligible for the discount offer' USING ERRCODE = 'check_violation';
    END IF;
    IF cardinality(v_products) > 0 AND NOT (NEW."product"::text = ANY (v_products)) THEN
      RAISE EXCEPTION 'The discount offer does not apply to this product' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."originalPriceUsdCents" < v_min_spend THEN
      RAISE EXCEPTION 'The purchase does not reach the minimum spend of the discount offer'
        USING ERRCODE = 'check_violation';
    END IF;
    v_capacity_check := true;
  ELSIF OLD."status" = 'RELEASED' THEN
    -- A late payment of a released reservation: counted again only if the
    -- limits and the budget still allow it.
    v_capacity_check := true;
  END IF;

  IF v_capacity_check THEN
    EXECUTE format(
      'SELECT count(*) FROM %I."DiscountRedemption"
       WHERE "offerId" = $1 AND "authId" = $2 AND "status" IN (''RESERVED'', ''REDEEMED'') AND "id" <> $3',
      TG_TABLE_SCHEMA
    ) INTO v_used USING NEW."offerId", NEW."authId", NEW."id";
    IF v_used >= v_per_user THEN
      RAISE EXCEPTION 'The user has reached the redemption limit of the discount offer'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_total IS NOT NULL AND v_count >= v_total THEN
      RAISE EXCEPTION 'The discount offer has no redemptions left' USING ERRCODE = 'check_violation';
    END IF;
    IF v_budget IS NOT NULL AND v_spent + v_budget_reserved + NEW."discountUsdCents" > v_budget THEN
      RAISE EXCEPTION 'The discount offer has no budget left' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'RESERVED' THEN
      PERFORM "DiscountOffer_apply_counters"(TG_TABLE_SCHEMA, NEW."offerId", 1, 1, 0, NEW."discountUsdCents");
    ELSE
      PERFORM "DiscountOffer_apply_counters"(TG_TABLE_SCHEMA, NEW."offerId", 1, 0, NEW."discountUsdCents", 0);
    END IF;
  ELSIF OLD."status" = 'RESERVED' AND NEW."status" = 'REDEEMED' THEN
    PERFORM "DiscountOffer_apply_counters"(TG_TABLE_SCHEMA, NEW."offerId", 0, -1, NEW."discountUsdCents", -NEW."discountUsdCents");
  ELSIF OLD."status" = 'RESERVED' AND NEW."status" = 'RELEASED' THEN
    PERFORM "DiscountOffer_apply_counters"(TG_TABLE_SCHEMA, NEW."offerId", -1, -1, 0, -NEW."discountUsdCents");
  ELSE -- RELEASED -> REDEEMED
    PERFORM "DiscountOffer_apply_counters"(TG_TABLE_SCHEMA, NEW."offerId", 1, 0, NEW."discountUsdCents", 0);
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Referrals qualified by a package purchase
-- ---------------------------------------------------------------------------

ALTER TABLE "Referral"
  DROP CONSTRAINT "Referral_status_facts",
  ADD CONSTRAINT "Referral_status_facts" CHECK (
    CASE "status"
      WHEN 'PENDING' THEN "qualifiedAt" IS NULL
        AND num_nonnulls("qualifyingPaymentId", "qualifyingPackageOrderId") = 0
        AND "rewardCredits" IS NULL AND "rewardedAt" IS NULL
        AND "holdReason" IS NULL AND "heldAt" IS NULL AND "reviewedAt" IS NULL
      WHEN 'REWARDED' THEN "qualifiedAt" IS NOT NULL
        AND num_nonnulls("qualifyingPaymentId", "qualifyingPackageOrderId") = 1
        AND "rewardCredits" > 0 AND "rewardedAt" IS NOT NULL
        AND ("heldAt" IS NULL) = ("reviewedAt" IS NULL)
      WHEN 'QUALIFIED' THEN "qualifiedAt" IS NOT NULL
        AND num_nonnulls("qualifyingPaymentId", "qualifyingPackageOrderId") = 1
        AND "rewardedAt" IS NULL
        AND ("heldAt" IS NULL) = ("reviewedAt" IS NULL)
        AND ("rewardCredits" IS NULL OR "heldAt" IS NOT NULL)
      WHEN 'HELD' THEN "qualifiedAt" IS NOT NULL
        AND num_nonnulls("qualifyingPaymentId", "qualifyingPackageOrderId") = 1
        AND "holdReason" IS NOT NULL AND "heldAt" IS NOT NULL
        AND "reviewedAt" IS NULL AND "rewardedAt" IS NULL
        AND ("rewardCredits" IS NULL OR "rewardCredits" > 0)
      WHEN 'REJECTED' THEN "qualifiedAt" IS NOT NULL
        AND num_nonnulls("qualifyingPaymentId", "qualifyingPackageOrderId") = 1
        AND "holdReason" IS NOT NULL AND "heldAt" IS NOT NULL
        AND "reviewedAt" IS NOT NULL AND "rewardedAt" IS NULL
    END
  );

CREATE OR REPLACE FUNCTION "Referral_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_paid boolean;
  v_created_here boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'A referral is created pending' USING ERRCODE = 'check_violation';
    END IF;
    -- Signup only: the referred account was created by this transaction.
    EXECUTE format(
      'SELECT xmin = pg_current_xact_id()::xid FROM %I."authUser" WHERE "id" = $1',
      TG_TABLE_SCHEMA
    ) INTO v_created_here USING NEW."authId";
    IF v_created_here IS NOT TRUE THEN
      RAISE EXCEPTION 'A referral can only be recorded when the account is created'
        USING ERRCODE = 'check_violation';
    END IF;
    v_paid := "musecue_has_paid_purchase"(TG_TABLE_SCHEMA, NEW."authId");
    IF v_paid THEN
      RAISE EXCEPTION 'A referral cannot be recorded after a paid purchase'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."authId" IS DISTINCT FROM OLD."authId"
    OR (NEW."referrerAuthId" IS DISTINCT FROM OLD."referrerAuthId" AND NEW."referrerAuthId" IS NOT NULL)
    OR NEW."referralCode" IS DISTINCT FROM OLD."referralCode"
    OR NEW."canonicalEmailHash" IS DISTINCT FROM OLD."canonicalEmailHash"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'A referral cannot be changed' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    IF NEW."qualifyingPaymentId" IS DISTINCT FROM OLD."qualifyingPaymentId"
      OR NEW."qualifyingPackageOrderId" IS DISTINCT FROM OLD."qualifyingPackageOrderId"
      OR NEW."qualifiedAt" IS DISTINCT FROM OLD."qualifiedAt"
      OR NEW."rewardCredits" IS DISTINCT FROM OLD."rewardCredits"
      OR NEW."rewardedAt" IS DISTINCT FROM OLD."rewardedAt"
      OR NEW."holdReason" IS DISTINCT FROM OLD."holdReason"
      OR NEW."heldAt" IS DISTINCT FROM OLD."heldAt"
      OR NEW."reviewedAt" IS DISTINCT FROM OLD."reviewedAt"
      OR NEW."reviewedBy" IS DISTINCT FROM OLD."reviewedBy"
    THEN
      RAISE EXCEPTION 'A referral cannot be changed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'PENDING' AND NEW."status" IN ('REWARDED', 'QUALIFIED', 'HELD') THEN
    IF NEW."reviewedAt" IS NOT NULL OR NEW."reviewedBy" IS NOT NULL THEN
      RAISE EXCEPTION 'A referral is reviewed only after it was held' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'HELD' AND NEW."status" IN ('REWARDED', 'QUALIFIED', 'REJECTED') THEN
    -- The review keeps every fact of the hold, including the held reward.
    IF NEW."qualifyingPaymentId" IS DISTINCT FROM OLD."qualifyingPaymentId"
      OR NEW."qualifyingPackageOrderId" IS DISTINCT FROM OLD."qualifyingPackageOrderId"
      OR NEW."qualifiedAt" IS DISTINCT FROM OLD."qualifiedAt"
      OR NEW."holdReason" IS DISTINCT FROM OLD."holdReason"
      OR NEW."heldAt" IS DISTINCT FROM OLD."heldAt"
      OR NEW."rewardCredits" IS DISTINCT FROM OLD."rewardCredits"
    THEN
      RAISE EXCEPTION 'A held referral keeps its facts when it is reviewed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A referral is rewarded or qualified only once'
    USING ERRCODE = 'check_violation';
END;
$$;
