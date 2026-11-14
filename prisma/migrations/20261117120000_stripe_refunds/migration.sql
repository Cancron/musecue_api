-- Refunds of Stripe payments (full or partial, made in Stripe).
--
-- * PaymentRefund: one row per provider refund (Stripe `re_...`) of a
--   recorded payment, with its amount, currency, status, reason and charge.
--   Only SUCCEEDED refunds count: they raise PaymentTransaction
--   refundedAmountCents and move it to PARTIALLY_REFUNDED or REFUNDED (the
--   existing forward-only rules apply). Refund facts never change, the status
--   only moves forward, and succeeded refunds can never exceed the payment.
-- * SubscriptionEventType PAYMENT_REFUNDED logs each refund that succeeded.
--   Like the other non-payment events it carries no paymentId.
-- Access granted by a refunded payment is revoked by shortening the paid term
-- (allowed by the existing triggers: shortening never needs a payment).

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'REQUIRES_ACTION', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- AlterEnum
ALTER TYPE "SubscriptionEventType" ADD VALUE 'PAYMENT_REFUNDED';

-- CreateTable
CREATE TABLE "PaymentRefund" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "providerRefundId" VARCHAR(255) NOT NULL,
    "providerChargeId" VARCHAR(255) NOT NULL,
    "status" "RefundStatus" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "reason" VARCHAR(100),
    "providerCreatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRefund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRefund_provider_providerRefundId_key" ON "PaymentRefund"("provider", "providerRefundId");

-- CreateIndex
CREATE INDEX "PaymentRefund_paymentId_idx" ON "PaymentRefund"("paymentId");

-- AddForeignKey
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "PaymentTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------------------------
-- Rules not expressible in the Prisma schema.
-- ------------------------------------------------------------------------

ALTER TABLE "PaymentRefund"
  ADD CONSTRAINT "PaymentRefund_amount_positive" CHECK ("amountCents" > 0),
  ADD CONSTRAINT "PaymentRefund_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "PaymentRefund_provider_ids_present" CHECK (
    length(btrim("provider")) > 0
    AND length(btrim("providerRefundId")) > 0
    AND length(btrim("providerChargeId")) > 0
  );

CREATE FUNCTION "PaymentRefund_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  payment_status text;
  payment_amount integer;
  succeeded_total bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PaymentRefund records cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."paymentId" IS DISTINCT FROM OLD."paymentId"
      OR NEW."provider" IS DISTINCT FROM OLD."provider"
      OR NEW."providerRefundId" IS DISTINCT FROM OLD."providerRefundId"
      OR NEW."providerChargeId" IS DISTINCT FROM OLD."providerChargeId"
      OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents"
      OR NEW."currency" IS DISTINCT FROM OLD."currency"
      OR NEW."providerCreatedAt" IS DISTINCT FROM OLD."providerCreatedAt"
    THEN
      RAISE EXCEPTION 'PaymentRefund payment, provider IDs, amount, currency and time cannot change'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
      OLD."status" IN ('PENDING', 'REQUIRES_ACTION')
      AND NEW."status" IN ('PENDING', 'REQUIRES_ACTION', 'SUCCEEDED', 'FAILED', 'CANCELED')
    ) THEN
      RAISE EXCEPTION 'PaymentRefund status cannot change from % to %', OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  EXECUTE format(
    'SELECT "status"::text, "amountCents" FROM %I."PaymentTransaction" WHERE "id" = $1',
    TG_TABLE_SCHEMA
  ) INTO payment_status, payment_amount USING NEW."paymentId";
  IF payment_status NOT IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED') THEN
    RAISE EXCEPTION 'PaymentRefund requires a collected payment'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'SUCCEEDED' THEN
    EXECUTE format(
      'SELECT COALESCE(SUM("amountCents"), 0) FROM %I."PaymentRefund"
         WHERE "paymentId" = $1 AND "status" = ''SUCCEEDED'' AND "id" <> $2',
      TG_TABLE_SCHEMA
    ) INTO succeeded_total USING NEW."paymentId", NEW."id";
    IF succeeded_total + NEW."amountCents" > payment_amount THEN
      RAISE EXCEPTION 'PaymentRefund succeeded refunds cannot exceed the payment amount'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "PaymentRefund_protect"
  BEFORE INSERT OR UPDATE OR DELETE ON "PaymentRefund"
  FOR EACH ROW EXECUTE FUNCTION "PaymentRefund_protect"();
