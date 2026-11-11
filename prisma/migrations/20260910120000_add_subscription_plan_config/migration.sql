-- CreateEnum
CREATE TYPE "PlanCode" AS ENUM ('PRO');

-- CreateTable
CREATE TABLE "SubscriptionPlan" (
    "code" "PlanCode" NOT NULL,
    "priceUsdCents" INTEGER,
    "trialDays" INTEGER NOT NULL DEFAULT 7,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("code")
);

-- Database-level invariants (not expressible in the Prisma schema). Request
-- validation enforces the stricter product bounds; these only guarantee that
-- no write path can persist a non-positive price or a negative trial.
ALTER TABLE "SubscriptionPlan"
  ADD CONSTRAINT "SubscriptionPlan_priceUsdCents_positive" CHECK ("priceUsdCents" IS NULL OR "priceUsdCents" > 0),
  ADD CONSTRAINT "SubscriptionPlan_trialDays_non_negative" CHECK ("trialDays" >= 0);
