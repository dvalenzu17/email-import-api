-- Migration 001 — Performance indexes
-- Run this once against your Supabase database.
-- These indexes support the lookup patterns used in every scan and credential fetch.

-- subscriptions: primary lookup is (user_id, merchant) — used by ON CONFLICT and SELECT
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_merchant
  ON subscriptions (user_id, merchant);

-- subscriptions: pagination query orders by created_at DESC
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_created
  ON subscriptions (user_id, created_at DESC);

-- imap_credentials: lookup is always (user_id, provider)
CREATE INDEX IF NOT EXISTS idx_imap_credentials_user_provider
  ON imap_credentials (user_id, provider);

-- scan_metadata: cleanup and latest-fetch both filter by user_id, order by created_at DESC
CREATE INDEX IF NOT EXISTS idx_scan_metadata_user_created
  ON scan_metadata (user_id, created_at DESC);
