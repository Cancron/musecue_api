-- Payment transactions and subscription lifecycle events for the single Pro
-- plan (monthly/yearly). No checkout, webhook or billing endpoints yet; this
-- migration adds the tables and the rules every future writer must follow.

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SubscriptionEventType" AS ENUM ('TRIAL_STARTED', 'CREATED', 'RENEWED', 'CANCELED', 'EXPIRED');

-- AlterTable
ALTER TABLE "UserSubscription" ADD COLUMN "paymentProvider" VARCHAR(50),
ADD COLUMN "providerSubscriptionId" VARCHAR(255);

-- CreateTable
CREATE TABLE "PaymentTransaction" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "providerPaymentId" VARCHAR(255) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amountCents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "billingInterval" "BillingInterval" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureCode" VARCHAR(100),
    "failureMessage" VARCHAR(500),
    "refundedAmountCents" INTEGER NOT NULL DEFAULT 0,
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionEvent" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "type" "SubscriptionEventType" NOT NULL,
    "paymentId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentTransaction_subscriptionId_createdAt_idx" ON "PaymentTransaction"("subscriptionId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentTransaction_status_idx" ON "PaymentTransaction"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_provider_providerPaymentId_key" ON "PaymentTransaction"("provider", "providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionEvent_paymentId_key" ON "SubscriptionEvent"("paymentId");

-- CreateIndex
CREATE INDEX "SubscriptionEvent_subscriptionId_occurredAt_idx" ON "SubscriptionEvent"("subscriptionId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserSubscription_paymentProvider_providerSubscriptionId_key" ON "UserSubscription"("paymentProvider", "providerSubscriptionId");

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "UserSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionEvent" ADD CONSTRAINT "SubscriptionEvent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "UserSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionEvent" ADD CONSTRAINT "SubscriptionEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "PaymentTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------------------------
-- Rules not expressible in the Prisma schema.
-- ------------------------------------------------------------------------

-- A verified (non-refunded) payment may pay for a given period only once.
CREATE UNIQUE INDEX "PaymentTransaction_one_verified_payment_per_period"
  ON "PaymentTransaction"("subscriptionId", "periodEnd")
  WHERE "status" IN ('SUCCEEDED', 'PARTIALLY_REFUNDED');

ALTER TABLE "PaymentTransaction"
  ADD CONSTRAINT "PaymentTransaction_amount_positive" CHECK ("amountCents" > 0),
  ADD CONSTRAINT "PaymentTransaction_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "PaymentTransaction_provider_ids_present" CHECK (
    length(btrim("provider")) > 0 AND length(btrim("providerPaymentId")) > 0
  ),
  -- A monthly period is one calendar month (28-31 days); a yearly period is
  -- one calendar year (365-366 days).
  ADD CONSTRAINT "PaymentTransaction_billing_period" CHECK (
    CASE "billingInterval"
      WHEN 'MONTHLY' THEN "periodEnd" >= "periodStart" + interval '28 days'
                      AND "periodEnd" <= "periodStart" + interval '31 days'
      WHEN 'YEARLY'  THEN "periodEnd" >= "periodStart" + interval '365 days'
                      AND "periodEnd" <= "periodStart" + interval '366 days'
    END
  ),
  ADD CONSTRAINT "PaymentTransaction_refund_amount" CHECK (
    "refundedAmountCents" >= 0 AND "refundedAmountCents" <= "amountCents"
  ),
  -- Timestamps, failure details and refund amounts must match the status.
  ADD CONSTRAINT "PaymentTransaction_status_consistent" CHECK (
    CASE "status"
      WHEN 'PENDING' THEN "paidAt" IS NULL AND "failedAt" IS NULL
        AND "refundedAmountCents" = 0 AND "refundedAt" IS NULL
        AND "failureCode" IS NULL AND "failureMessage" IS NULL
      WHEN 'SUCCEEDED' THEN "paidAt" IS NOT NULL AND "failedAt" IS NULL
        AND "refundedAmountCents" = 0 AND "refundedAt" IS NULL
        AND "failureCode" IS NULL AND "failureMessage" IS NULL
      WHEN 'FAILED' THEN "paidAt" IS NULL AND "failedAt" IS NOT NULL
        AND "refundedAmountCents" = 0 AND "refundedAt" IS NULL
      WHEN 'PARTIALLY_REFUNDED' THEN "paidAt" IS NOT NULL AND "failedAt" IS NULL
        AND "refundedAt" IS NOT NULL
        AND "refundedAmountCents" > 0 AND "refundedAmountCents" < "amountCents"
      WHEN 'REFUNDED' THEN "paidAt" IS NOT NULL AND "failedAt" IS NULL
        AND "refundedAt" IS NOT NULL AND "refundedAmountCents" = "amountCents"
    END
  );

ALTER TABLE "UserSubscription"
  ADD CONSTRAINT "UserSubscription_provider_link" CHECK (
    "providerSubscriptionId" IS NULL OR "paymentProvider" IS NOT NULL
  );

-- CREATED and RENEWED events carry the payment for the period; others do not.
ALTER TABLE "SubscriptionEvent"
  ADD CONSTRAINT "SubscriptionEvent_payment_matches_type" CHECK (
    ("type" IN ('CREATED', 'RENEWED')) = ("paymentId" IS NOT NULL)
  );

-- Payments: immutable facts, forward-only status, never deleted.
CREATE FUNCTION "PaymentTransaction_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PaymentTransaction records cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId"
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

CREATE TRIGGER "PaymentTransaction_protect"
  BEFORE UPDATE OR DELETE ON "PaymentTransaction"
  FOR EACH ROW EXECUTE FUNCTION "PaymentTransaction_protect"();

-- A paid term can only be created or extended by a SUCCEEDED payment of the
-- same subscription whose period ends exactly at the new proExpiresAt, starts
-- within the term and has the term's billing interval. Shortening or
-- cancelling never grants access and is not checked. Runs AFTER the row is
-- written so CHECK violations are reported first.
CREATE FUNCTION "UserSubscription_paid_term_requires_verified_payment"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  grants_access boolean;
  verified boolean;
BEGIN
  IF NEW."proStartedAt" IS NULL THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    grants_access := true;
  ELSE
    grants_access := OLD."proStartedAt" IS NULL
      OR NEW."proExpiresAt" > OLD."proExpiresAt"
      OR NEW."proStartedAt" < OLD."proStartedAt";
  END IF;

  IF NOT grants_access THEN
    RETURN NULL;
  END IF;

  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I."PaymentTransaction"
       WHERE "subscriptionId" = $1 AND "status" = ''SUCCEEDED''
         AND "periodEnd" = $2 AND "periodStart" >= $3
         AND "billingInterval" = $4)',
    TG_TABLE_SCHEMA
  ) INTO verified
  USING NEW."id", NEW."proExpiresAt", NEW."proStartedAt", NEW."billingInterval";

  IF NOT verified THEN
    RAISE EXCEPTION 'UserSubscription paid term requires a verified (SUCCEEDED) payment for the period ending %', NEW."proExpiresAt"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "UserSubscription_paid_term_requires_verified_payment"
  AFTER INSERT OR UPDATE ON "UserSubscription"
  FOR EACH ROW EXECUTE FUNCTION "UserSubscription_paid_term_requires_verified_payment"();

