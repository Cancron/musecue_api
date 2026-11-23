-- Credit package gifts and the fulfillment outbox.
--
-- - Gifts: an invitation with the package terms locked, accepted or declined
--   by the recipient before the sender pays; only an accepted gift can be
--   paid; a paid gift is delivered once as GIFT credits of the recipient.
-- - Fulfillment: every paid order (self purchase or gift) gets a
--   CreditFulfillment in the transaction that records its verified payment;
--   credits are granted from it, once, by a worker that survives crashes,
--   restarts and duplicate processes. PAID orders always have one, and a
--   SUCCEEDED fulfillment always has its credits (checked at commit).

-- CreateEnum
CREATE TYPE "CreditPackageOrderKind" AS ENUM ('SELF', 'GIFT');

-- CreateEnum
CREATE TYPE "CreditGiftStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELED', 'PAID', 'DELIVERED', 'REVIEW', 'REJECTED');

-- CreateEnum
CREATE TYPE "CreditFulfillmentStatus" AS ENUM ('PENDING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'HELD', 'REJECTED');

-- AlterTable
ALTER TABLE "CreditPackageOrder" ADD COLUMN     "giftId" TEXT,
ADD COLUMN     "kind" "CreditPackageOrderKind" NOT NULL DEFAULT 'SELF';

-- AlterTable
ALTER TABLE "NotificationPreference" ADD COLUMN     "emailGifts" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "CreditGift" (
    "id" TEXT NOT NULL,
    "senderAuthId" TEXT,
    "recipientAuthId" TEXT,
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "packageCode" "CreditPackageCode" NOT NULL,
    "credits" INTEGER NOT NULL,
    "listPriceUsdCents" INTEGER NOT NULL,
    "message" VARCHAR(280),
    "deliverAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "CreditGiftStatus" NOT NULL DEFAULT 'PENDING',
    "acceptedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "reviewReason" VARCHAR(50),
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditGift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditFulfillment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" "CreditPackageOrderKind" NOT NULL,
    "recipientAuthId" TEXT,
    "source" "CreditSource" NOT NULL,
    "creditReference" VARCHAR(255) NOT NULL,
    "credits" INTEGER NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "CreditFulfillmentStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "lastAttemptAt" TIMESTAMP(3),
    "lastErrorCode" VARCHAR(100),
    "holdReason" VARCHAR(50),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditFulfillment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditFulfillmentEvent" (
    "id" TEXT NOT NULL,
    "fulfillmentId" TEXT NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "status" "CreditFulfillmentStatus" NOT NULL,
    "detail" VARCHAR(200),
    "actor" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditFulfillmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditGift_senderAuthId_createdAt_idx" ON "CreditGift"("senderAuthId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditGift_recipientAuthId_createdAt_idx" ON "CreditGift"("recipientAuthId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditGift_status_expiresAt_idx" ON "CreditGift"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditGift_senderAuthId_idempotencyKey_key" ON "CreditGift"("senderAuthId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "CreditFulfillment_orderId_key" ON "CreditFulfillment"("orderId");

-- CreateIndex
CREATE INDEX "CreditFulfillment_status_nextAttemptAt_idx" ON "CreditFulfillment"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "CreditFulfillmentEvent_fulfillmentId_createdAt_idx" ON "CreditFulfillmentEvent"("fulfillmentId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditPackageOrder_giftId_idx" ON "CreditPackageOrder"("giftId");

-- AddForeignKey
ALTER TABLE "CreditGift" ADD CONSTRAINT "CreditGift_senderAuthId_fkey" FOREIGN KEY ("senderAuthId") REFERENCES "authUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditGift" ADD CONSTRAINT "CreditGift_recipientAuthId_fkey" FOREIGN KEY ("recipientAuthId") REFERENCES "authUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditFulfillment" ADD CONSTRAINT "CreditFulfillment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CreditPackageOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditFulfillment" ADD CONSTRAINT "CreditFulfillment_recipientAuthId_fkey" FOREIGN KEY ("recipientAuthId") REFERENCES "authUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditFulfillmentEvent" ADD CONSTRAINT "CreditFulfillmentEvent_fulfillmentId_fkey" FOREIGN KEY ("fulfillmentId") REFERENCES "CreditFulfillment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditPackageOrder" ADD CONSTRAINT "CreditPackageOrder_giftId_fkey" FOREIGN KEY ("giftId") REFERENCES "CreditGift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Gifts
-- ---------------------------------------------------------------------------

ALTER TABLE "CreditGift"
  ADD CONSTRAINT "CreditGift_terms" CHECK (
    "credits" > 0 AND "listPriceUsdCents" > 0
    AND "expiresAt" > "createdAt"
    AND length(btrim("idempotencyKey")) > 0
    AND ("senderAuthId" IS NULL OR "recipientAuthId" IS NULL OR "senderAuthId" <> "recipientAuthId")
  ),
  ADD CONSTRAINT "CreditGift_status_facts" CHECK (
    CASE "status"
      WHEN 'PENDING' THEN "acceptedAt" IS NULL AND "paidAt" IS NULL
      WHEN 'ACCEPTED' THEN "acceptedAt" IS NOT NULL AND "paidAt" IS NULL
      WHEN 'DECLINED' THEN "declinedAt" IS NOT NULL AND "paidAt" IS NULL
      WHEN 'EXPIRED' THEN "expiredAt" IS NOT NULL AND "paidAt" IS NULL
      WHEN 'CANCELED' THEN "canceledAt" IS NOT NULL AND "paidAt" IS NULL
      WHEN 'PAID' THEN "acceptedAt" IS NOT NULL AND "paidAt" IS NOT NULL AND "deliveredAt" IS NULL
      WHEN 'DELIVERED' THEN "paidAt" IS NOT NULL AND "deliveredAt" IS NOT NULL
      WHEN 'REVIEW' THEN "paidAt" IS NOT NULL AND "reviewReason" IS NOT NULL AND "deliveredAt" IS NULL
      WHEN 'REJECTED' THEN "paidAt" IS NOT NULL AND "reviewedAt" IS NOT NULL AND "deliveredAt" IS NULL
    END
  );

-- A gift is sent with the current terms of an available package, between
-- two users; its terms never change, its status only moves forward, and it
-- is never deleted (users are detached when their account is deleted).
CREATE FUNCTION "CreditGift_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_credits integer;
  v_price integer;
  v_available boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Credit gifts cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' OR NEW."senderAuthId" IS NULL OR NEW."recipientAuthId" IS NULL THEN
      RAISE EXCEPTION 'A gift is sent pending, from a user to another user' USING ERRCODE = 'check_violation';
    END IF;
    EXECUTE format(
      'SELECT "credits", "priceUsdCents", "available" FROM %I."CreditPackage" WHERE "code" = $1',
      TG_TABLE_SCHEMA
    ) INTO v_credits, v_price, v_available USING NEW."packageCode";
    IF v_available IS NOT TRUE OR v_credits <> NEW."credits" OR v_price <> NEW."listPriceUsdCents" THEN
      RAISE EXCEPTION 'A gift must carry the current terms of an available package'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR (NEW."senderAuthId" IS DISTINCT FROM OLD."senderAuthId" AND NEW."senderAuthId" IS NOT NULL)
    OR (NEW."recipientAuthId" IS DISTINCT FROM OLD."recipientAuthId" AND NEW."recipientAuthId" IS NOT NULL)
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."packageCode" IS DISTINCT FROM OLD."packageCode"
    OR NEW."credits" IS DISTINCT FROM OLD."credits"
    OR NEW."listPriceUsdCents" IS DISTINCT FROM OLD."listPriceUsdCents"
    OR NEW."message" IS DISTINCT FROM OLD."message"
    OR NEW."deliverAt" IS DISTINCT FROM OLD."deliverAt"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR (OLD."acceptedAt" IS NOT NULL AND NEW."acceptedAt" IS DISTINCT FROM OLD."acceptedAt")
    OR (OLD."paidAt" IS NOT NULL AND NEW."paidAt" IS DISTINCT FROM OLD."paidAt")
    OR (OLD."deliveredAt" IS NOT NULL AND NEW."deliveredAt" IS DISTINCT FROM OLD."deliveredAt")
  THEN
    RAISE EXCEPTION 'The terms of a gift cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN ('ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELED'))
    OR (OLD."status" = 'ACCEPTED' AND NEW."status" IN ('PAID', 'DECLINED', 'EXPIRED', 'CANCELED'))
    OR (OLD."status" = 'PAID' AND NEW."status" IN ('DELIVERED', 'REVIEW'))
    OR (OLD."status" = 'REVIEW' AND NEW."status" IN ('DELIVERED', 'REJECTED'))
  ) THEN
    RAISE EXCEPTION 'Gift status cannot change from % to %', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditGift_protect"
  BEFORE INSERT OR UPDATE OR DELETE ON "CreditGift"
  FOR EACH ROW EXECUTE FUNCTION "CreditGift_protect"();

-- ---------------------------------------------------------------------------
-- Orders: self purchases and gift payments
-- ---------------------------------------------------------------------------

ALTER TABLE "CreditPackageOrder"
  ADD CONSTRAINT "CreditPackageOrder_kind_gift" CHECK (("kind" = 'GIFT') = ("giftId" IS NOT NULL));

-- At most one checkout in progress per gift.
CREATE UNIQUE INDEX "CreditPackageOrder_one_open_per_gift"
  ON "CreditPackageOrder" ("giftId")
  WHERE "giftId" IS NOT NULL AND "status" IN ('CREATING', 'OPEN', 'PROCESSING');

CREATE OR REPLACE FUNCTION "CreditPackageOrder_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_credits integer;
  v_price integer;
  v_available boolean;
  v_gift_status text;
  v_gift_sender text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Credit package orders cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'CREATING' OR NEW."authId" IS NULL THEN
      RAISE EXCEPTION 'A credit package order is created for a user, before any payment'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."giftId" IS NOT NULL THEN
      -- A gift is paid by its sender, once accepted, at the gift's terms.
      EXECUTE format(
        'SELECT "credits", "listPriceUsdCents", "status"::text, "senderAuthId" FROM %I."CreditGift" WHERE "id" = $1',
        TG_TABLE_SCHEMA
      ) INTO v_credits, v_price, v_gift_status, v_gift_sender USING NEW."giftId";
      IF v_gift_status IS DISTINCT FROM 'ACCEPTED' OR v_gift_sender IS DISTINCT FROM NEW."authId"
         OR v_credits <> NEW."credits" OR v_price <> NEW."listPriceUsdCents" OR NEW."packageCode" IS NULL THEN
        RAISE EXCEPTION 'A gift can only be paid by its sender, once accepted, at its terms'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
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
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."giftId" IS DISTINCT FROM OLD."giftId"
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

-- A PAID order always has its fulfillment (checked at commit): the credits
-- are granted from it, now or after a crash.
DROP TRIGGER "CreditPackageOrder_paid_has_credits" ON "CreditPackageOrder";
DROP FUNCTION "CreditPackageOrder_paid_has_credits"();

CREATE FUNCTION "CreditPackageOrder_paid_has_fulfillment"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF NEW."status" <> 'PAID' OR OLD."status" = 'PAID' THEN
    RETURN NULL;
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I."CreditFulfillment" WHERE "orderId" = $1)', TG_TABLE_SCHEMA)
    INTO v_ok USING NEW."id";
  IF NOT v_ok THEN
    RAISE EXCEPTION 'A paid credit package order must have its fulfillment'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "CreditPackageOrder_paid_has_fulfillment"
  AFTER UPDATE ON "CreditPackageOrder"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "CreditPackageOrder_paid_has_fulfillment"();

-- Self-purchase credits: only for a PAID SELF order of the same user.
CREATE OR REPLACE FUNCTION "CreditAllocation_package_order_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF NEW."source" <> 'PURCHASE' OR NEW."sourceReference" NOT LIKE 'credit-package:%' THEN
    RETURN NEW;
  END IF;
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I."CreditPackageOrder"
       WHERE "id" = $1 AND "authId" = $2 AND "status" = ''PAID'' AND "kind" = ''SELF'' AND "credits" = $3)',
    TG_TABLE_SCHEMA
  ) INTO v_ok USING substring(NEW."sourceReference" FROM length('credit-package:') + 1), NEW."authId", NEW."amount";
  IF NOT v_ok THEN
    RAISE EXCEPTION 'Credit package credits require a paid order of the same user and credits'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Gift credits (`credit-gift:<gift id>`) only for the recipient of a paid,
