-- Account erasure: hard deletion of an account and all its data, keeping
-- payment records (detached) and the storage references needed to delete
-- the account's files.

-- AlterEnum (not used elsewhere in this migration)
ALTER TYPE "AccountDeletionVerification" ADD VALUE 'PASSWORD_AND_EMAIL_CODE';

-- CreateEnum
CREATE TYPE "AccountDeletionFileKind" AS ENUM ('PRIVATE_IMAGE', 'IMAGE_OWNER_DIRECTORY', 'EXPORT_OWNER_DIRECTORY');

-- ------------------------------------------------------------------------
-- Payments survive the deletion of their subscription, detached.
-- ------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "PaymentTransaction" ALTER COLUMN "subscriptionId" DROP NOT NULL;

-- DropForeignKey / AddForeignKey (was ON DELETE RESTRICT, which made every
-- account with a payment undeletable)
ALTER TABLE "PaymentTransaction" DROP CONSTRAINT "PaymentTransaction_subscriptionId_fkey";
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "UserSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Payments stay immutable. The only permitted change of subscriptionId is the
-- detachment performed by ON DELETE SET NULL: from a subscription that no
-- longer exists (it is being deleted) to NULL. A payment is never moved to
-- another subscription or re-attached.
CREATE OR REPLACE FUNCTION "PaymentTransaction_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  subscription_exists boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PaymentTransaction records cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId" THEN
    subscription_exists := true;
    IF OLD."subscriptionId" IS NOT NULL AND NEW."subscriptionId" IS NULL THEN
      EXECUTE format(
        'SELECT EXISTS (SELECT 1 FROM %I."UserSubscription" WHERE "id" = $1)',
        TG_TABLE_SCHEMA
      ) INTO subscription_exists USING OLD."subscriptionId";
    END IF;
    IF subscription_exists THEN
      RAISE EXCEPTION 'PaymentTransaction subscription cannot change (it is only detached when the subscription is deleted)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."provider" IS DISTINCT FROM OLD."provider"
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

-- ------------------------------------------------------------------------
-- Resumable erasure of accounts.
-- ------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "AccountDeletionRequest" ADD COLUMN     "dataErasedAt" TIMESTAMP(3),
ADD COLUMN     "filesDeletedAt" TIMESTAMP(3),
ADD COLUMN     "lockedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AccountDeletionFile" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "kind" "AccountDeletionFileKind" NOT NULL,
    "storageKey" VARCHAR(512) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountDeletionFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountDeletionRequest_status_lockedUntil_idx" ON "AccountDeletionRequest"("status", "lockedUntil");

-- CreateIndex
CREATE INDEX "AccountDeletionFile_requestId_deletedAt_idx" ON "AccountDeletionFile"("requestId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccountDeletionFile_requestId_kind_storageKey_key" ON "AccountDeletionFile"("requestId", "kind", "storageKey");

-- AddForeignKey
ALTER TABLE "AccountDeletionFile" ADD CONSTRAINT "AccountDeletionFile_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "AccountDeletionRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A request completes only after every step: sessions revoked, data erased
-- and files deleted (replaces the earlier, weaker rule).
ALTER TABLE "AccountDeletionRequest"
  DROP CONSTRAINT "AccountDeletionRequest_completion_consistent",
  ADD CONSTRAINT "AccountDeletionRequest_completion_consistent" CHECK (
    ("status" = 'COMPLETED') = ("completedAt" IS NOT NULL)
    AND ("status" <> 'COMPLETED' OR (
      "sessionsRevokedAt" IS NOT NULL
      AND "dataErasedAt" IS NOT NULL
      AND "filesDeletedAt" IS NOT NULL
    ))
  ),
  -- Files are only deleted after the data (and their references) were saved.
  ADD CONSTRAINT "AccountDeletionRequest_files_after_data" CHECK (
    "filesDeletedAt" IS NULL OR "dataErasedAt" IS NOT NULL
  );
