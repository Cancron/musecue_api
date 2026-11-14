-- Failed Stripe payments and their recovery.
--
-- A PaymentTransaction is one charge attempt (see 20260918120000). A failed
-- attempt to collect a Stripe invoice is recorded as its own FAILED attempt,
-- and the collection that finally succeeds (possibly after several failures)
-- is the invoice's single SUCCEEDED attempt. The forward-only status rules
-- are unchanged: FAILED stays terminal and never grants access.
--
--   * PaymentTransaction.providerInvoiceId groups the attempts of one provider
--     invoice (immutable once set).
--   * UserSubscription.pastDueSince marks a renewal of the linked provider
--     subscription that failed and is still being retried. It never changes
--     the paid term; access still ends at proExpiresAt.
--   * SubscriptionEventType PAYMENT_FAILED logs each failed attempt. Like the
--     other non-payment events it carries no paymentId; the FAILED attempt is
--     found through the subscription and invoice.

-- AlterEnum
ALTER TYPE "SubscriptionEventType" ADD VALUE 'PAYMENT_FAILED';

-- AlterTable
ALTER TABLE "PaymentTransaction" ADD COLUMN "providerInvoiceId" VARCHAR(255);

-- AlterTable
ALTER TABLE "UserSubscription" ADD COLUMN "pastDueSince" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "PaymentTransaction_provider_providerInvoiceId_idx" ON "PaymentTransaction"("provider", "providerInvoiceId");

-- Stripe payments recorded so far are keyed by their invoice id.
UPDATE "PaymentTransaction"
   SET "providerInvoiceId" = "providerPaymentId"
 WHERE "provider" = 'stripe' AND "providerPaymentId" LIKE 'in\_%';

-- ------------------------------------------------------------------------
-- Rules not expressible in the Prisma schema.
-- ------------------------------------------------------------------------

ALTER TABLE "PaymentTransaction"
  ADD CONSTRAINT "PaymentTransaction_provider_invoice_present" CHECK (
    "providerInvoiceId" IS NULL OR length(btrim("providerInvoiceId")) > 0
  );

-- Only a subscription linked to a provider subscription can be past due.
ALTER TABLE "UserSubscription"
  ADD CONSTRAINT "UserSubscription_past_due_linked" CHECK (
    "pastDueSince" IS NULL OR "providerSubscriptionId" IS NOT NULL
  );

-- The invoice of an attempt never changes once recorded (the other payment
-- facts are protected by "PaymentTransaction_protect").
CREATE FUNCTION "PaymentTransaction_protect_invoice"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."providerInvoiceId" IS NOT NULL
    AND NEW."providerInvoiceId" IS DISTINCT FROM OLD."providerInvoiceId"
  THEN
    RAISE EXCEPTION 'PaymentTransaction provider invoice cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PaymentTransaction_protect_invoice"
  BEFORE UPDATE ON "PaymentTransaction"
  FOR EACH ROW EXECUTE FUNCTION "PaymentTransaction_protect_invoice"();
