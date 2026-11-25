-- Lets expiring credits be expired before their expiresAt: trial credits end
-- when a paid Pro term starts during the trial. Previously an allocation
-- could only expire at or after expiresAt.
--
-- Still enforced: only allocations with an expiry (TRIAL, SUBSCRIPTION) can
-- be expired, so purchased and referral credits never can; an expired
-- allocation has nothing left; it cannot expire before it was granted; and
-- expiresAt itself stays immutable (trigger), so the original terms remain
-- traceable next to the actual expiry time (expiredAt and the EXPIRATION
-- ledger transaction).
ALTER TABLE "CreditAllocation" DROP CONSTRAINT "CreditAllocation_expired_state";
ALTER TABLE "CreditAllocation"
  ADD CONSTRAINT "CreditAllocation_expired_state" CHECK (
    "expiredAt" IS NULL
    OR ("expiresAt" IS NOT NULL AND "remainingCredits" = 0 AND "expiredAt" >= "grantedAt")
  );
