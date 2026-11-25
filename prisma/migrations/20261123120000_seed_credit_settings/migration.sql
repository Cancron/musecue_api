-- Stores the default AI credit settings in PostgreSQL, so the configuration
-- exists from the start instead of only after the first administrator save.
-- The values are the column defaults (50 trial credits, 1000 Pro credits per
-- month, 5000 micro-dollars = $0.005 per credit, 5 overage credits per
-- session). ON CONFLICT DO NOTHING keeps a configuration that was already
-- saved: an existing row is never overwritten.
INSERT INTO "CreditSettings" ("id", "updatedAt")
VALUES ('default', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
