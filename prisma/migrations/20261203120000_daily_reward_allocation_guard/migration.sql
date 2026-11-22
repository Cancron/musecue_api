-- DAILY_REWARD credits may only be allocated for a recorded daily reward
-- claim: the allocation's reference names the claimed UTC day
-- (`daily-reward:<YYYY-MM-DD>`) and its amount equals the credits the claim
-- granted. Claims are capped at 600 credits per user and UTC month
-- (migration 20261201130000_add_daily_reward_claims) and there is at most one
-- allocation per (wallet, source, reference), so no write path (the wallet
-- service or manual SQL) can allocate more daily reward credits than the cap.
CREATE FUNCTION "CreditAllocation_daily_reward_claim_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_day text;
  v_claimed boolean;
BEGIN
  IF NEW."source" <> 'DAILY_REWARD' THEN
    RETURN NEW;
  END IF;
  v_day := substring(NEW."sourceReference" FROM '^daily-reward:(\d{4}-\d{2}-\d{2})$');
  IF v_day IS NULL THEN
    RAISE EXCEPTION 'Daily reward credits must reference a claimed day (daily-reward:YYYY-MM-DD)'
      USING ERRCODE = 'check_violation';
  END IF;
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I."DailyRewardClaim"
       WHERE "authId" = $1 AND "claimDate" = $2::date AND "grantedCredits" = $3)',
    TG_TABLE_SCHEMA
  ) INTO v_claimed USING NEW."authId", v_day, NEW."amount";
  IF NOT v_claimed THEN
    RAISE EXCEPTION 'Daily reward credits require a recorded daily reward claim of the same amount'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditAllocation_daily_reward_claim_check"
  BEFORE INSERT ON "CreditAllocation"
  FOR EACH ROW EXECUTE FUNCTION "CreditAllocation_daily_reward_claim_check"();
