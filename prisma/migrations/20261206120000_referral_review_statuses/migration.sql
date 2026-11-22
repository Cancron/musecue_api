-- Suspicious referrals wait for an administrator (HELD) who approves or
-- rejects (REJECTED) them. In a migration of its own: new enum values cannot
-- be used in the transaction that adds them (the next migration does).
ALTER TYPE "ReferralStatus" ADD VALUE 'HELD';
ALTER TYPE "ReferralStatus" ADD VALUE 'REJECTED';
