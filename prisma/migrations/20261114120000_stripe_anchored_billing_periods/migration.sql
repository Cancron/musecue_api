-- Billing periods follow the dates reported by Stripe.
--
-- 20260920120000 required every period to end exactly one calendar month or
-- year after it starts. Stripe anchors a subscription to its original billing
-- day: a subscription started on Jan 31 is billed Feb 28, then Mar 31, then
-- Apr 30 (https://docs.stripe.com/billing/subscriptions/billing-cycle). The
-- renewal Feb 28 -> Mar 31 is not "Feb 28 + 1 month", so the old rule rejected
-- real Stripe renewals.
--
-- A period is now valid when it is either
--   * exactly one calendar month/year long (as before), or
--   * anchored on a day the start month does not have: it starts on the last
--     day of its month and ends later in the following month (following year
--     for YEARLY), at the same time of day.
-- Every period rejected by the previous rule stays rejected unless it starts
-- on a month's last day (e.g. Mar 1 -> Mar 29, Jan 31 -> Mar 3 and
-- Feb 29 -> Mar 1 next year are still invalid). Existing rows satisfy the
-- first form, so they remain valid.
-- Mirrored by isValidBillingPeriod() in src/subscription/billing.validation.ts.

CREATE FUNCTION "billing_period_is_valid"(
  period_start timestamp(3),
  period_end timestamp(3),
  period_length interval
) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT period_end = period_start + period_length
    OR (
      period_start::date
        = (date_trunc('month', period_start) + interval '1 month' - interval '1 day')::date
      AND period_end > period_start + period_length
      AND date_trunc('month', period_end)
        = date_trunc('month', period_start) + period_length
      AND period_end::time = period_start::time
    )
$$;

ALTER TABLE "PaymentTransaction" DROP CONSTRAINT "PaymentTransaction_billing_period";

ALTER TABLE "PaymentTransaction"
  ADD CONSTRAINT "PaymentTransaction_billing_period" CHECK (
    CASE "billingInterval"
      WHEN 'MONTHLY' THEN "billing_period_is_valid"("periodStart", "periodEnd", interval '1 month')
      WHEN 'YEARLY'  THEN "billing_period_is_valid"("periodStart", "periodEnd", interval '1 year')
    END
  );