-- not yet delivered gift, for exactly its credits (one allocation per
-- reference).
CREATE FUNCTION "CreditAllocation_gift_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_gift text;
  v_ok boolean;
BEGIN
  IF NEW."source" <> 'GIFT' THEN
    RETURN NEW;
  END IF;
  v_gift := substring(NEW."sourceReference" FROM '^credit-gift:([0-9a-f-]{36})$');
  IF v_gift IS NULL THEN
    RAISE EXCEPTION 'Gift credits must reference a gift (credit-gift:<gift id>)' USING ERRCODE = 'check_violation';
  END IF;
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I."CreditGift"
       WHERE "id" = $1 AND "recipientAuthId" = $2 AND "credits" = $3 AND "status" IN (''PAID'', ''REVIEW''))',
    TG_TABLE_SCHEMA
  ) INTO v_ok USING v_gift, NEW."authId", NEW."amount";
  IF NOT v_ok THEN
    RAISE EXCEPTION 'Gift credits require a paid gift to the same recipient, of the same credits'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditAllocation_gift_check"
  BEFORE INSERT ON "CreditAllocation"
  FOR EACH ROW EXECUTE FUNCTION "CreditAllocation_gift_check"();

-- GIFT credits never expire.
ALTER TABLE "CreditAllocation"
  DROP CONSTRAINT "CreditAllocation_expiry_by_source",
  ADD CONSTRAINT "CreditAllocation_expiry_by_source" CHECK (
    ("source" IN ('TRIAL', 'SUBSCRIPTION') AND "expiresAt" IS NOT NULL AND "expiresAt" > "grantedAt")
    OR ("source" IN ('PURCHASE', 'REFERRAL', 'DAILY_REWARD', 'MISSION_REWARD', 'GIFT') AND "expiresAt" IS NULL)
  );

