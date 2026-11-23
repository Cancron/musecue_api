-- Daily reward streaks and loyalty missions.
--
-- 1. Daily reward claims: a claim may grant 0 credits (the monthly cap of
--    600 is reached) so it still keeps the streak; a claim is always for the
--    UTC day it is made, after the user's last claimed day (no claim of a
--    past day), and its streak day follows the previous day's claim.
-- 2. Loyalty missions: administrator-defined missions rewarded with
--    MISSION_REWARD credits for verified makeup completions, once per
--    mission, user and period.

-- ---------------------------------------------------------------------------
-- 1. Daily reward claims
-- ---------------------------------------------------------------------------

ALTER TABLE "DailyRewardClaim"
  DROP CONSTRAINT "DailyRewardClaim_grantedCredits_range",
  ADD CONSTRAINT "DailyRewardClaim_grantedCredits_range"
    CHECK ("grantedCredits" >= 0 AND "grantedCredits" <= "rewardCredits"),
  -- claimedAt is stored in UTC: the claim is for the UTC day it was made.
  ADD CONSTRAINT "DailyRewardClaim_claimDate_is_claim_day"
    CHECK ("claimDate" = "claimedAt"::date);

-- Claims of a user are serialized (transaction lock per user) and only go
-- forward: a claim is for a day after the user's last claimed day, and its
-- streak day is the previous UTC day's streak day + 1 (1 without a claim
-- that day). Missed days can never be claimed afterwards.
CREATE FUNCTION "DailyRewardClaim_sequence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_later boolean;
  v_previous integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('daily-reward:' || NEW."authId", 0));
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I."DailyRewardClaim" WHERE "authId" = $1 AND "claimDate" >= $2)',
    TG_TABLE_SCHEMA
  ) INTO v_later USING NEW."authId", NEW."claimDate";
  IF v_later THEN
    RAISE EXCEPTION 'A daily reward can only be claimed for a day after the last claimed day'
      USING ERRCODE = 'check_violation';
  END IF;
  EXECUTE format(
    'SELECT "streakDay" FROM %I."DailyRewardClaim" WHERE "authId" = $1 AND "claimDate" = $2 - 1',
    TG_TABLE_SCHEMA
  ) INTO v_previous USING NEW."authId", NEW."claimDate";
  IF NEW."streakDay" <> COALESCE(v_previous, 0) + 1 THEN
    RAISE EXCEPTION 'The streak day of a daily reward claim must follow the previous day''s claim'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "DailyRewardClaim_sequence"
  BEFORE INSERT ON "DailyRewardClaim"
  FOR EACH ROW EXECUTE FUNCTION "DailyRewardClaim_sequence"();

-- ---------------------------------------------------------------------------
-- 2. Loyalty missions
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "LoyaltyMissionRecurrence" AS ENUM ('ONCE', 'WEEKLY', 'MONTHLY');

-- CreateTable
CREATE TABLE "LoyaltyMission" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "recurrence" "LoyaltyMissionRecurrence" NOT NULL,
    "requiredCompletions" INTEGER NOT NULL,
    "rewardCredits" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyMission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MakeupCompletion" (
    "sessionId" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MakeupCompletion_pkey" PRIMARY KEY ("sessionId")
);

-- CreateTable
CREATE TABLE "LoyaltyMissionAward" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "periodKey" VARCHAR(20) NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3),
    "requiredCompletions" INTEGER NOT NULL,
    "rewardCredits" INTEGER NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyMissionAward_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoyaltyMission_active_idx" ON "LoyaltyMission"("active");

-- CreateIndex
CREATE INDEX "MakeupCompletion_authId_completedAt_idx" ON "MakeupCompletion"("authId", "completedAt");

-- CreateIndex
CREATE INDEX "MakeupCompletion_processedAt_idx" ON "MakeupCompletion"("processedAt");

