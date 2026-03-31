-- Migration 004 — Currency field + anomaly flag
-- Run this once against your Supabase database.

-- Add currency column to subscriptions (defaults to USD for existing rows).
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD';

-- Add anomaly flag to subscription_events.
-- Set by the upsert pipeline when a new charge amount deviates significantly
-- from the subscription's historical billing amounts.
ALTER TABLE subscription_events
  ADD COLUMN IF NOT EXISTS is_anomalous boolean NOT NULL DEFAULT false;

-- Index for anomaly queries — useful for anomaly reporting endpoints later.
CREATE INDEX IF NOT EXISTS idx_sub_events_anomalous
  ON subscription_events (user_id, is_anomalous, detected_at DESC)
  WHERE is_anomalous = true;
