-- Gmail real-time push (users.watch + Pub/Sub) state.
--
-- One row per connected Gmail account. `email` is the map from an incoming
-- Pub/Sub notification (which carries emailAddress) back to our user. Watches
-- expire within 7 days, so `expiration` drives the renewal cron.

CREATE TABLE IF NOT EXISTS gmail_watch (
  user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  history_id  TEXT,
  expiration  TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Incoming pushes look up by email; renewal cron scans by expiration.
CREATE UNIQUE INDEX IF NOT EXISTS gmail_watch_email_idx ON gmail_watch (LOWER(email));
CREATE INDEX IF NOT EXISTS gmail_watch_expiration_idx ON gmail_watch (expiration);
