-- Referral milestones, suspicious-referral holds, notifications, and
-- referral codes usable only at signup.
--
-- PostgreSQL enforces, independently of the application:
-- - a referral is recorded only by the transaction that creates the
--   referred account (its row was inserted by the current transaction), so
--   no later action can attach a referral code to an existing account;
-- - referral status: PENDING -> REWARDED | QUALIFIED | HELD, and
--   HELD -> REWARDED | QUALIFIED | REJECTED (administrator review), once;
--   a held reward keeps its amount;
-- - a milestone is awarded to a referrer at most once (unique), only once
--   the referrer's paid referrals reach it, and milestone credits exist only
--   for such an award;
-- - payment methods are stored as keyed hashes only;
-- - a notification is unique per user and event, and never changes except
--   its read and email-delivery state.

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('REFERRAL_REWARD_EARNED', 'REFERRAL_MILESTONE_REACHED', 'SECURITY_SIGNED_OUT_EVERYWHERE', 'SECURITY_SESSION_REUSE_DETECTED');

-- CreateEnum
CREATE TYPE "NotificationEmailStatus" AS ENUM ('NOT_REQUESTED', 'PENDING', 'SENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "Referral" ADD COLUMN     "heldAt" TIMESTAMP(3),
ADD COLUMN     "holdReason" VARCHAR(50),
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedBy" VARCHAR(64);

-- CreateTable
CREATE TABLE "ReferralMilestone" (
    "id" TEXT NOT NULL,
    "referralCount" INTEGER NOT NULL,
    "rewardCredits" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralMilestoneAward" (
    "id" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "referralCount" INTEGER NOT NULL,
    "rewardCredits" INTEGER NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralMilestoneAward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralProgress" (
    "authId" TEXT NOT NULL,
    "paidReferrals" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralProgress_pkey" PRIMARY KEY ("authId")
);

-- CreateTable
CREATE TABLE "PaymentFingerprint" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "fingerprintHash" CHAR(64) NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentFingerprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "eventKey" VARCHAR(200) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "data" JSONB,
    "readAt" TIMESTAMP(3),
    "emailStatus" "NotificationEmailStatus" NOT NULL,
    "emailAttempts" INTEGER NOT NULL DEFAULT 0,
    "emailClaimedAt" TIMESTAMP(3),
    "emailSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "authId" TEXT NOT NULL,
    "emailReferralRewards" BOOLEAN NOT NULL DEFAULT true,
    "emailReferralMilestones" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("authId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralMilestone_referralCount_key" ON "ReferralMilestone"("referralCount");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralMilestoneAward_authId_milestoneId_key" ON "ReferralMilestoneAward"("authId", "milestoneId");

-- CreateIndex
CREATE INDEX "PaymentFingerprint_fingerprintHash_idx" ON "PaymentFingerprint"("fingerprintHash");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentFingerprint_authId_fingerprintHash_key" ON "PaymentFingerprint"("authId", "fingerprintHash");

-- CreateIndex
CREATE INDEX "Notification_authId_createdAt_id_idx" ON "Notification"("authId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Notification_emailStatus_createdAt_idx" ON "Notification"("emailStatus", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_authId_eventKey_key" ON "Notification"("authId", "eventKey");

-- AddForeignKey
ALTER TABLE "ReferralMilestoneAward" ADD CONSTRAINT "ReferralMilestoneAward_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "ReferralMilestone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralMilestoneAward" ADD CONSTRAINT "ReferralMilestoneAward_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralProgress" ADD CONSTRAINT "ReferralProgress_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentFingerprint" ADD CONSTRAINT "PaymentFingerprint_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Referrals
-- ---------------------------------------------------------------------------

ALTER TABLE "Referral"
  DROP CONSTRAINT "Referral_status_facts",
  ADD CONSTRAINT "Referral_status_facts" CHECK (
    CASE "status"
      WHEN 'PENDING' THEN "qualifiedAt" IS NULL AND "qualifyingPaymentId" IS NULL
        AND "rewardCredits" IS NULL AND "rewardedAt" IS NULL
        AND "holdReason" IS NULL AND "heldAt" IS NULL AND "reviewedAt" IS NULL
      WHEN 'REWARDED' THEN "qualifiedAt" IS NOT NULL AND "qualifyingPaymentId" IS NOT NULL
        AND "rewardCredits" > 0 AND "rewardedAt" IS NOT NULL
        AND ("heldAt" IS NULL) = ("reviewedAt" IS NULL)
      WHEN 'QUALIFIED' THEN "qualifiedAt" IS NOT NULL AND "qualifyingPaymentId" IS NOT NULL
        AND "rewardedAt" IS NULL
        AND ("heldAt" IS NULL) = ("reviewedAt" IS NULL)
        AND ("rewardCredits" IS NULL OR "heldAt" IS NOT NULL)
      WHEN 'HELD' THEN "qualifiedAt" IS NOT NULL AND "qualifyingPaymentId" IS NOT NULL
        AND "holdReason" IS NOT NULL AND "heldAt" IS NOT NULL
        AND "reviewedAt" IS NULL AND "rewardedAt" IS NULL
        AND ("rewardCredits" IS NULL OR "rewardCredits" > 0)
      WHEN 'REJECTED' THEN "qualifiedAt" IS NOT NULL AND "qualifyingPaymentId" IS NOT NULL
        AND "holdReason" IS NOT NULL AND "heldAt" IS NOT NULL
        AND "reviewedAt" IS NOT NULL AND "rewardedAt" IS NULL
    END
  );

CREATE OR REPLACE FUNCTION "Referral_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_paid boolean;
  v_created_here boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'A referral is created pending' USING ERRCODE = 'check_violation';
    END IF;
    -- Signup only: the referred account was created by this transaction.
    EXECUTE format(
      'SELECT xmin = pg_current_xact_id()::xid FROM %I."authUser" WHERE "id" = $1',
      TG_TABLE_SCHEMA
    ) INTO v_created_here USING NEW."authId";
    IF v_created_here IS NOT TRUE THEN
      RAISE EXCEPTION 'A referral can only be recorded when the account is created'
        USING ERRCODE = 'check_violation';
    END IF;
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I."PaymentTransaction" p JOIN %I."UserSubscription" s ON s."id" = p."subscriptionId"
         WHERE s."authId" = $1 AND p."status" IN (''SUCCEEDED'', ''PARTIALLY_REFUNDED'', ''REFUNDED''))',
      TG_TABLE_SCHEMA, TG_TABLE_SCHEMA
    ) INTO v_paid USING NEW."authId";
    IF v_paid THEN
      RAISE EXCEPTION 'A referral cannot be recorded after a paid purchase'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."authId" IS DISTINCT FROM OLD."authId"
    OR (NEW."referrerAuthId" IS DISTINCT FROM OLD."referrerAuthId" AND NEW."referrerAuthId" IS NOT NULL)
    OR NEW."referralCode" IS DISTINCT FROM OLD."referralCode"
    OR NEW."canonicalEmailHash" IS DISTINCT FROM OLD."canonicalEmailHash"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'A referral cannot be changed' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    IF NEW."qualifyingPaymentId" IS DISTINCT FROM OLD."qualifyingPaymentId"
      OR NEW."qualifiedAt" IS DISTINCT FROM OLD."qualifiedAt"
      OR NEW."rewardCredits" IS DISTINCT FROM OLD."rewardCredits"
      OR NEW."rewardedAt" IS DISTINCT FROM OLD."rewardedAt"
      OR NEW."holdReason" IS DISTINCT FROM OLD."holdReason"
      OR NEW."heldAt" IS DISTINCT FROM OLD."heldAt"
      OR NEW."reviewedAt" IS DISTINCT FROM OLD."reviewedAt"
      OR NEW."reviewedBy" IS DISTINCT FROM OLD."reviewedBy"
    THEN
      RAISE EXCEPTION 'A referral cannot be changed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'PENDING' AND NEW."status" IN ('REWARDED', 'QUALIFIED', 'HELD') THEN
    IF NEW."reviewedAt" IS NOT NULL OR NEW."reviewedBy" IS NOT NULL THEN
      RAISE EXCEPTION 'A referral is reviewed only after it was held' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'HELD' AND NEW."status" IN ('REWARDED', 'QUALIFIED', 'REJECTED') THEN
    -- The review keeps every fact of the hold, including the held reward.
    IF NEW."qualifyingPaymentId" IS DISTINCT FROM OLD."qualifyingPaymentId"
      OR NEW."qualifiedAt" IS DISTINCT FROM OLD."qualifiedAt"
      OR NEW."holdReason" IS DISTINCT FROM OLD."holdReason"
      OR NEW."heldAt" IS DISTINCT FROM OLD."heldAt"
      OR NEW."rewardCredits" IS DISTINCT FROM OLD."rewardCredits"
    THEN
      RAISE EXCEPTION 'A held referral keeps its facts when it is reviewed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A referral is rewarded or qualified only once'
    USING ERRCODE = 'check_violation';
END;
$$;

-- ---------------------------------------------------------------------------
-- Milestones
-- ---------------------------------------------------------------------------

ALTER TABLE "ReferralMilestone"
  ADD CONSTRAINT "ReferralMilestone_referralCount_range" CHECK ("referralCount" BETWEEN 1 AND 100000),
  ADD CONSTRAINT "ReferralMilestone_rewardCredits_range" CHECK ("rewardCredits" BETWEEN 1 AND 1000000);

CREATE FUNCTION "ReferralMilestone_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."referralCount" IS DISTINCT FROM OLD."referralCount" THEN
    RAISE EXCEPTION 'The referral count of a milestone cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ReferralMilestone_protect"
  BEFORE UPDATE ON "ReferralMilestone"
  FOR EACH ROW EXECUTE FUNCTION "ReferralMilestone_protect"();

ALTER TABLE "ReferralMilestoneAward"
  ADD CONSTRAINT "ReferralMilestoneAward_rewardCredits_positive" CHECK ("rewardCredits" > 0);

-- An award needs the milestone's threshold of paid referrals (REWARDED or
-- QUALIFIED) and its current reward; awards never change.
CREATE FUNCTION "ReferralMilestoneAward_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_count integer;
  v_threshold integer;
  v_active boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Milestone awards cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  EXECUTE format('SELECT "referralCount", "active" FROM %I."ReferralMilestone" WHERE "id" = $1', TG_TABLE_SCHEMA)
    INTO v_threshold, v_active USING NEW."milestoneId";
  IF v_threshold IS NULL OR NOT v_active OR v_threshold <> NEW."referralCount" THEN
    RAISE EXCEPTION 'A milestone award needs an active milestone' USING ERRCODE = 'check_violation';
  END IF;
  EXECUTE format(
    'SELECT count(*) FROM %I."Referral" WHERE "referrerAuthId" = $1 AND "status" IN (''REWARDED'', ''QUALIFIED'')',
    TG_TABLE_SCHEMA
  ) INTO v_count USING NEW."authId";
  IF v_count < v_threshold THEN
    RAISE EXCEPTION 'A milestone is awarded only once it is reached' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ReferralMilestoneAward_protect"
  BEFORE INSERT OR UPDATE ON "ReferralMilestoneAward"
  FOR EACH ROW EXECUTE FUNCTION "ReferralMilestoneAward_protect"();

-- Referral credits: `referral-reward:<referral id>` for a REWARDED referral
-- of the same referrer and amount (as before), `referral-milestone:<id>`
-- for a milestone award of the same referrer and amount.
CREATE OR REPLACE FUNCTION "CreditAllocation_referral_reward_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ref text;
  v_ok boolean;
BEGIN
  IF NEW."source" <> 'REFERRAL' THEN
    RETURN NEW;
  END IF;
  IF NEW."sourceReference" LIKE 'referral-reward:%' THEN
    v_ref := substring(NEW."sourceReference" FROM length('referral-reward:') + 1);
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I."Referral"
         WHERE "id" = $1 AND "referrerAuthId" = $2 AND "status" = ''REWARDED'' AND "rewardCredits" = $3)',
      TG_TABLE_SCHEMA
    ) INTO v_ok USING v_ref, NEW."authId", NEW."amount";
    IF NOT v_ok THEN
      RAISE EXCEPTION 'Referral reward credits require a rewarded referral of the same referrer and amount'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."sourceReference" LIKE 'referral-milestone:%' THEN
    v_ref := substring(NEW."sourceReference" FROM length('referral-milestone:') + 1);
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I."ReferralMilestoneAward"
         WHERE "milestoneId" = $1 AND "authId" = $2 AND "rewardCredits" = $3)',
      TG_TABLE_SCHEMA
    ) INTO v_ok USING v_ref, NEW."authId", NEW."amount";
    IF NOT v_ok THEN
      RAISE EXCEPTION 'Milestone credits require a milestone award of the same referrer and amount'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE "PaymentFingerprint"
  ADD CONSTRAINT "PaymentFingerprint_hash_format" CHECK ("fingerprintHash" ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_eventKey_present" CHECK (btrim("eventKey") <> ''),
  ADD CONSTRAINT "Notification_title_present" CHECK (btrim("title") <> ''),
  ADD CONSTRAINT "Notification_emailAttempts_non_negative" CHECK ("emailAttempts" >= 0),
  ADD CONSTRAINT "Notification_sent_at" CHECK (("emailStatus" = 'SENT') = ("emailSentAt" IS NOT NULL));

CREATE FUNCTION "Notification_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."authId" IS DISTINCT FROM OLD."authId"
    OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."eventKey" IS DISTINCT FROM OLD."eventKey"
    OR NEW."title" IS DISTINCT FROM OLD."title"
    OR NEW."body" IS DISTINCT FROM OLD."body"
    OR NEW."data"::text IS DISTINCT FROM OLD."data"::text
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR (OLD."emailStatus" = 'SENT' AND NEW."emailStatus" <> 'SENT')
    OR (OLD."emailStatus" = 'NOT_REQUESTED' AND NEW."emailStatus" <> 'NOT_REQUESTED')
  THEN
    RAISE EXCEPTION 'A notification cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Notification_protect"
  BEFORE UPDATE ON "Notification"
  FOR EACH ROW EXECUTE FUNCTION "Notification_protect"();
