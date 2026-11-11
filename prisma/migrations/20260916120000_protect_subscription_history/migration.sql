-- Makes subscription history permanent at the database level, so no code path
-- (current or future, e.g. payments or support scripts) can make a user
-- eligible for the free trial again or extend a trial:
--   * once a trial has started, its dates never change and trialUsed stays true;
--   * a paid Pro term can be replaced (renewal/repurchase) but never cleared;
--   * the record cannot be deleted while its user exists (deleting the user
--     still removes it through ON DELETE CASCADE).
-- Prisma does not model triggers; they are kept in migrations only.

CREATE FUNCTION "UserSubscription_protect_history"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_exists boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- During a cascade from authUser the owner row is already gone.
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I."authUser" WHERE "id" = $1)',
      TG_TABLE_SCHEMA
    ) INTO owner_exists USING OLD."authId";
    IF owner_exists THEN
      RAISE EXCEPTION 'UserSubscription history cannot be deleted while its user exists'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."trialUsed" AND NOT NEW."trialUsed" THEN
    RAISE EXCEPTION 'UserSubscription trial usage cannot be reset'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."trialStartedAt" IS NOT NULL AND (
    NEW."trialStartedAt" IS DISTINCT FROM OLD."trialStartedAt"
    OR NEW."trialExpiresAt" IS DISTINCT FROM OLD."trialExpiresAt"
  ) THEN
    RAISE EXCEPTION 'UserSubscription trial dates cannot change once the trial has started'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."proStartedAt" IS NOT NULL AND NEW."proStartedAt" IS NULL THEN
    RAISE EXCEPTION 'UserSubscription paid Pro history cannot be cleared'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "UserSubscription_protect_history"
  BEFORE UPDATE OR DELETE ON "UserSubscription"
  FOR EACH ROW EXECUTE FUNCTION "UserSubscription_protect_history"();
