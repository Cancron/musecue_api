-- Integrity hardening of MFA records (review of the MFA implementation).
--
-- - "MfaSmsCode"."deliveredAt": a code counts as sent only once the SMS
--   provider accepted it; a code is never used without it (CHECK), so a code
--   whose delivery failed stays unusable even if ending it fails too.
-- - Ended or expired credentials can never become active again, whatever the
--   application does: MFA sign-in challenges (consumption permanent, expiry
--   and owner fixed), step-up approvals (immutable) and refresh sessions
--   (revocation permanent, owner, token and expiry fixed).
--
-- Additive: existing rows already satisfy every rule.

-- AlterTable
ALTER TABLE "MfaSmsCode" ADD COLUMN     "deliveredAt" TIMESTAMP(3);

-- Codes sent before this migration were delivered when created.
UPDATE "MfaSmsCode" SET "deliveredAt" = "createdAt";

ALTER TABLE "MfaSmsCode" ADD CONSTRAINT "MfaSmsCode_delivered_before_use_check"
    CHECK ("usedAt" IS NULL OR ("deliveredAt" IS NOT NULL AND "usedAt" >= "deliveredAt"));

-- The code rules, now with delivery: issued undelivered and open; delivered
-- at most once while open; ended for good; nothing else changes.
CREATE OR REPLACE FUNCTION "MfaSmsCode_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."usedAt" IS NOT NULL OR NEW."invalidatedAt" IS NOT NULL
      OR NEW."deliveredAt" IS NOT NULL
    THEN
      RAISE EXCEPTION 'MfaSmsCode must be issued open and undelivered'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."authId" IS DISTINCT FROM OLD."authId"
    OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
    OR NEW."phoneId" IS DISTINCT FROM OLD."phoneId"
    OR NEW."challengeId" IS DISTINCT FROM OLD."challengeId"
    OR NEW."destination" IS DISTINCT FROM OLD."destination"
    OR NEW."codeHash" IS DISTINCT FROM OLD."codeHash"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
  THEN
    RAISE EXCEPTION 'MfaSmsCode cannot change except to deliver or end it'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD."usedAt" IS NOT NULL AND NEW."usedAt" IS DISTINCT FROM OLD."usedAt")
    OR (OLD."invalidatedAt" IS NOT NULL AND NEW."invalidatedAt" IS DISTINCT FROM OLD."invalidatedAt")
  THEN
    RAISE EXCEPTION 'An ended MfaSmsCode cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."deliveredAt" IS DISTINCT FROM OLD."deliveredAt" AND (
    OLD."deliveredAt" IS NOT NULL
    OR OLD."usedAt" IS NOT NULL
    OR OLD."invalidatedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Only an open, undelivered MfaSmsCode can be delivered'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- An MFA sign-in challenge is issued unconsumed, belongs to one user for
-- good, can never be extended, and its consumption is permanent.
CREATE FUNCTION "MfaLoginChallenge_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."consumedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'MfaLoginChallenge must be issued unconsumed'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."authId" IS DISTINCT FROM OLD."authId"
    OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
  THEN
    RAISE EXCEPTION 'MfaLoginChallenge owner, token and expiry cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."consumedAt" IS NOT NULL AND NEW."consumedAt" IS DISTINCT FROM OLD."consumedAt" THEN
    RAISE EXCEPTION 'A consumed MfaLoginChallenge cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MfaLoginChallenge_protect"
  BEFORE INSERT OR UPDATE ON "MfaLoginChallenge"
  FOR EACH ROW EXECUTE FUNCTION "MfaLoginChallenge_protect"();

-- A step-up approval never changes: it is valid for its user, session,
-- action and ten minutes, or deleted.
CREATE FUNCTION "StepUpApproval_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'StepUpApproval cannot change'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "StepUpApproval_protect"
  BEFORE UPDATE ON "StepUpApproval"
  FOR EACH ROW EXECUTE FUNCTION "StepUpApproval_protect"();

-- A refresh session belongs to one user and sign-in session for good, its
-- token and lifetime never change, and a revocation is permanent (a revoked
-- session can never be refreshed or used again). Only its MFA proof may be
-- updated (and the link to a deleted predecessor cleared).
CREATE FUNCTION "RefreshSession_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."authId" IS DISTINCT FROM OLD."authId"
    OR NEW."familyId" IS DISTINCT FROM OLD."familyId"
    OR NEW."tokenId" IS DISTINCT FROM OLD."tokenId"
    OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
  THEN
    RAISE EXCEPTION 'RefreshSession owner, token and lifetime cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."revokedAt" IS NOT NULL AND (
    NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt"
    OR NEW."revokedReason" IS DISTINCT FROM OLD."revokedReason"
  ) THEN
    RAISE EXCEPTION 'A revoked RefreshSession cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "RefreshSession_protect"
  BEFORE UPDATE ON "RefreshSession"
  FOR EACH ROW EXECUTE FUNCTION "RefreshSession_protect"();