-- CreateIndex
CREATE INDEX "LoyaltyMissionAward_authId_awardedAt_idx" ON "LoyaltyMissionAward"("authId", "awardedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyMissionAward_missionId_authId_periodKey_key" ON "LoyaltyMissionAward"("missionId", "authId", "periodKey");

-- AddForeignKey
ALTER TABLE "MakeupCompletion" ADD CONSTRAINT "MakeupCompletion_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyMissionAward" ADD CONSTRAINT "LoyaltyMissionAward_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "LoyaltyMission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyMissionAward" ADD CONSTRAINT "LoyaltyMissionAward_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Bounds (also enforced by request validation).
ALTER TABLE "LoyaltyMission"
  ADD CONSTRAINT "LoyaltyMission_title_not_blank" CHECK (length(btrim("title")) > 0),
  ADD CONSTRAINT "LoyaltyMission_requiredCompletions_range" CHECK ("requiredCompletions" BETWEEN 1 AND 100),
  ADD CONSTRAINT "LoyaltyMission_rewardCredits_range" CHECK ("rewardCredits" BETWEEN 1 AND 100000);

ALTER TABLE "LoyaltyMissionAward"
  ADD CONSTRAINT "LoyaltyMissionAward_rewardCredits_positive" CHECK ("rewardCredits" > 0);

-- What a mission asks for never changes once created (create another
-- mission instead): recurrence, required completions and start.
CREATE FUNCTION "LoyaltyMission_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."recurrence" <> OLD."recurrence"
     OR NEW."requiredCompletions" <> OLD."requiredCompletions"
     OR NEW."startsAt" <> OLD."startsAt" THEN
    RAISE EXCEPTION 'The recurrence, required completions and start of a mission cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "LoyaltyMission_protect"
  BEFORE UPDATE ON "LoyaltyMission"
  FOR EACH ROW EXECUTE FUNCTION "LoyaltyMission_protect"();

-- A completion is recorded only for the user's own makeup session that was
-- completed through its guide with every step COMPLETED (none skipped), at
-- the session's completion time. Completions never change, except that
-- their missions are marked evaluated once.
CREATE FUNCTION "MakeupCompletion_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_verified boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."sessionId" <> OLD."sessionId" OR NEW."authId" <> OLD."authId"
       OR NEW."completedAt" <> OLD."completedAt" OR NEW."createdAt" <> OLD."createdAt"
       OR OLD."processedAt" IS NOT NULL OR NEW."processedAt" IS NULL THEN
      RAISE EXCEPTION 'Makeup completions cannot be changed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."processedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'A makeup completion is recorded before its missions are evaluated'
      USING ERRCODE = 'check_violation';
  END IF;
  EXECUTE format(
    'SELECT EXISTS (
       SELECT 1 FROM %1$I."MakeupSession" s
       JOIN %1$I."Guide" g ON g."sessionId" = s."id"
       WHERE s."id" = $1 AND s."authId" = $2 AND s."status" = ''COMPLETED''
         AND s."completedAt" = $3 AND g."status" = ''COMPLETED''
         AND EXISTS (SELECT 1 FROM %1$I."GuideStep" st WHERE st."guideId" = g."id")
         AND NOT EXISTS (
           SELECT 1 FROM %1$I."GuideStep" st
           WHERE st."guideId" = g."id" AND st."status" <> ''COMPLETED''))',
    TG_TABLE_SCHEMA
  ) INTO v_verified USING NEW."sessionId", NEW."authId", NEW."completedAt";
  IF NOT v_verified THEN
    RAISE EXCEPTION 'Only a makeup session completed with every step is a verified completion'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MakeupCompletion_protect"
  BEFORE INSERT OR UPDATE ON "MakeupCompletion"
  FOR EACH ROW EXECUTE FUNCTION "MakeupCompletion_protect"();

