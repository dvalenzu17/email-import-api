-- TASK 1: Add extraction_log jsonb column to subscriptions table.
-- Records per-field extraction strategy telemetry from emailParser.js so we can
-- diagnose which parsing path fired for each detected subscription and identify
-- systematic failures (null fields, fallback strategies, etc.).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS extraction_log jsonb;
