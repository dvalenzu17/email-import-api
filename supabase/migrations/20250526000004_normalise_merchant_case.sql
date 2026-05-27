-- TASK 5: Normalise merchant names for case-insensitive deduplication.
--
-- Step 1: Deduplicate rows where the same user has two case variants of the same
--         merchant (e.g. "netflix" and "Netflix"). Keep the row with the highest
--         confidence; on tie, keep the most recently updated row.
DELETE FROM subscriptions s1
USING subscriptions s2
WHERE s1.user_id  = s2.user_id
  AND LOWER(s1.merchant) = LOWER(s2.merchant)
  AND s1.id != s2.id
  AND (
    s1.confidence < s2.confidence
    OR (s1.confidence = s2.confidence AND s1.updated_at < s2.updated_at)
  );

-- Step 2: Normalise all remaining merchant names to title case.
--   INITCAP lowercases first then capitalises each word boundary — safe for
--   existing values like "NETFLIX", "netflix", "Netflix" → all → "Netflix".
UPDATE subscriptions
SET merchant = INITCAP(LOWER(merchant))
WHERE merchant IS NOT NULL
  AND merchant <> INITCAP(LOWER(merchant));

-- Step 3: Add a case-insensitive unique index so ON CONFLICT (user_id, LOWER(merchant))
--         works in batchUpsertSubscriptions and upsertCancelledSubscriptions.
--         Drop the old exact-match constraint first (may already be gone on fresh DBs).
DO $$
BEGIN
  -- Drop old exact-match unique constraint if it exists under the conventional name.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscriptions_user_id_merchant_key'
      AND conrelid = 'subscriptions'::regclass
  ) THEN
    ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_user_id_merchant_key;
  END IF;
END $$;

-- Create the new case-insensitive unique expression index.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_user_merchant_ci_idx
  ON subscriptions (user_id, LOWER(merchant));
