-- Credits granted by loyalty missions. In a migration of its own: a new enum
-- value cannot be used in the transaction that adds it, and the next
-- migration (20261207130000_daily_reward_streaks_loyalty_missions) uses it.
ALTER TYPE "CreditSource" ADD VALUE 'MISSION_REWARD';
