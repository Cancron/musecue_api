-- Manual grant of purchased or referral credits directly in PostgreSQL, until
-- purchases and referrals are implemented in the application:
--
--   SELECT "Credit_grant_manual"('<authUser id>', 'PURCHASE', 'support-ticket-123', 100);
--   SELECT "Credit_grant_manual"('<authUser id>', 'REFERRAL', 'referral-456', 25.5);
--
-- Plain INSERTs into the credit tables are rejected by the ledger rules
-- (balances must match the ledger), so this function writes the complete,
-- consistent set of rows: the wallet (if missing), the allocation, an
-- ALLOCATION ledger transaction (reference 'manual-grant') and its entry,
-- under the same wallet row lock the application uses. These credits never
-- expire. (source, reference) identifies the grant: repeating the same call
-- returns the existing allocation instead of adding credits again.
-- Returns the allocation id.

CREATE FUNCTION "Credit_grant_manual"(
  p_auth_id text,
  p_source "CreditSource",
  p_source_reference text,
  p_credits numeric
) RETURNS text
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  reference text := btrim(p_source_reference);
  -- Application timestamps are stored in UTC (TIMESTAMP(3) without zone).
  now_utc timestamp(3) := (clock_timestamp() AT TIME ZONE 'UTC');
  wallet RECORD;
  existing RECORD;
  last_sequence integer;
  allocation_id text := gen_random_uuid()::text;
  transaction_id text := gen_random_uuid()::text;
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('PURCHASE', 'REFERRAL') THEN
    RAISE EXCEPTION 'Only PURCHASE and REFERRAL credits can be granted manually'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_credits IS NULL OR p_credits <= 0 OR p_credits > 1000000000
     OR p_credits <> round(p_credits, 6) THEN
    RAISE EXCEPTION 'Credits must be greater than 0 and at most 1000000000, with at most 6 decimal places'
      USING ERRCODE = 'check_violation';
  END IF;
  IF reference IS NULL OR length(reference) = 0 OR length(reference) > 200 THEN
    RAISE EXCEPTION 'A source reference of 1 to 200 characters is required'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "authUser" WHERE "id" = p_auth_id) THEN
    RAISE EXCEPTION 'User % does not exist', p_auth_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO "CreditWallet" ("id", "authId", "createdAt", "updatedAt")
  VALUES (gen_random_uuid()::text, p_auth_id, now_utc, now_utc)
  ON CONFLICT ("authId") DO NOTHING;
  SELECT "id", "balanceCredits", "outstandingOverageCredits" INTO wallet
    FROM "CreditWallet" WHERE "authId" = p_auth_id FOR UPDATE;

  SELECT "id", "walletId", "grantedCredits" INTO existing
    FROM "CreditAllocation" WHERE "source" = p_source AND "sourceReference" = reference;
  IF FOUND THEN
    IF existing."walletId" = wallet."id" AND existing."grantedCredits" = p_credits THEN
      RETURN existing."id";
    END IF;
    RAISE EXCEPTION 'Credit source % "%" was already granted with different terms or to another user', p_source, reference
      USING ERRCODE = 'unique_violation';
  END IF;
  IF wallet."outstandingOverageCredits" > 0 THEN
    RAISE EXCEPTION 'The wallet has unpaid session overage; grant these credits through CreditWalletService.allocate, which repays it'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(MAX("sequence"), 0) INTO last_sequence
    FROM "CreditTransaction" WHERE "walletId" = wallet."id";

  INSERT INTO "CreditAllocation"
    ("id", "walletId", "source", "sourceReference", "grantedCredits", "remainingCredits", "grantedAt", "updatedAt")
  VALUES (allocation_id, wallet."id", p_source, reference, p_credits, p_credits, now_utc, now_utc);
  INSERT INTO "CreditTransaction"
    ("id", "walletId", "sequence", "type", "amountCredits", "overageChangeCredits",
     "balanceAfterCredits", "outstandingOverageAfterCredits", "idempotencyKey",
     "allocationId", "reference", "effectiveAt", "createdAt")
  VALUES (transaction_id, wallet."id", last_sequence + 1, 'ALLOCATION', p_credits, 0,
          wallet."balanceCredits" + p_credits, 0, 'allocation:' || allocation_id,
          allocation_id, 'manual-grant', now_utc, now_utc);
  INSERT INTO "CreditTransactionEntry" ("id", "transactionId", "walletId", "allocationId", "amountCredits")
  VALUES (gen_random_uuid()::text, transaction_id, wallet."id", allocation_id, p_credits);
  UPDATE "CreditWallet"
    SET "balanceCredits" = "balanceCredits" + p_credits, "updatedAt" = now_utc
    WHERE "id" = wallet."id";

  RETURN allocation_id;
END;
$$;
