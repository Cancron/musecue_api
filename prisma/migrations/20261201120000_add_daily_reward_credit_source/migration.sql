-- Credits granted by daily reward claims. In a migration of its own: a new
-- enum value cannot be used in the transaction that adds it, and the next
-- migration (20261201130000_add_daily_reward_claims) uses it.
ALTER TYPE "CreditSource" ADD VALUE 'DAILY_REWARD';
