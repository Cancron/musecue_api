-- Stores the default AI credit settings in PostgreSQL, so the configuration
-- exists before any administrator change. The values come from the column
-- defaults (50 trial credits, 1000 Pro credits per month, 5000 USD micros =
-- $0.005 per credit, 5 overage credits per session). A row that already
-- exists (saved by an administrator) is left unchanged. The application also
-- runs the same insert at startup (CreditSettingsService.ensureDefaults),
-- which likewise never overwrites a stored row.
INSERT INTO "CreditSettings" ("id", "updatedAt")
VALUES (1, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
