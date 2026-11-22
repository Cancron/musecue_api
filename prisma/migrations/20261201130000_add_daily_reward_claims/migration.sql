-- Daily reward claims, granted as DAILY_REWARD credits, with the fixed cap of
-- 600 daily reward credits per user and UTC calendar month enforced by
-- PostgreSQL: every claim recomputes the month's total from the claims under
-- a lock of the user's month row, and a CHECK constraint refuses a total
-- above 600. No write path (application, concurrent requests or manual SQL)
-- can exceed the cap.

-- DAILY_REWARD credits never expire, like PURCHASE and REFERRAL credits.
ALTER TABLE "CreditAllocation"
  DROP CONSTRAINT "CreditAllocation_expiry_by_source",
  ADD CONSTRAINT "CreditAllocation_expiry_by_source" CHECK (
    ("source" IN ('TRIAL', 'SUBSCRIPTION') AND "expiresAt" IS NOT NULL AND "expiresAt" > "grantedAt")
    OR ("source" IN ('PURCHASE', 'REFERRAL', 'DAILY_REWARD') AND "expiresAt" IS NULL)
  );

-- CreateTable
CREATE TABLE "DailyRewardClaim" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "claimDate" DATE NOT NULL,
    "monthStart" DATE NOT NULL,
    "streakDay" INTEGER NOT NULL,
    "rewardCredits" INTEGER NOT NULL,
    "grantedCredits" INTEGER NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyRewardClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyRewardMonthlyTotal" (
    "authId" TEXT NOT NULL,
    "monthStart" DATE NOT NULL,
    "totalCredits" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyRewardMonthlyTotal_pkey" PRIMARY KEY ("authId","monthStart")
);

-- CreateIndex
CREATE INDEX "DailyRewardClaim_authId_monthStart_idx" ON "DailyRewardClaim"("authId", "monthStart");

-- CreateIndex
CREATE UNIQUE INDEX "DailyRewardClaim_authId_claimDate_key" ON "DailyRewardClaim"("authId", "claimDate");

-- AddForeignKey
ALTER TABLE "DailyRewardClaim" ADD CONSTRAINT "DailyRewardClaim_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyRewardMonthlyTotal" ADD CONSTRAINT "DailyRewardMonthlyTotal_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DailyRewardClaim"
  ADD CONSTRAINT "DailyRewardClaim_monthStart_matches"
    CHECK ("monthStart" = date_trunc('month', "claimDate")::date),
  ADD CONSTRAINT "DailyRewardClaim_streakDay_positive" CHECK ("streakDay" >= 1),
  ADD CONSTRAINT "DailyRewardClaim_rewardCredits_range"
    CHECK ("rewardCredits" BETWEEN 1 AND 600),
  ADD CONSTRAINT "DailyRewardClaim_grantedCredits_range"
    CHECK ("grantedCredits" >= 1 AND "grantedCredits" <= "rewardCredits");

-- The monthly cap (DAILY_REWARD_MONTHLY_CAP_CREDITS in the application).
ALTER TABLE "DailyRewardMonthlyTotal"
  ADD CONSTRAINT "DailyRewardMonthlyTotal_monthStart_first_day"
    CHECK ("monthStart" = date_trunc('month', "monthStart")::date),
  ADD CONSTRAINT "DailyRewardMonthlyTotal_totalCredits_cap"
    CHECK ("totalCredits" BETWEEN 0 AND 600);

-- Every claim locks (or creates) its user's month row and sets the month's
-- total to the sum of the month's claims including the new one, so the
-- CHECK above refuses any claim that would take the month above 600, even
-- if the total row was modified or deleted by hand.
CREATE FUNCTION "DailyRewardClaim_apply_monthly_cap"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_total integer;
BEGIN
  EXECUTE format(
    'INSERT INTO %I."DailyRewardMonthlyTotal" ("authId", "monthStart", "totalCredits", "updatedAt")
     VALUES ($1, $2, 0, $3) ON CONFLICT ("authId", "monthStart") DO NOTHING',
    TG_TABLE_SCHEMA
  ) USING NEW."authId", NEW."monthStart", NEW."claimedAt";
  EXECUTE format(
    'SELECT 1 FROM %I."DailyRewardMonthlyTotal" WHERE "authId" = $1 AND "monthStart" = $2 FOR UPDATE',
    TG_TABLE_SCHEMA
  ) USING NEW."authId", NEW."monthStart";
  EXECUTE format(
    'SELECT COALESCE(SUM("grantedCredits"), 0) FROM %I."DailyRewardClaim" WHERE "authId" = $1 AND "monthStart" = $2',
    TG_TABLE_SCHEMA
  ) INTO v_total USING NEW."authId", NEW."monthStart";
  EXECUTE format(
    'UPDATE %I."DailyRewardMonthlyTotal" SET "totalCredits" = $3, "updatedAt" = $4
     WHERE "authId" = $1 AND "monthStart" = $2',
    TG_TABLE_SCHEMA
  ) USING NEW."authId", NEW."monthStart", v_total + NEW."grantedCredits", NEW."claimedAt";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "DailyRewardClaim_apply_monthly_cap"
  BEFORE INSERT ON "DailyRewardClaim"
  FOR EACH ROW EXECUTE FUNCTION "DailyRewardClaim_apply_monthly_cap"();

-- Claims are history: they never change (deleting the user deletes them).
CREATE FUNCTION "DailyRewardClaim_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Daily reward claims cannot be changed'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "DailyRewardClaim_immutable"
  BEFORE UPDATE ON "DailyRewardClaim"
  FOR EACH ROW EXECUTE FUNCTION "DailyRewardClaim_immutable"();