-- Events: CREATED/RENEWED must reference a SUCCEEDED payment of the same
-- subscription; the log is append-only.
CREATE FUNCTION "SubscriptionEvent_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  payment_ok boolean;
  owner_exists boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'SubscriptionEvent records cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- Allowed only as part of deleting the subscription (user deletion).
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I."UserSubscription" WHERE "id" = $1)',
      TG_TABLE_SCHEMA
    ) INTO owner_exists USING OLD."subscriptionId";
    IF owner_exists THEN
      RAISE EXCEPTION 'SubscriptionEvent records cannot be deleted'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."paymentId" IS NOT NULL THEN
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I."PaymentTransaction"
         WHERE "id" = $1 AND "subscriptionId" = $2 AND "status" = ''SUCCEEDED'')',
      TG_TABLE_SCHEMA
    ) INTO payment_ok USING NEW."paymentId", NEW."subscriptionId";
    IF NOT payment_ok THEN
      RAISE EXCEPTION 'SubscriptionEvent % requires a SUCCEEDED payment of the same subscription', NEW."type"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "SubscriptionEvent_protect"
  BEFORE INSERT OR UPDATE OR DELETE ON "SubscriptionEvent"
  FOR EACH ROW EXECUTE FUNCTION "SubscriptionEvent_protect"();
