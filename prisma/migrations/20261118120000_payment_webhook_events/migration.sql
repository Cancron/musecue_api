-- A durable log of provider webhook events whose signature was verified.
--
-- One row per provider event (e.g. Stripe `evt_...`), written only after the
-- signature check and before processing. It records each delivery attempt,
-- the processing status and outcome, and the error class of a failed attempt,
-- so a verified payment event that could not be applied is never silently
-- lost: it stays FAILED until a redelivery (Stripe's automatic retries or a
-- resend from the Stripe dashboard) processes it. Payment state itself is
-- still re-read from the provider and applied idempotently; this log adds no
-- business rule. No payload is stored (it can contain personal data).

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');

-- CreateTable
CREATE TABLE "PaymentWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "providerEventId" VARCHAR(255) NOT NULL,
    "type" VARCHAR(100) NOT NULL,
    "objectId" VARCHAR(255),
    "livemode" BOOLEAN NOT NULL,
    "eventCreatedAt" TIMESTAMP(3) NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "outcome" VARCHAR(50),
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lastErrorCode" VARCHAR(100),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentWebhookEvent_provider_providerEventId_key" ON "PaymentWebhookEvent"("provider", "providerEventId");

-- CreateIndex
CREATE INDEX "PaymentWebhookEvent_status_receivedAt_idx" ON "PaymentWebhookEvent"("status", "receivedAt");

-- ------------------------------------------------------------------------
-- Rules not expressible in the Prisma schema.
-- ------------------------------------------------------------------------

ALTER TABLE "PaymentWebhookEvent"
  ADD CONSTRAINT "PaymentWebhookEvent_attempts_positive" CHECK ("attempts" >= 1),
  ADD CONSTRAINT "PaymentWebhookEvent_ids_present" CHECK (
    length(btrim("provider")) > 0 AND length(btrim("providerEventId")) > 0
  ),
  ADD CONSTRAINT "PaymentWebhookEvent_processed_at" CHECK (
    ("status" = 'PROCESSED') = ("processedAt" IS NOT NULL)
  );
