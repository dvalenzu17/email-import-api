-- Migration 003 — ML feedback dataset
-- Stores user-confirmed / user-rejected detections as labeled training data.
-- The features jsonb column captures the detection feature vector at the time
-- of feedback so the model can be retrained without re-scanning emails.

CREATE TABLE IF NOT EXISTS subscription_feedback (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL,
  subscription_id uuid        NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  -- 'confirmed' = user says this IS a real subscription
  -- 'rejected'  = user says this is NOT a subscription (false positive)
  label           text        NOT NULL CHECK (label IN ('confirmed', 'rejected')),
  -- Snapshot of the feature vector used at detection time:
  -- { occ_norm, interval_score, amount_score, intent_score, known_brand }
  features        jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT NOW()
);

-- One feedback row per user+subscription (latest wins via upsert in app layer).
CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_unique
  ON subscription_feedback (user_id, subscription_id);

CREATE INDEX IF NOT EXISTS idx_feedback_user_id
  ON subscription_feedback (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_label
  ON subscription_feedback (label, created_at DESC);
