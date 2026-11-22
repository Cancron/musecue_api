-- Discounts in the Stripe checkout, referrals and campaign budget controls.
--
-- A checkout gets the best available discount (first purchase, referral,
-- an entered code or a running campaign). It is RESERVED as a
-- DiscountRedemption with the checkout, REDEEMED when the checkout's payment
-- is recorded and RELEASED only once the checkout can no longer be paid.
-- PostgreSQL enforces, independently of the application:
-- - a user uses the first-purchase and the referral discount at most once,
--   and only before their first successful paid purchase;
-- - an offer's redemptions (RESERVED + REDEEMED) never exceed its total and
--   per-user limits, and its discounts (spent + reserved) never exceed its
--   USD budget, checked under a lock of the offer row, so concurrent
--   checkouts cannot exceed either;
-- - offer eligibility at the time of the reservation: active, running,
--   targeted user, new/returning customer, eligible product, minimum spend;
-- - the counters only change with the redemptions, and redemptions only
--   change status (forward, or RELEASED -> REDEEMED for a late payment).

-- CreateEnum
CREATE TYPE "DiscountSource" AS ENUM ('FIRST_PURCHASE', 'REFERRAL', 'CODE', 'CAMPAIGN');

-- CreateEnum
CREATE TYPE "DiscountRedemptionStatus" AS ENUM ('RESERVED', 'REDEEMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "DiscountProduct" AS ENUM ('PRO_MONTHLY', 'PRO_YEARLY', 'CREDITS_SMALL', 'CREDITS_MEDIUM', 'CREDITS_LARGE');

-- CreateEnum
CREATE TYPE "DiscountCustomerEligibility" AS ENUM ('ALL_CUSTOMERS', 'NEW_CUSTOMERS', 'RETURNING_CUSTOMERS');

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "discountCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "discountOfferId" TEXT,
ADD COLUMN     "discountPercent" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "discountSource" "DiscountSource",
ADD COLUMN     "requestedDiscountCode" VARCHAR(32);

-- AlterTable
ALTER TABLE "DiscountOffer" ADD COLUMN     "budgetCents" INTEGER,
ADD COLUMN     "budgetReservedCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "budgetSpentCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "customerEligibility" "DiscountCustomerEligibility" NOT NULL DEFAULT 'ALL_CUSTOMERS',
ADD COLUMN     "eligibleProducts" "DiscountProduct"[] DEFAULT ARRAY[]::"DiscountProduct"[],
ADD COLUMN     "minSpendCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reservedCount" INTEGER NOT NULL DEFAULT 0;

-- The old redemption triggers are replaced below; drop them before the
-- existing rows are backfilled (they refused every update).
DROP TRIGGER "DiscountRedemption_immutable" ON "DiscountRedemption";
DROP FUNCTION "DiscountRedemption_immutable"();
DROP TRIGGER "DiscountRedemption_enforce_offer" ON "DiscountRedemption";

-- AlterTable (the new NOT NULL columns are backfilled first: every existing
-- redemption is a code or campaign redeemed for a credit package)
ALTER TABLE "DiscountRedemption" ADD COLUMN     "checkoutSessionId" TEXT,
ADD COLUMN     "paymentId" TEXT,
ADD COLUMN     "product" "DiscountProduct",
ADD COLUMN     "releaseReason" VARCHAR(50),
ADD COLUMN     "releasedAt" TIMESTAMP(3),
ADD COLUMN     "reservedAt" TIMESTAMP(3),
ADD COLUMN     "source" "DiscountSource",
ADD COLUMN     "status" "DiscountRedemptionStatus" NOT NULL DEFAULT 'REDEEMED',
ALTER COLUMN "offerId" DROP NOT NULL,
ALTER COLUMN "packageCode" DROP NOT NULL,
ALTER COLUMN "credits" DROP NOT NULL,
ALTER COLUMN "redeemedAt" DROP NOT NULL;

UPDATE "DiscountRedemption" r
SET "source" = (CASE o."kind" WHEN 'CODE' THEN 'CODE' ELSE 'CAMPAIGN' END)::"DiscountSource",
    "product" = ('CREDITS_' || r."packageCode"::text)::"DiscountProduct"
FROM "DiscountOffer" o
WHERE o."id" = r."offerId";

ALTER TABLE "DiscountRedemption"
  ALTER COLUMN "product" SET NOT NULL,
  ALTER COLUMN "source" SET NOT NULL;

-- Discounts already redeemed count towards a budget set later.
UPDATE "DiscountOffer" o
SET "budgetSpentCents" = spent."total"
FROM (
  SELECT "offerId", SUM("discountUsdCents")::integer AS "total"
  FROM "DiscountRedemption" GROUP BY "offerId"
) spent
WHERE spent."offerId" = o."id";

-- CreateTable
CREATE TABLE "ReferralCode" (
    "authId" TEXT NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("authId")
);

-- CreateTable
CREATE TABLE "Referral" (
    "authId" TEXT NOT NULL,
    "referrerAuthId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("authId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCode_code_key" ON "ReferralCode"("code");

-- CreateIndex
CREATE INDEX "Referral_referrerAuthId_idx" ON "Referral"("referrerAuthId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountRedemption_checkoutSessionId_key" ON "DiscountRedemption"("checkoutSessionId");

-- CreateIndex
CREATE INDEX "DiscountRedemption_authId_source_idx" ON "DiscountRedemption"("authId", "source");

-- AddForeignKey
ALTER TABLE "DiscountRedemption" ADD CONSTRAINT "DiscountRedemption_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "CheckoutSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountRedemption" ADD CONSTRAINT "DiscountRedemption_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "PaymentTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCode" ADD CONSTRAINT "ReferralCode_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerAuthId_fkey" FOREIGN KEY ("referrerAuthId") REFERENCES "authUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_discountOfferId_fkey" FOREIGN KEY ("discountOfferId") REFERENCES "DiscountOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------

ALTER TABLE "DiscountOffer"
  ADD CONSTRAINT "DiscountOffer_eligibleProducts_present" CHECK ("eligibleProducts" IS NOT NULL),
  ADD CONSTRAINT "DiscountOffer_minSpendCents_non_negative" CHECK ("minSpendCents" >= 0),
  ADD CONSTRAINT "DiscountOffer_budgetCents_positive" CHECK ("budgetCents" IS NULL OR "budgetCents" >= 1),
  ADD CONSTRAINT "DiscountOffer_budget_within_limit" CHECK (
    "budgetSpentCents" >= 0 AND "budgetReservedCents" >= 0
    AND ("budgetCents" IS NULL OR "budgetSpentCents" + "budgetReservedCents" <= "budgetCents")
  ),
  ADD CONSTRAINT "DiscountOffer_reservedCount_range" CHECK (
    "reservedCount" >= 0 AND "reservedCount" <= "redemptionCount"
  );

ALTER TABLE "DiscountRedemption"
  ADD CONSTRAINT "DiscountRedemption_offer_by_source" CHECK (
    ("offerId" IS NULL) = ("source" IN ('FIRST_PURCHASE', 'REFERRAL'))
  ),
  ADD CONSTRAINT "DiscountRedemption_package_by_product" CHECK (
    ("packageCode" IS NULL) = ("product" IN ('PRO_MONTHLY', 'PRO_YEARLY'))
    AND ("credits" IS NULL) = ("packageCode" IS NULL)
  ),
  ADD CONSTRAINT "DiscountRedemption_status_dates" CHECK (
    CASE "status"
      WHEN 'RESERVED' THEN "reservedAt" IS NOT NULL AND "redeemedAt" IS NULL AND "releasedAt" IS NULL
      WHEN 'REDEEMED' THEN "redeemedAt" IS NOT NULL
      WHEN 'RELEASED' THEN "releasedAt" IS NOT NULL AND "redeemedAt" IS NULL
    END
  );

-- A user uses the first-purchase and the referral discount at most once.
CREATE UNIQUE INDEX "DiscountRedemption_one_settings_discount_per_user"
  ON "DiscountRedemption" ("authId", "source")
  WHERE "source" IN ('FIRST_PURCHASE', 'REFERRAL') AND "status" IN ('RESERVED', 'REDEEMED');

ALTER TABLE "CheckoutSession"
  ADD CONSTRAINT "CheckoutSession_discount_consistent" CHECK (
    "discountPercent" BETWEEN 0 AND 100
    AND "discountCents" >= 0
    AND ("discountSource" IS NULL) = ("discountCents" = 0)
    AND ("discountOfferId" IS NOT NULL) = ("discountSource" IN ('CODE', 'CAMPAIGN'))
    -- Stripe's minimum charge: a discounted first payment is at least $0.50.
    AND ("discountCents" = 0 OR "amountCents" - "discountCents" >= 50)
  );

ALTER TABLE "ReferralCode"
  ADD CONSTRAINT "ReferralCode_code_format" CHECK ("code" ~ '^[A-Z0-9]{6,16}$');

ALTER TABLE "Referral"
  ADD CONSTRAINT "Referral_not_self" CHECK ("referrerAuthId" IS NULL OR "referrerAuthId" <> "authId");

-- A checkout's discount is fixed with the checkout.
CREATE FUNCTION "CheckoutSession_discount_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."discountSource" IS DISTINCT FROM OLD."discountSource"
    OR NEW."discountOfferId" IS DISTINCT FROM OLD."discountOfferId"
    OR NEW."discountPercent" IS DISTINCT FROM OLD."discountPercent"
    OR NEW."discountCents" IS DISTINCT FROM OLD."discountCents"
    OR NEW."requestedDiscountCode" IS DISTINCT FROM OLD."requestedDiscountCode"
  THEN
    RAISE EXCEPTION 'The discount of a checkout cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CheckoutSession_discount_protect"
  BEFORE UPDATE ON "CheckoutSession"
  FOR EACH ROW EXECUTE FUNCTION "CheckoutSession_discount_protect"();

-- An offer's kind and code never change, and its counters only change with
-- its redemptions (the redemption trigger sets musecue.discount_counters).
CREATE OR REPLACE FUNCTION "DiscountOffer_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."code" IS DISTINCT FROM OLD."code" THEN
    RAISE EXCEPTION 'The kind and code of a discount offer cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."redemptionCount" IS DISTINCT FROM OLD."redemptionCount"
      OR NEW."reservedCount" IS DISTINCT FROM OLD."reservedCount"
      OR NEW."budgetSpentCents" IS DISTINCT FROM OLD."budgetSpentCents"
      OR NEW."budgetReservedCents" IS DISTINCT FROM OLD."budgetReservedCents")
    AND COALESCE(current_setting('musecue.discount_counters', true), 'off') <> 'on'
  THEN
    RAISE EXCEPTION 'The redemption counters of a discount offer cannot decrease or change outside its redemptions'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Redemption rules
-- ---------------------------------------------------------------------------

CREATE FUNCTION "DiscountOffer_apply_counters"(
  p_schema text, p_offer text, p_count integer, p_reserved integer,
  p_spent integer, p_budget_reserved integer
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('musecue.discount_counters', 'on', true);
  EXECUTE format(
    'UPDATE %I."DiscountOffer"
     SET "redemptionCount" = "redemptionCount" + $2,
         "reservedCount" = "reservedCount" + $3,
         "budgetSpentCents" = "budgetSpentCents" + $4,
         "budgetReservedCents" = "budgetReservedCents" + $5
     WHERE "id" = $1',
    p_schema
  ) USING p_offer, p_count, p_reserved, p_spent, p_budget_reserved;
  PERFORM set_config('musecue.discount_counters', 'off', true);
END;
$$;

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
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I."PaymentTransaction" p JOIN %I."UserSubscription" s ON s."id" = p."subscriptionId"
         WHERE s."authId" = $1 AND p."status" IN (''SUCCEEDED'', ''PARTIALLY_REFUNDED'', ''REFUNDED''))',
      TG_TABLE_SCHEMA, TG_TABLE_SCHEMA
    ) INTO v_paid USING NEW."authId";
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

CREATE TRIGGER "DiscountRedemption_enforce_offer"
  BEFORE INSERT OR UPDATE OR DELETE ON "DiscountRedemption"
  FOR EACH ROW EXECUTE FUNCTION "DiscountRedemption_enforce_offer"();
