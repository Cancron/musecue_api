-- Fixes two billing validation gaps from 20260918120000:
--
-- 1. Billing periods were checked as a range of days (28-31 / 365-366), which
--    accepted non-calendar periods such as Mar 1 -> Mar 29. A period now ends
--    exactly one calendar month or year after it starts, using PostgreSQL
--    calendar arithmetic: month-ends clamp (Jan 31 -> Feb 28, or Feb 29 in a
--    leap year) and Feb 29 + 1 year -> Feb 28. This matches
--    addBillingInterval() in src/subscription/billing.validation.ts.
--
-- 2. A paid term only had to end at a verified payment's period end, so an
--    initial term could start before its paid period and a renewal could
--    bridge an unpaid gap. Now the newly granted range must be covered by one
--    SUCCEEDED payment:
--      * new term (first purchase, repurchase after a lapse, or start moved
--        earlier): [proStartedAt, proExpiresAt) must lie within the payment;
--      * renewal (same term extended): [old proExpiresAt, new proExpiresAt)
--        must lie within the payment, so its period must start no later than
--        the old expiry. Overlap (early renewal, interval change) is allowed;
--        a gap is not.

ALTER TABLE "PaymentTransaction" DROP CONSTRAINT "PaymentTransaction_billing_period";

ALTER TABLE "PaymentTransaction"
  ADD CONSTRAINT "PaymentTransaction_billing_period" CHECK (
    CASE "billingInterval"
      WHEN 'MONTHLY' THEN "periodEnd" = "periodStart" + interval '1 month'
      WHEN 'YEARLY'  THEN "periodEnd" = "periodStart" + interval '1 year'
    END
  );

CREATE OR REPLACE FUNCTION "UserSubscription_paid_term_requires_verified_payment"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_term boolean;
  grant_from timestamp(3);
  covered boolean;
BEGIN
  IF NEW."proStartedAt" IS NULL THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    new_term := true;
  ELSE
    new_term := OLD."proStartedAt" IS NULL
      OR NEW."proStartedAt" < OLD."proStartedAt"
      OR NEW."proStartedAt" >= OLD."proExpiresAt";
  END IF;

  IF new_term THEN
    grant_from := NEW."proStartedAt";
  ELSE
    -- Same term: only an extension grants new access.
    IF NEW."proExpiresAt" <= OLD."proExpiresAt" THEN
      RETURN NULL;
    END IF;
    grant_from := OLD."proExpiresAt";
  END IF;

  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I."PaymentTransaction"
       WHERE "subscriptionId" = $1 AND "status" = ''SUCCEEDED''
         AND "billingInterval" = $2
         AND "periodEnd" = $3 AND "periodStart" <= $4)',
    TG_TABLE_SCHEMA
  ) INTO covered
  USING NEW."id", NEW."billingInterval", NEW."proExpiresAt", grant_from;

  IF NOT covered THEN
    RAISE EXCEPTION 'UserSubscription paid term requires a verified (SUCCEEDED) payment covering % to %', grant_from, NEW."proExpiresAt"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
