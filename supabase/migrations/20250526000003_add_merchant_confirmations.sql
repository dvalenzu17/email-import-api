-- TASK 4: Merchant confirmations table — captures per-user explicit confirmations
-- and rejections of detected subscriptions. Aggregated by the
-- POST /admin/merchant-aliases/rebuild route to auto-promote high-confidence
-- domain→canonical_name mappings into merchant_aliases.

CREATE TABLE IF NOT EXISTS merchant_confirmations (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        REFERENCES auth.users(id) ON DELETE CASCADE,
  merchant_domain  text        NOT NULL,
  canonical_name   text        NOT NULL,
  confirmed        boolean     NOT NULL,
  amount           float,
  interval         text,
  created_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS merchant_confirmations_domain_idx ON merchant_confirmations(merchant_domain);
CREATE INDEX IF NOT EXISTS merchant_confirmations_user_idx   ON merchant_confirmations(user_id);
