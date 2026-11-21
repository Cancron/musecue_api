-- Credit management review: database rules matching the application's.

-- The deduction step is at most one credit (the API's upper bound).
ALTER TABLE "CreditSettings"
  ADD CONSTRAINT "CreditSettings_deductionStepMicroCredits_max"
  CHECK ("deductionStepMicroCredits" <= 1000000);

-- A charged AI usage matches the DEBIT it links to: the same cost, the same
-- conversion rate, and the credits charged are exactly what the DEBIT took
-- from the balance plus its session overage.
CREATE FUNCTION "AiUsage_charge_matches_transaction"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tx_type text;
  tx_amount numeric;
  tx_overage numeric;
  tx_cost numeric;
  tx_rate integer;
  tx_auth text;
  tx_session text;
BEGIN
  IF NEW."transactionId" IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format(
    'SELECT "type"::text, "amount", "overageAmount", "usageCostUsd", "creditCostUsdMicros", "authId", "sessionId" FROM %I."CreditTransaction" WHERE "id" = $1',
    TG_TABLE_SCHEMA
  ) INTO tx_type, tx_amount, tx_overage, tx_cost, tx_rate, tx_auth, tx_session
    USING NEW."transactionId";
  IF tx_type IS DISTINCT FROM 'DEBIT'
    OR tx_auth IS DISTINCT FROM NEW."authId"
    OR tx_session IS DISTINCT FROM NEW."sessionId"
    OR tx_cost IS DISTINCT FROM NEW."costUsd"
    OR tx_rate IS DISTINCT FROM NEW."creditCostUsdMicros"
    OR (tx_overage - tx_amount) IS DISTINCT FROM NEW."creditsCharged" THEN
    RAISE EXCEPTION 'AiUsage % does not match its DEBIT transaction %', NEW."id", NEW."transactionId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiUsage_charge_matches_transaction"
  BEFORE INSERT OR UPDATE ON "AiUsage"
  FOR EACH ROW EXECUTE FUNCTION "AiUsage_charge_matches_transaction"();

-- Existing data must already satisfy the rule.
DO $$
DECLARE
  mismatched integer;
BEGIN
  SELECT count(*) INTO mismatched
  FROM "AiUsage" u
  JOIN "CreditTransaction" t ON t."id" = u."transactionId"
  WHERE t."type" <> 'DEBIT'
    OR t."authId" <> u."authId"
    OR t."sessionId" IS DISTINCT FROM u."sessionId"
    OR t."usageCostUsd" IS DISTINCT FROM u."costUsd"
    OR t."creditCostUsdMicros" IS DISTINCT FROM u."creditCostUsdMicros"
    OR (t."overageAmount" - t."amount") IS DISTINCT FROM u."creditsCharged";
  IF mismatched > 0 THEN
    RAISE EXCEPTION '% AI usage charges do not match their DEBIT transactions', mismatched;
  END IF;
END $$;
