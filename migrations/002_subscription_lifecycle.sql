-- Migration 002 — Subscription lifecycle tracking
-- Run this once against your Supabase database.

-- last_seen_at: updated every scan when a subscription is detected.
-- Drives the isActive staleness check — if not seen in 2× billing period, marked inactive.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT NOW();

-- user_status: manual override set by the user via PATCH /subscriptions/:id.
-- NULL = algorithmic status applies.
-- 'confirmed'  = user asserts this is a real subscription (locks is_active = true).
-- 'cancelled'  = user marked it cancelled (locks is_active = false).
-- 'ignored'    = user wants to hide it from view.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS user_status text
    CHECK (user_status IN ('confirmed', 'cancelled', 'ignored'))
    DEFAULT NULL;

-- subscription_events: one row per detection occurrence.
-- Replaces the "only keep latest" model with a full audit trail.
CREATE TABLE IF NOT EXISTS subscription_events (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL,
  subscription_id uuid       NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  event_type     text        NOT NULL
    CHECK (event_type IN ('detected', 'resumed', 'cancelled', 'confirmed', 'ignored')),
  amount         numeric,
  source         text,
  detected_at    timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sub_events_sub_id
  ON subscription_events (subscription_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_sub_events_user_id
  ON subscription_events (user_id, detected_at DESC);

-- Index for staleness queries
CREATE INDEX IF NOT EXISTS idx_subscriptions_last_seen
  ON subscriptions (user_id, last_seen_at);
