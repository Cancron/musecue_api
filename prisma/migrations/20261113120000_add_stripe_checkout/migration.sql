-- Stripe checkout for the Pro plan (monthly/yearly): a per-user provider
-- customer and one row per hosted checkout. Checkouts never grant access on
-- their own; activation still requires a SUCCEEDED PaymentTransaction
-- (trigger "UserSubscription_paid_term_requires_verified_payment"), which is
-- only recorded from a verified provider webhook.

-- CreateEnum
CREATE TYPE "CheckoutSessionStatus" AS ENUM ('CREATING', 'OPEN', 'PROCESSING', 'COMPLETED', 'EXPIRED', 'FAILED');

-- CreateTable
CREATE TABLE "PaymentCustomer" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "providerCustomerId" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckoutSession" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "providerSessionId" VARCHAR(255),
    "providerCustomerId" VARCHAR(255) NOT NULL,
    "providerSubscriptionId" VARCHAR(255),
    "status" "CheckoutSessionStatus" NOT NULL DEFAULT 'CREATING',
    "billingInterval" "BillingInterval" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "url" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedReason" VARCHAR(100),
    "paymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckoutSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentCustomer_authId_provider_key" ON "PaymentCustomer"("authId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentCustomer_provider_providerCustomerId_key" ON "PaymentCustomer"("provider", "providerCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutSession_paymentId_key" ON "CheckoutSession"("paymentId");

-- CreateIndex
CREATE INDEX "CheckoutSession_subscriptionId_createdAt_idx" ON "CheckoutSession"("subscriptionId", "createdAt");

-- CreateIndex
CREATE INDEX "CheckoutSession_status_expiresAt_idx" ON "CheckoutSession"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutSession_provider_providerSessionId_key" ON "CheckoutSession"("provider", "providerSessionId");

-- AddForeignKey
ALTER TABLE "PaymentCustomer" ADD CONSTRAINT "PaymentCustomer_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "UserSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "PaymentTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------------------------
-- Rules not expressible in the Prisma schema.
-- ------------------------------------------------------------------------

-- At most one pending checkout per subscription (and so per user). Concurrent
-- checkout requests cannot create a second pending checkout.
CREATE UNIQUE INDEX "CheckoutSession_one_pending_per_subscription"
  ON "CheckoutSession"("subscriptionId")
  WHERE "status" IN ('CREATING', 'OPEN', 'PROCESSING');

ALTER TABLE "PaymentCustomer"
  ADD CONSTRAINT "PaymentCustomer_provider_ids_present" CHECK (
    length(btrim("provider")) > 0 AND length(btrim("providerCustomerId")) > 0
  );

ALTER TABLE "CheckoutSession"
  ADD CONSTRAINT "CheckoutSession_amount_positive" CHECK ("amountCents" > 0),
  ADD CONSTRAINT "CheckoutSession_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "CheckoutSession_provider_ids_present" CHECK (
    length(btrim("provider")) > 0
    AND length(btrim("providerCustomerId")) > 0
    AND ("providerSessionId" IS NULL OR length(btrim("providerSessionId")) > 0)
  ),
  -- Once the provider session exists it is always recorded.
  ADD CONSTRAINT "CheckoutSession_provider_session_present" CHECK (
    "status" IN ('CREATING', 'EXPIRED', 'FAILED') OR "providerSessionId" IS NOT NULL
  ),
  ADD CONSTRAINT "CheckoutSession_open_has_url" CHECK (
    "status" <> 'OPEN' OR "url" IS NOT NULL
  ),
  -- COMPLETED means a verified payment was recorded for this checkout.
  ADD CONSTRAINT "CheckoutSession_completed_has_payment" CHECK (
    ("status" = 'COMPLETED') = ("paymentId" IS NOT NULL)
    AND ("status" <> 'COMPLETED' OR "completedAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "CheckoutSession_closed_at" CHECK (
    ("status" IN ('EXPIRED', 'FAILED')) = ("closedAt" IS NOT NULL)
  );

-- Checkouts: the price, interval, customer, expiry and provider session are
-- fixed; status only moves forward; a linked payment must be a SUCCEEDED
-- payment of the same subscription.
CREATE FUNCTION "CheckoutSession_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  payment_ok boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId"
      OR NEW."provider" IS DISTINCT FROM OLD."provider"
      OR NEW."providerCustomerId" IS DISTINCT FROM OLD."providerCustomerId"
      OR NEW."billingInterval" IS DISTINCT FROM OLD."billingInterval"
      OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents"
      OR NEW."currency" IS DISTINCT FROM OLD."currency"
      OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
      OR (OLD."providerSessionId" IS NOT NULL
          AND NEW."providerSessionId" IS DISTINCT FROM OLD."providerSessionId")
      OR (OLD."paymentId" IS NOT NULL
          AND NEW."paymentId" IS DISTINCT FROM OLD."paymentId")
    THEN
      RAISE EXCEPTION 'CheckoutSession price, interval, customer, expiry, provider session and payment cannot change'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
      (OLD."status" = 'CREATING' AND NEW."status" IN ('OPEN', 'PROCESSING', 'COMPLETED', 'EXPIRED', 'FAILED'))
      OR (OLD."status" = 'OPEN' AND NEW."status" IN ('PROCESSING', 'COMPLETED', 'EXPIRED', 'FAILED'))
      OR (OLD."status" = 'PROCESSING' AND NEW."status" IN ('COMPLETED', 'FAILED'))
    ) THEN
      RAISE EXCEPTION 'CheckoutSession status cannot change from % to %', OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."paymentId" IS NOT NULL
    AND (TG_OP = 'INSERT' OR OLD."paymentId" IS NULL)
  THEN
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I."PaymentTransaction"
         WHERE "id" = $1 AND "subscriptionId" = $2 AND "status" = ''SUCCEEDED'')',
      TG_TABLE_SCHEMA
    ) INTO payment_ok USING NEW."paymentId", NEW."subscriptionId";
    IF NOT payment_ok THEN
      RAISE EXCEPTION 'CheckoutSession can only be completed by a SUCCEEDED payment of the same subscription'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "CheckoutSession_protect"
  BEFORE INSERT OR UPDATE ON "CheckoutSession"
  FOR EACH ROW EXECUTE FUNCTION "CheckoutSession_protect"();
