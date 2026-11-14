-- Adds authenticated Stripe Checkout for the Pro plan's monthly/yearly
-- options: a Stripe customer per user, a tracked CheckoutSession per attempt,
-- and the link from a verified payment back to the session that produced it.
--
-- A checkout session never grants Pro access by itself; only a webhook-
-- verified SUCCEEDED PaymentTransaction does, through the existing trigger
-- "UserSubscription_paid_term_requires_verified_payment" (migration
-- 20260920120000). This migration only adds the bookkeeping around the
-- checkout attempt itself:
--   * at most one PENDING CheckoutSession per subscription at a time
--     (partial unique index), so concurrent checkout requests cannot create
--     two valid sessions;
--   * a session's identifying fields never change after creation, and its
--     status only moves forward from PENDING (CheckoutSession_protect,
--     mirroring PaymentTransaction_protect below);
--   * PaymentTransaction.checkoutSessionId is added to the fields that
--     PaymentTransaction_protect already keeps immutable after creation.

-- CreateEnum
CREATE TYPE "CheckoutSessionStatus" AS ENUM ('PENDING', 'COMPLETED', 'EXPIRED', 'CANCELED');

-- AlterTable
ALTER TABLE "UserSubscription" ADD COLUMN "stripeCustomerId" VARCHAR(255);

-- AlterTable
ALTER TABLE "PaymentTransaction" ADD COLUMN "checkoutSessionId" TEXT;

-- CreateTable
CREATE TABLE "CheckoutSession" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "providerSessionId" VARCHAR(255) NOT NULL,
    "billingInterval" "BillingInterval" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "status" "CheckoutSessionStatus" NOT NULL DEFAULT 'PENDING',
    "url" VARCHAR(2048) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckoutSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserSubscription_stripeCustomerId_key" ON "UserSubscription"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_checkoutSessionId_key" ON "PaymentTransaction"("checkoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutSession_provider_providerSessionId_key" ON "CheckoutSession"("provider", "providerSessionId");

-- CreateIndex
CREATE INDEX "CheckoutSession_subscriptionId_status_idx" ON "CheckoutSession"("subscriptionId", "status");

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "UserSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "CheckoutSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ------------------------------------------------------------------------
-- Rules not expressible in the Prisma schema.
-- ------------------------------------------------------------------------

-- Only one checkout attempt may be in flight per subscription. Starting a
-- checkout for a different billing option must expire the old session
-- (application code) before a new one can be inserted; this index is what
-- makes that required, even under a race.
CREATE UNIQUE INDEX "CheckoutSession_one_pending_per_subscription"
  ON "CheckoutSession"("subscriptionId")
  WHERE "status" = 'PENDING';

ALTER TABLE "UserSubscription"
  ADD CONSTRAINT "UserSubscription_stripe_customer_id_format" CHECK (
    "stripeCustomerId" IS NULL OR length(btrim("stripeCustomerId")) > 0
  );

ALTER TABLE "CheckoutSession"
  ADD CONSTRAINT "CheckoutSession_amount_positive" CHECK ("amountCents" > 0),
  ADD CONSTRAINT "CheckoutSession_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "CheckoutSession_provider_ids_present" CHECK (
    length(btrim("provider")) > 0 AND length(btrim("providerSessionId")) > 0
    AND length(btrim("url")) > 0
  ),
  -- completedAt is set exactly when (and only when) the session is COMPLETED.
  ADD CONSTRAINT "CheckoutSession_completed_at_consistent" CHECK (
    ("status" = 'COMPLETED') = ("completedAt" IS NOT NULL)
  );

-- Sessions: identifying fields are immutable, status only moves forward from
-- PENDING to one terminal state, and a terminal state never changes again.
CREATE FUNCTION "CheckoutSession_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CheckoutSession records cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."providerSessionId" IS DISTINCT FROM OLD."providerSessionId"
    OR NEW."billingInterval" IS DISTINCT FROM OLD."billingInterval"
    OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."url" IS DISTINCT FROM OLD."url"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
  THEN
    RAISE EXCEPTION 'CheckoutSession identifying fields cannot change after creation'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    OLD."status" = 'PENDING'
    AND NEW."status" IN ('COMPLETED', 'EXPIRED', 'CANCELED')
  ) THEN
    RAISE EXCEPTION 'CheckoutSession status cannot change from % to %', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "CheckoutSession_protect"
  BEFORE UPDATE OR DELETE ON "CheckoutSession"
  FOR EACH ROW EXECUTE FUNCTION "CheckoutSession_protect"();

-- Extends PaymentTransaction_protect (20260918120000) so a payment's link to
-- the checkout session that produced it is also immutable after creation.
CREATE OR REPLACE FUNCTION "PaymentTransaction_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PaymentTransaction records cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId"
    OR NEW."checkoutSessionId" IS DISTINCT FROM OLD."checkoutSessionId"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."providerPaymentId" IS DISTINCT FROM OLD."providerPaymentId"
    OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."billingInterval" IS DISTINCT FROM OLD."billingInterval"
    OR NEW."periodStart" IS DISTINCT FROM OLD."periodStart"
    OR NEW."periodEnd" IS DISTINCT FROM OLD."periodEnd"
    OR NEW."paidAt" IS DISTINCT FROM OLD."paidAt" AND OLD."paidAt" IS NOT NULL
  THEN
    RAISE EXCEPTION 'PaymentTransaction amount, currency, provider IDs, period and payment time cannot change'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN ('SUCCEEDED', 'FAILED'))
    OR (OLD."status" = 'SUCCEEDED' AND NEW."status" IN ('PARTIALLY_REFUNDED', 'REFUNDED'))
    OR (OLD."status" = 'PARTIALLY_REFUNDED' AND NEW."status" = 'REFUNDED')
  ) THEN
    RAISE EXCEPTION 'PaymentTransaction status cannot change from % to %', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."refundedAmountCents" < OLD."refundedAmountCents" THEN
    RAISE EXCEPTION 'PaymentTransaction refunded amount cannot decrease'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
