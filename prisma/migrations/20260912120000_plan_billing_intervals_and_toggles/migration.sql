-- Adds monthly/yearly pricing and explicit enable flags to the Pro plan.
-- Existing configuration is preserved:
--   * the previous single price becomes the monthly price; a price that was
--     never configured (NULL) takes the new $19.00 monthly default;
--   * the yearly price starts at the $190.00 default;
--   * a trial of 0 days previously meant "no trial"; it becomes
--     trialEnabled = false with the default 7-day length, so re-enabling the
--     trial restores a valid duration;
--   * the plan stays enabled.

-- Drop constraints that reference the columns being reshaped.
ALTER TABLE "SubscriptionPlan"
  DROP CONSTRAINT "SubscriptionPlan_priceUsdCents_positive",
  DROP CONSTRAINT "SubscriptionPlan_trialDays_non_negative";

-- Monthly price (renamed in place so existing values are kept).
ALTER TABLE "SubscriptionPlan" RENAME COLUMN "priceUsdCents" TO "monthlyPriceUsdCents";
UPDATE "SubscriptionPlan" SET "monthlyPriceUsdCents" = 1900 WHERE "monthlyPriceUsdCents" IS NULL;
ALTER TABLE "SubscriptionPlan"
  ALTER COLUMN "monthlyPriceUsdCents" SET DEFAULT 1900,
  ALTER COLUMN "monthlyPriceUsdCents" SET NOT NULL;

-- New columns.
ALTER TABLE "SubscriptionPlan"
  ADD COLUMN "planEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "yearlyPriceUsdCents" INTEGER NOT NULL DEFAULT 19000,
  ADD COLUMN "trialEnabled" BOOLEAN NOT NULL DEFAULT true;

-- Translate the old "0 days = no trial" convention.
UPDATE "SubscriptionPlan" SET "trialEnabled" = false, "trialDays" = 7 WHERE "trialDays" = 0;

-- Database-level invariants. Request validation enforces the stricter product
-- bounds; these only guarantee no write path can persist impossible values.
ALTER TABLE "SubscriptionPlan"
  ADD CONSTRAINT "SubscriptionPlan_monthlyPriceUsdCents_positive" CHECK ("monthlyPriceUsdCents" > 0),
  ADD CONSTRAINT "SubscriptionPlan_yearlyPriceUsdCents_positive" CHECK ("yearlyPriceUsdCents" > 0),
  ADD CONSTRAINT "SubscriptionPlan_trialDays_positive" CHECK ("trialDays" > 0);
