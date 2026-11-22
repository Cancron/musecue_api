-- Discount codes and promotional campaigns, configured by administrators,
-- and their redemptions. A redemption prices one credit package with the
-- offer's discount and counts towards the offer's limits.
--
-- Every rule is enforced twice: by the application (under a lock of the
-- offer row, with clear error messages) and by PostgreSQL, so concurrent
-- requests or other write paths can never exceed a limit or count a
-- redemption twice:
-- - the redemption trigger locks the offer row, re-checks that the offer is
--   active (discount above 0%), running, and open to the user, that the
--   user's and the total limit are not reached, and then increments the
--   offer's redemptionCount;
-- - (authId, idempotencyKey) is unique, so a retried or duplicated request
--   is stored once;
-- - CHECK constraints keep every offer and redemption consistent.

-- CreateEnum
CREATE TYPE "DiscountOfferKind" AS ENUM ('CODE', 'CAMPAIGN');

-- CreateEnum
CREATE TYPE "DiscountAudience" AS ENUM ('ALL_USERS', 'SELECTED_USERS');

-- CreateTable
CREATE TABLE "DiscountOffer" (
    "id" TEXT NOT NULL,
    "kind" "DiscountOfferKind" NOT NULL,
    "code" VARCHAR(32),
    "name" VARCHAR(100) NOT NULL,
    "discountPercent" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "audience" "DiscountAudience" NOT NULL DEFAULT 'ALL_USERS',
    "maxRedemptionsPerUser" INTEGER NOT NULL DEFAULT 1,
    "maxTotalRedemptions" INTEGER,
    "redemptionCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

CONSTRAINT "DiscountOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountOfferTarget" (
    "offerId" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "DiscountOfferTarget_pkey" PRIMARY KEY ("offerId","authId")
);

-- CreateTable
CREATE TABLE "DiscountRedemption" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "packageCode" "CreditPackageCode" NOT NULL,
    "credits" INTEGER NOT NULL,
    "discountPercent" INTEGER NOT NULL,
    "originalPriceUsdCents" INTEGER NOT NULL,
    "discountUsdCents" INTEGER NOT NULL,
    "finalPriceUsdCents" INTEGER NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "DiscountRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiscountOffer_code_key" ON "DiscountOffer"("code");

-- CreateIndex
CREATE INDEX "DiscountOffer_kind_createdAt_idx" ON "DiscountOffer"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "DiscountOfferTarget_authId_idx" ON "DiscountOfferTarget"("authId");

-- CreateIndex
CREATE INDEX "DiscountRedemption_offerId_authId_idx" ON "DiscountRedemption"("offerId", "authId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountRedemption_authId_idempotencyKey_key" ON "DiscountRedemption"("authId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "DiscountOfferTarget" ADD CONSTRAINT "DiscountOfferTarget_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "DiscountOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountOfferTarget" ADD CONSTRAINT "DiscountOfferTarget_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountRedemption" ADD CONSTRAINT "DiscountRedemption_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "DiscountOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountRedemption" ADD CONSTRAINT "DiscountRedemption_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DiscountOffer"
  ADD CONSTRAINT "DiscountOffer_code_by_kind" CHECK (("kind" = 'CODE') = ("code" IS NOT NULL)),
  ADD CONSTRAINT "DiscountOffer_code_format"
    CHECK ("code" IS NULL OR "code" ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
  ADD CONSTRAINT "DiscountOffer_name_present" CHECK (btrim("name") <> ''),
  ADD CONSTRAINT "DiscountOffer_discountPercent_range" CHECK ("discountPercent" BETWEEN 0 AND 100),
  ADD CONSTRAINT "DiscountOffer_period_order" CHECK ("endsAt" > "startsAt"),
  ADD CONSTRAINT "DiscountOffer_maxRedemptionsPerUser_positive" CHECK ("maxRedemptionsPerUser" >= 1),
  ADD CONSTRAINT "DiscountOffer_maxTotalRedemptions_positive"
    CHECK ("maxTotalRedemptions" IS NULL OR "maxTotalRedemptions" >= 1),
  ADD CONSTRAINT "DiscountOffer_redemptionCount_within_limit"
    CHECK ("redemptionCount" >= 0
           AND ("maxTotalRedemptions" IS NULL OR "redemptionCount" <= "maxTotalRedemptions"));

ALTER TABLE "DiscountRedemption"
  ADD CONSTRAINT "DiscountRedemption_idempotencyKey_present" CHECK (btrim("idempotencyKey") <> ''),
  ADD CONSTRAINT "DiscountRedemption_credits_positive" CHECK ("credits" > 0),
  ADD CONSTRAINT "DiscountRedemption_discountPercent_range" CHECK ("discountPercent" BETWEEN 1 AND 100),
  ADD CONSTRAINT "DiscountRedemption_price_terms" CHECK (
    "originalPriceUsdCents" > 0
    AND "discountUsdCents" >= 0
    AND "finalPriceUsdCents" >= 0
    AND "originalPriceUsdCents" = "discountUsdCents" + "finalPriceUsdCents"
  );

-- An offer's kind and code never change, and its redemption count only
-- grows (it also counts redemptions of deleted accounts, so a depleted
-- offer stays depleted).
CREATE FUNCTION "DiscountOffer_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."code" IS DISTINCT FROM OLD."code" THEN
    RAISE EXCEPTION 'The kind and code of a discount offer cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."redemptionCount" < OLD."redemptionCount" THEN
    RAISE EXCEPTION 'The redemption count of a discount offer cannot decrease'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "DiscountOffer_protect"
  BEFORE UPDATE ON "DiscountOffer"
  FOR EACH ROW EXECUTE FUNCTION "DiscountOffer_protect"();

-- Enforces every redemption rule under a lock of the offer row, so
-- concurrent redemptions of one offer are checked one at a time, then
-- counts the redemption.
CREATE FUNCTION "DiscountRedemption_enforce_offer"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_active boolean;
  v_percent integer;
  v_starts timestamp(3);
  v_ends timestamp(3);
  v_audience text;
  v_per_user integer;
  v_total integer;
  v_count integer;
  v_used integer;
  v_targeted boolean;
BEGIN
  EXECUTE format(
    'SELECT "active", "discountPercent", "startsAt", "endsAt", "audience"::text,
            "maxRedemptionsPerUser", "maxTotalRedemptions", "redemptionCount"
     FROM %I."DiscountOffer" WHERE "id" = $1 FOR UPDATE',
    TG_TABLE_SCHEMA
  ) INTO v_active, v_percent, v_starts, v_ends, v_audience, v_per_user, v_total, v_count
    USING NEW."offerId";

  IF v_active IS NULL THEN
    RAISE EXCEPTION 'Unknown discount offer' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NOT v_active OR v_percent = 0 THEN
    RAISE EXCEPTION 'The discount offer is not active' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."discountPercent" <> v_percent THEN
    RAISE EXCEPTION 'The redemption discount differs from the offer' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."redeemedAt" < v_starts OR NEW."redeemedAt" >= v_ends THEN
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
  EXECUTE format(
    'SELECT count(*) FROM %I."DiscountRedemption" WHERE "offerId" = $1 AND "authId" = $2',
    TG_TABLE_SCHEMA
  ) INTO v_used USING NEW."offerId", NEW."authId";
  IF v_used >= v_per_user THEN
    RAISE EXCEPTION 'The user has reached the redemption limit of the discount offer'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_total IS NOT NULL AND v_count >= v_total THEN
    RAISE EXCEPTION 'The discount offer has no redemptions left' USING ERRCODE = 'check_violation';
  END IF;

  EXECUTE format(
    'UPDATE %I."DiscountOffer" SET "redemptionCount" = "redemptionCount" + 1 WHERE "id" = $1',
    TG_TABLE_SCHEMA
  ) USING NEW."offerId";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "DiscountRedemption_enforce_offer"
  BEFORE INSERT ON "DiscountRedemption"
  FOR EACH ROW EXECUTE FUNCTION "DiscountRedemption_enforce_offer"();

-- Redemptions are history: they never change (deleting the user deletes
-- them; the offer keeps counting them).
CREATE FUNCTION "DiscountRedemption_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Discount redemptions cannot be changed'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "DiscountRedemption_immutable"
  BEFORE UPDATE ON "DiscountRedemption"
  FOR EACH ROW EXECUTE FUNCTION "DiscountRedemption_immutable"();
