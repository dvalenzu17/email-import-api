-- TASK 3: Merchant aliases table — maps raw sender domains (and optional subject patterns)
-- to canonical subscription names. Seeded with high-confidence known brands.
-- confidence_boost is added on top of the model score when this alias fires.
-- confirmation_count is incremented by the /admin/merchant-aliases/rebuild route
-- as user feedback accumulates, enabling data-driven alias curation.

CREATE TABLE IF NOT EXISTS merchant_aliases (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_sender_domain   text        NOT NULL,
  subject_pattern     text,
  canonical_name      text        NOT NULL,
  category            text        NOT NULL CHECK (category IN ('streaming','saas','fitness','news','gaming','utilities','other')),
  billing_processors  text[]      DEFAULT '{}',
  confidence_boost    float       DEFAULT 0.0,
  confirmation_count  int         DEFAULT 0,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS merchant_aliases_domain_idx ON merchant_aliases(raw_sender_domain);

-- Seed with known high-value aliases.
-- Disney+ via Apple IAP comes from apple.com with a "disney" subject pattern.
INSERT INTO merchant_aliases (raw_sender_domain, subject_pattern, canonical_name, category, billing_processors, confidence_boost)
VALUES
  ('apple.com',            'disney',  'Disney+',      'streaming',  '{apple_iap}',  0.15),
  ('billing.anthropic.com', NULL,     'Anthropic',    'saas',       '{stripe}',     0.15),
  ('uber.com',              NULL,     'Uber One',     'other',      '{stripe}',     0.15),
  ('netflix.com',           NULL,     'Netflix',      'streaming',  '{direct}',     0.20),
  ('spotify.com',           NULL,     'Spotify',      'streaming',  '{direct}',     0.20),
  ('hulu.com',              NULL,     'Hulu',         'streaming',  '{direct}',     0.15),
  ('disneyplus.com',        NULL,     'Disney+',      'streaming',  '{direct}',     0.20),
  ('amazon.com',            NULL,     'Amazon Prime', 'other',      '{direct}',     0.15),
  ('apple.com',             NULL,     'iCloud+',      'utilities',  '{apple_iap}',  0.15)
ON CONFLICT (raw_sender_domain) DO NOTHING;
