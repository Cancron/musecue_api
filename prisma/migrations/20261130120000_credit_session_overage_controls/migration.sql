-- Session overage controls enforced by PostgreSQL, whatever code path writes
-- to the credit tables:
--   * a user's unpaid overage (CreditWallet.outstandingOverageCredits, the
--     sum over all their sessions) can never increase beyond the overage
--     allowance in CreditSettings, so concurrent or multiple sessions cannot
--     each add the allowance (lowering the allowance later does not
--     invalidate overage that is already outstanding);
--   * session overage records and ledger transactions that name a makeup
--     session are recorded for a session of the wallet's own user.

CREATE FUNCTION "CreditWallet_check_overage_allowance"() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  allowance numeric;
BEGIN
  IF NEW."outstandingOverageCredits" > OLD."outstandingOverageCredits" THEN
    SELECT "sessionOverageAllowanceCredits" INTO allowance
      FROM "CreditSettings" WHERE "id" = 'default';
    IF NEW."outstandingOverageCredits" > COALESCE(allowance, 0) THEN
      RAISE EXCEPTION 'Credit wallet % overage % exceeds the overage allowance %',
        NEW."id", NEW."outstandingOverageCredits", COALESCE(allowance, 0)
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditWallet_check_overage_allowance" BEFORE UPDATE ON "CreditWallet"
  FOR EACH ROW EXECUTE FUNCTION "CreditWallet_check_overage_allowance"();

CREATE FUNCTION "Credit_check_session_owner"() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW."sessionId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "MakeupSession" s
    JOIN "CreditWallet" w ON w."authId" = s."authId"
    WHERE s."id" = NEW."sessionId" AND w."id" = NEW."walletId"
  ) THEN
    RAISE EXCEPTION '% must belong to a makeup session of the wallet''s user', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditSessionOverage_check_session_owner" BEFORE INSERT ON "CreditSessionOverage"
  FOR EACH ROW EXECUTE FUNCTION "Credit_check_session_owner"();
CREATE TRIGGER "CreditTransaction_check_session_owner" BEFORE INSERT ON "CreditTransaction"
  FOR EACH ROW EXECUTE FUNCTION "Credit_check_session_owner"();
