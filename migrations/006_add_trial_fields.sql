-- Trial pre-emption fields.
--
-- The whole trial machine (frontend TrialRadarCard + client reminders, backend
-- trial-ending ladder in getDueTrialAlerts) keys off `trial_end`, but nothing
-- ever populated it — so pre-emption was inert. This lets the scan write the
-- parsed first-bill date of a trial confirmation onto the subscription.
--
-- IF NOT EXISTS: the frontend already reads these, so a column may exist from an
-- out-of-band change; this makes the migration safe to run either way.

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_end TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS is_trial  BOOLEAN NOT NULL DEFAULT FALSE;

-- The trial ladder scans for upcoming trial_end dates.
CREATE INDEX IF NOT EXISTS subscriptions_trial_end_idx ON subscriptions (trial_end)
  WHERE trial_end IS NOT NULL;
