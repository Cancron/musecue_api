-- Administrator-managed configuration of discounts, referrals, daily rewards
-- and credit packages. Configuration only: nothing here grants credits,
-- applies discounts or sells packages yet.
--
-- The defaults are stored here, so they exist in PostgreSQL before any
-- administrator change. The application runs the same inserts at startup
-- (ensureDefaults of DiscountSettingsService, DailyRewardSettingsService and
-- CreditPackageSettingsService) in case a row was deleted. Both use
-- ON CONFLICT DO NOTHING: a stored row, including every administrator
-- change, is never overwritten by a deployment or restart.

-- CreateEnum
CREATE TYPE "CreditPackageCode" AS ENUM ('SMALL', 'MEDIUM', 'LARGE');

-- CreateTable
CREATE TABLE "DiscountSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "firstPurchaseDiscountPercent" INTEGER NOT NULL DEFAULT 0,
    "referralDiscountPercent" INTEGER NOT NULL DEFAULT 0,
    "referrerRewardCredits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyRewardSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "startingRewardCredits" INTEGER NOT NULL DEFAULT 10,
    "dailyIncrementCredits" INTEGER NOT NULL DEFAULT 10,
    "maxDailyRewardCredits" INTEGER NOT NULL DEFAULT 50,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyRewardSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditPackage" (
    "code" "CreditPackageCode" NOT NULL,
    "credits" INTEGER NOT NULL,
    "priceUsdCents" INTEGER NOT NULL,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditPackage_pkey" PRIMARY KEY ("code")
);

-- Database-level invariants (not expressible in the Prisma schema). Request
-- validation enforces the same rules plus the stricter product bounds
-- (upper limits, the $0.50 minimum package price); these guarantee that no
-- write path can store a second settings row, a negative amount, a
-- percentage outside 0-100 or a daily reward above the 600-credit monthly cap.
ALTER TABLE "DiscountSettings"
  ADD CONSTRAINT "DiscountSettings_single_row" CHECK ("id" = 1),
  ADD CONSTRAINT "DiscountSettings_firstPurchaseDiscountPercent_range"
    CHECK ("firstPurchaseDiscountPercent" BETWEEN 0 AND 100),
  ADD CONSTRAINT "DiscountSettings_referralDiscountPercent_range"
    CHECK ("referralDiscountPercent" BETWEEN 0 AND 100),
  ADD CONSTRAINT "DiscountSettings_referrerRewardCredits_non_negative"
    CHECK ("referrerRewardCredits" >= 0);

ALTER TABLE "DailyRewardSettings"
  ADD CONSTRAINT "DailyRewardSettings_single_row" CHECK ("id" = 1),
  ADD CONSTRAINT "DailyRewardSettings_startingRewardCredits_positive"
    CHECK ("startingRewardCredits" > 0),
  ADD CONSTRAINT "DailyRewardSettings_dailyIncrementCredits_non_negative"
    CHECK ("dailyIncrementCredits" >= 0),
  -- The largest daily reward is at least the first one and never more than
  -- the 600 credits a user can receive per UTC calendar month.
  ADD CONSTRAINT "DailyRewardSettings_maxDailyRewardCredits_range"
    CHECK ("maxDailyRewardCredits" >= "startingRewardCredits"
           AND "maxDailyRewardCredits" <= 600);

ALTER TABLE "CreditPackage"
  ADD CONSTRAINT "CreditPackage_credits_positive" CHECK ("credits" > 0),
  ADD CONSTRAINT "CreditPackage_priceUsdCents_positive" CHECK ("priceUsdCents" > 0);

-- Default configuration: every discount and referral offer off (0), daily
-- rewards of 10 credits rising by 10 per day up to 50, and three packages:
-- 250 credits for $5, 500 for $10 and 1,000 for $20, all available.
INSERT INTO "DiscountSettings" ("id", "updatedAt")
VALUES (1, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "DailyRewardSettings" ("id", "updatedAt")
VALUES (1, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "CreditPackage" ("code", "credits", "priceUsdCents", "available", "updatedAt")
VALUES ('SMALL', 250, 500, true, CURRENT_TIMESTAMP),
       ('MEDIUM', 500, 1000, true, CURRENT_TIMESTAMP),
       ('LARGE', 1000, 2000, true, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