-- An award needs an active mission, the period of the mission's recurrence
-- and the mission's number of verified completions in that period (not
-- before the mission's start); awards never change.
CREATE FUNCTION "LoyaltyMissionAward_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_recurrence text;
  v_required integer;
  v_active boolean;
  v_starts timestamp(3);
  v_count integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Mission awards cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  EXECUTE format(
    'SELECT "recurrence"::text, "requiredCompletions", "active", "startsAt" FROM %I."LoyaltyMission" WHERE "id" = $1',
    TG_TABLE_SCHEMA
  ) INTO v_recurrence, v_required, v_active, v_starts USING NEW."missionId";
  IF v_recurrence IS NULL OR NOT v_active OR v_required <> NEW."requiredCompletions" THEN
    RAISE EXCEPTION 'A mission award needs an active mission' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (
    (v_recurrence = 'ONCE' AND NEW."periodKey" = 'once'
      AND NEW."periodStart" = v_starts AND NEW."periodEnd" IS NULL)
    OR (v_recurrence = 'WEEKLY'
      AND NEW."periodStart" = date_trunc('week', NEW."periodStart")
      AND NEW."periodEnd" = NEW."periodStart" + interval '7 days'
      AND NEW."periodKey" = to_char(NEW."periodStart", 'YYYY-MM-DD'))
    OR (v_recurrence = 'MONTHLY'
      AND NEW."periodStart" = date_trunc('month', NEW."periodStart")
      AND NEW."periodEnd" = NEW."periodStart" + interval '1 month'
      AND NEW."periodKey" = to_char(NEW."periodStart", 'YYYY-MM-DD'))
  ) THEN
    RAISE EXCEPTION 'A mission award must be for a period of the mission''s recurrence'
      USING ERRCODE = 'check_violation';
  END IF;
  EXECUTE format(
    'SELECT count(*) FROM %I."MakeupCompletion"
       WHERE "authId" = $1 AND "completedAt" >= GREATEST($2, $3)
         AND ($4::timestamp IS NULL OR "completedAt" < $4)',
    TG_TABLE_SCHEMA
  ) INTO v_count USING NEW."authId", NEW."periodStart", v_starts, NEW."periodEnd";
  IF v_count < v_required THEN
    RAISE EXCEPTION 'A mission is awarded only once its completions are recorded'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "LoyaltyMissionAward_protect"
  BEFORE INSERT OR UPDATE ON "LoyaltyMissionAward"
  FOR EACH ROW EXECUTE FUNCTION "LoyaltyMissionAward_protect"();

-- MISSION_REWARD credits never expire, like PURCHASE, REFERRAL and
-- DAILY_REWARD credits.
ALTER TABLE "CreditAllocation"
  DROP CONSTRAINT "CreditAllocation_expiry_by_source",
  ADD CONSTRAINT "CreditAllocation_expiry_by_source" CHECK (
    ("source" IN ('TRIAL', 'SUBSCRIPTION') AND "expiresAt" IS NOT NULL AND "expiresAt" > "grantedAt")
    OR ("source" IN ('PURCHASE', 'REFERRAL', 'DAILY_REWARD', 'MISSION_REWARD') AND "expiresAt" IS NULL)
  );

-- MISSION_REWARD credits exist only for a mission award of the same user and
-- amount (`loyalty-mission:<award id>`); with one allocation per reference,
-- each award is paid once.
CREATE FUNCTION "CreditAllocation_mission_reward_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_award text;
  v_ok boolean;
BEGIN
  IF NEW."source" <> 'MISSION_REWARD' THEN
    RETURN NEW;
  END IF;
  v_award := substring(NEW."sourceReference" FROM '^loyalty-mission:([0-9a-f-]{36})$');
  IF v_award IS NULL THEN
    RAISE EXCEPTION 'Mission credits must reference a mission award (loyalty-mission:<award id>)'
      USING ERRCODE = 'check_violation';
  END IF;
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I."LoyaltyMissionAward"
       WHERE "id" = $1 AND "authId" = $2 AND "rewardCredits" = $3)',
    TG_TABLE_SCHEMA
  ) INTO v_ok USING v_award, NEW."authId", NEW."amount";
  IF NOT v_ok THEN
    RAISE EXCEPTION 'Mission credits require a mission award of the same user and amount'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditAllocation_mission_reward_check"
  BEFORE INSERT ON "CreditAllocation"
  FOR EACH ROW EXECUTE FUNCTION "CreditAllocation_mission_reward_check"();