-- ---------------------------------------------------------------------------
-- Fulfillment
-- ---------------------------------------------------------------------------

ALTER TABLE "CreditFulfillment"
  ADD CONSTRAINT "CreditFulfillment_facts" CHECK (
    "credits" > 0 AND "attempts" >= 0
    AND (("kind" = 'SELF' AND "source" = 'PURCHASE') OR ("kind" = 'GIFT' AND "source" = 'GIFT'))
    AND ("status" <> 'SUCCEEDED' OR "completedAt" IS NOT NULL)
    AND ("status" <> 'HELD' OR "holdReason" IS NOT NULL)
  );

-- A fulfillment belongs to a PAID order (same kind, credits and reference);
-- its facts never change and its status only moves forward:
-- PENDING / RETRYING -> RETRYING | SUCCEEDED | FAILED | HELD;
-- FAILED -> RETRYING (administrator retry) | REJECTED; HELD -> SUCCEEDED
-- (approved) | REJECTED. Fulfillments are never deleted.
CREATE FUNCTION "CreditFulfillment_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_kind text;
  v_credits integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Credit fulfillments cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('PENDING', 'HELD') THEN
      RAISE EXCEPTION 'A fulfillment is created pending or held' USING ERRCODE = 'check_violation';
    END IF;
    EXECUTE format('SELECT "status"::text, "kind"::text, "credits" FROM %I."CreditPackageOrder" WHERE "id" = $1', TG_TABLE_SCHEMA)
      INTO v_status, v_kind, v_credits USING NEW."orderId";
    IF v_status IS DISTINCT FROM 'PAID' OR v_kind <> NEW."kind"::text OR v_credits <> NEW."credits"
       OR (NEW."kind" = 'SELF' AND NEW."creditReference" <> ('credit-package:' || NEW."orderId"))
    THEN
      RAISE EXCEPTION 'A fulfillment needs the paid order it fulfills' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR (NEW."recipientAuthId" IS DISTINCT FROM OLD."recipientAuthId" AND NEW."recipientAuthId" IS NOT NULL)
    OR NEW."source" IS DISTINCT FROM OLD."source"
    OR NEW."creditReference" IS DISTINCT FROM OLD."creditReference"
    OR NEW."credits" IS DISTINCT FROM OLD."credits"
    OR NEW."dueAt" IS DISTINCT FROM OLD."dueAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."attempts" < OLD."attempts"
  THEN
    RAISE EXCEPTION 'A fulfillment cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" IN ('PENDING', 'RETRYING') AND NEW."status" IN ('RETRYING', 'SUCCEEDED', 'FAILED', 'HELD'))
    OR (OLD."status" = 'FAILED' AND NEW."status" IN ('RETRYING', 'REJECTED'))
    OR (OLD."status" = 'HELD' AND NEW."status" IN ('SUCCEEDED', 'REJECTED'))
  ) THEN
    RAISE EXCEPTION 'Fulfillment status cannot change from % to %', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditFulfillment_protect"
  BEFORE INSERT OR UPDATE OR DELETE ON "CreditFulfillment"
  FOR EACH ROW EXECUTE FUNCTION "CreditFulfillment_protect"();

-- A SUCCEEDED fulfillment has granted its credits (checked at commit).
CREATE FUNCTION "CreditFulfillment_succeeded_has_credits"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF NEW."status" <> 'SUCCEEDED' THEN
    RETURN NULL;
  END IF;
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I."CreditAllocation"
       WHERE "authId" = $1 AND "source" = $2 AND "sourceReference" = $3 AND "amount" = $4)',
    TG_TABLE_SCHEMA
  ) INTO v_ok USING NEW."recipientAuthId", NEW."source", NEW."creditReference", NEW."credits";
  IF NOT v_ok THEN
    RAISE EXCEPTION 'A succeeded fulfillment must have granted its credits'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "CreditFulfillment_succeeded_has_credits"
  AFTER UPDATE ON "CreditFulfillment"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "CreditFulfillment_succeeded_has_credits"();

-- Audit records never change.
CREATE FUNCTION "CreditFulfillmentEvent_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Fulfillment audit records cannot be changed' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "CreditFulfillmentEvent_immutable"
  BEFORE UPDATE OR DELETE ON "CreditFulfillmentEvent"
  FOR EACH ROW EXECUTE FUNCTION "CreditFulfillmentEvent_immutable"();
