-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('FREE', 'TRIAL', 'PRO', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'YEARLY');

-- CreateTable
CREATE TABLE "UserSubscription" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'FREE',
    "trialUsed" BOOLEAN NOT NULL DEFAULT false,
    "trialStartedAt" TIMESTAMP(3),
    "trialExpiresAt" TIMESTAMP(3),
    "billingInterval" "BillingInterval",
    "proStartedAt" TIMESTAMP(3),
    "proExpiresAt" TIMESTAMP(3),
    "proCanceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserSubscription_authId_key" ON "UserSubscription"("authId");

-- CreateIndex
CREATE INDEX "UserSubscription_status_idx" ON "UserSubscription"("status");

-- AddForeignKey
ALTER TABLE "UserSubscription" ADD CONSTRAINT "UserSubscription_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Consistency rules (not expressible in the Prisma schema).
ALTER TABLE "UserSubscription"
  -- A trial has both dates or neither, and ends after it starts.
  ADD CONSTRAINT "UserSubscription_trial_window" CHECK (
    ("trialStartedAt" IS NULL) = ("trialExpiresAt" IS NULL)
    AND ("trialStartedAt" IS NULL OR "trialExpiresAt" > "trialStartedAt")
  ),
  -- A started trial is always marked as used, so it cannot be granted again.
  ADD CONSTRAINT "UserSubscription_trial_marks_used" CHECK (
    "trialStartedAt" IS NULL OR "trialUsed"
  ),
  -- A Pro term has an interval, a start and an expiry together, and ends after it starts.
  ADD CONSTRAINT "UserSubscription_pro_term" CHECK (
    ("billingInterval" IS NULL) = ("proStartedAt" IS NULL)
    AND ("proStartedAt" IS NULL) = ("proExpiresAt" IS NULL)
    AND ("proStartedAt" IS NULL OR "proExpiresAt" > "proStartedAt")
  ),
  -- Only a Pro term can be canceled.
  ADD CONSTRAINT "UserSubscription_pro_cancel" CHECK (
    "proCanceledAt" IS NULL OR "proStartedAt" IS NOT NULL
  ),
  -- The stored status must describe data that exists on the record.
  ADD CONSTRAINT "UserSubscription_status_consistent" CHECK (
    CASE "status"
      WHEN 'FREE' THEN NOT "trialUsed" AND "trialStartedAt" IS NULL AND "proStartedAt" IS NULL
      WHEN 'TRIAL' THEN "trialStartedAt" IS NOT NULL
      WHEN 'PRO' THEN "proStartedAt" IS NOT NULL
      WHEN 'EXPIRED' THEN "trialUsed" OR "proStartedAt" IS NOT NULL
    END
  );
