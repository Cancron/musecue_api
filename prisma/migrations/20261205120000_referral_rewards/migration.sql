-- Referral registration at signup and referral rewards, and free (100%)
-- first payments.
--
-- PostgreSQL enforces, independently of the application:
-- - a person is referred once (unique canonical email hash, unique authId),
--   never by themselves, and never after a paid purchase;
-- - a referral only moves PENDING -> REWARDED | QUALIFIED, once, with the
--   payment that qualified it, and its facts never change;
-- - referral reward credits (`referral-reward:<referral id>`) exist only for
--   a REWARDED referral of that referrer and exactly its reward, so a reward
--   can never be granted twice or without a qualifying purchase;
-- - a 100% discount makes the first payment exactly $0 (never Stripe's $0.50
--   minimum): a SUCCEEDED payment may be $0, and a discounted first charge
--   is $0 or at least $0.50.

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'REWARDED', 'QUALIFIED');

-- DropIndex
DROP INDEX "Referral_referrerAuthId_idx";

-- AlterTable (a surrogate id, so referrals can be listed without user ids)
ALTER TABLE "Referral" DROP CONSTRAINT "Referral_pkey",
ADD COLUMN     "canonicalEmailHash" CHAR(64),
ADD COLUMN     "id" TEXT,
ADD COLUMN     "qualifiedAt" TIMESTAMP(3),
ADD COLUMN     "qualifyingPaymentId" TEXT,
ADD COLUMN     "referralCode" VARCHAR(16),
ADD COLUMN     "rewardCredits" INTEGER,
ADD COLUMN     "rewardedAt" TIMESTAMP(3),
ADD COLUMN     "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING';

UPDATE "Referral" SET "id" = gen_random_uuid()::text WHERE "id" IS NULL;

ALTER TABLE "Referral"
  ALTER COLUMN "id" SET NOT NULL,
  ADD CONSTRAINT "Referral_pkey" PRIMARY KEY ("id");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_authId_key" ON "Referral"("authId");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_canonicalEmailHash_key" ON "Referral"("canonicalEmailHash");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_qualifyingPaymentId_key" ON "Referral"("qualifyingPaymentId");

-- CreateIndex
CREATE INDEX "Referral_referrerAuthId_createdAt_idx" ON "Referral"("referrerAuthId", "createdAt");

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_qualifyingPaymentId_fkey" FOREIGN KEY ("qualifyingPaymentId") REFERENCES "PaymentTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Referral"
  ADD CONSTRAINT "Referral_canonicalEmailHash_format"
    CHECK ("canonicalEmailHash" IS NULL OR "canonicalEmailHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "Referral_status_facts" CHECK (
    CASE "status"
      WHEN 'PENDING' THEN "qualifiedAt" IS NULL AND "qualifyingPaymentId" IS NULL
        AND "rewardCredits" IS NULL AND "rewardedAt" IS NULL
      WHEN 'REWARDED' THEN "qualifiedAt" IS NOT NULL AND "qualifyingPaymentId" IS NOT NULL
        AND "rewardCredits" > 0 AND "rewardedAt" IS NOT NULL
      WHEN 'QUALIFIED' THEN "qualifiedAt" IS NOT NULL AND "qualifyingPaymentId" IS NOT NULL
        AND "rewardCredits" IS NULL AND "rewardedAt" IS NULL
    END
  );

-- Referrals: created only before the referred user's first paid purchase;
-- afterwards only the status moves, once, forward. The referrer link is only
-- cleared (by ON DELETE SET NULL) when the referrer's account is deleted.
CREATE FUNCTION "Referral_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_paid boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'A referral is created pending' USING ERRCODE = 'check_violation';
    END IF;
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I."PaymentTransaction" p JOIN %I."UserSubscription" s ON s."id" = p."subscriptionId"
         WHERE s."authId" = $1 AND p."status" IN (''SUCCEEDED'', ''PARTIALLY_REFUNDED'', ''REFUNDED''))',
      TG_TABLE_SCHEMA, TG_TABLE_SCHEMA
    ) INTO v_paid USING NEW."authId";
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
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF OLD."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'A referral is rewarded or qualified only once' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."qualifyingPaymentId" IS DISTINCT FROM OLD."qualifyingPaymentId"
    OR NEW."qualifiedAt" IS DISTINCT FROM OLD."qualifiedAt"
    OR NEW."rewardCredits" IS DISTINCT FROM OLD."rewardCredits"
    OR NEW."rewardedAt" IS DISTINCT FROM OLD."rewardedAt"
  THEN
    RAISE EXCEPTION 'A referral cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Referral_protect"
  BEFORE INSERT OR UPDATE ON "Referral"
  FOR EACH ROW EXECUTE FUNCTION "Referral_protect"();

-- Referral reward credits (`referral-reward:<referral id>`) only for the
-- referrer of a REWARDED referral, for exactly its reward.
CREATE FUNCTION "CreditAllocation_referral_reward_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_referral text;
  v_ok boolean;
BEGIN
  IF NEW."source" <> 'REFERRAL' OR NEW."sourceReference" NOT LIKE 'referral-reward:%' THEN
    RETURN NEW;
  END IF;
  v_referral := substring(NEW."sourceReference" FROM length('referral-reward:') + 1);
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I."Referral"
       WHERE "id" = $1 AND "referrerAuthId" = $2 AND "status" = ''REWARDED'' AND "rewardCredits" = $3)',
    TG_TABLE_SCHEMA
  ) INTO v_ok USING v_referral, NEW."authId", NEW."amount";
  IF NOT v_ok THEN
    RAISE EXCEPTION 'Referral reward credits require a rewarded referral of the same referrer and amount'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditAllocation_referral_reward_check"
  BEFORE INSERT ON "CreditAllocation"
  FOR EACH ROW EXECUTE FUNCTION "CreditAllocation_referral_reward_check"();

-- A 100% discount: the first payment is exactly $0. Only a collected
-- (SUCCEEDED) payment can be $0; every other payment stays positive.
ALTER TABLE "PaymentTransaction"
  DROP CONSTRAINT "PaymentTransaction_amount_positive",
  ADD CONSTRAINT "PaymentTransaction_amount_positive" CHECK (
    "amountCents" > 0 OR ("amountCents" = 0 AND "status" = 'SUCCEEDED')
  );

-- A discounted first charge is $0 (waived) or at least Stripe's $0.50
-- minimum; it is never rounded up to the minimum.
ALTER TABLE "CheckoutSession"
  DROP CONSTRAINT "CheckoutSession_discount_consistent",
  ADD CONSTRAINT "CheckoutSession_discount_consistent" CHECK (
    "discountPercent" BETWEEN 0 AND 100
    AND "discountCents" >= 0
    AND "discountCents" <= "amountCents"
    AND ("discountSource" IS NULL) = ("discountCents" = 0)
    AND ("discountOfferId" IS NOT NULL) = ("discountSource" IN ('CODE', 'CAMPAIGN'))
    AND ("discountCents" = 0
         OR "amountCents" - "discountCents" = 0
         OR "amountCents" - "discountCents" >= 50)
  );
