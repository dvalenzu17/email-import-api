# email-import-api — CLAUDE.md

## What this is

The email-import-api is the backend for BeforeItBills (BIB) — a consumer subscription tracker. It scans users' email inboxes (Gmail via OAuth, or Yahoo/Outlook/iCloud via IMAP), extracts recurring billing charges, scores them with a logistic regression ML model, and persists detected subscriptions to Supabase PostgreSQL.

It is the source repo for the detection engine later spun out into `subscan-api`.

---

## Stack

- **Runtime**: Node.js (ESM, `"type": "module"`)
- **Framework**: Fastify 4
- **Database**: PostgreSQL via Supabase (`pg` pool + Supabase admin client)
- **Auth**: Supabase JWT (`SUPABASE_JWT_SECRET`) — every route calls `verifyUserId()`
- **Queue**: BullMQ + Redis (optional, `QUEUE_ENABLED=true`)
- **Deploy target**: Render

---

## Repo structure

```
email-import-api/
├── src/
│   ├── server.js                    — Fastify instance, plugin registration, route registration
│   ├── gmailClient.js               — Gmail API message fetch + text extraction
│   ├── googleOAuth.js               — OAuth token exchange & refresh helpers
│   ├── db/
│   │   └── index.js                 — All DB queries (pg pool); scoped by user_id
│   ├── routes/
│   │   ├── scanRoutes.js            — POST /scan, GET /scan/:jobId/status, GET /scan/:jobId/events
│   │   ├── subscriptionRoutes.js    — GET /subscriptions, PATCH /subscriptions/:id, POST /subscriptions/:id/feedback
│   │   ├── oauthRoutes.js           — GET /auth/google, GET /auth/google/callback, POST /oauth/google/exchange
│   │   └── imapScanRoutes.js        — POST /scan/imap/verify, POST /scan/imap
│   └── services/
│       ├── subscriptionEngine.js    — Core: groups charges by merchant, scores confidence, detects interval
│       ├── subscriptionModel.js     — ML: logistic regression (loads model/weights.json)
│       ├── modelFeatures.js         — Feature vector extraction (occ_norm, interval_score, amount_score, intent_score, known_brand)
│       ├── emailParser.js           — Amount/merchant/currency extraction from email text
│       ├── gmailScanService.js      — Gmail scan orchestration: fetch → parse → dedupe → score → upsert
│       ├── imapClient.js            — IMAP two-pass scan (envelopes first, full source second)
│       ├── anomalyDetector.js       — Z-score anomaly detection on charge amounts
│       ├── scanQueue.js             — BullMQ queue + worker setup
│       ├── messageCache.js          — In-memory dedup of processed Gmail message IDs
│       ├── crypto.js                — AES-256-GCM credential encryption (key: TOKEN_ENCRYPTION_KEY)
│       ├── retryUtil.js             — Exponential backoff + circuit breaker
│       ├── merchantNormalizer.js    — Merchant name normalisation (Netflix → netflix)
│       └── knownBrands.js           — Known brand list with confirmSingle flags
├── migrations/
│   ├── 001_add_performance_indexes.sql
│   ├── 002_subscription_lifecycle.sql  — last_seen_at, user_status, subscription_events
│   ├── 003_ml_feedback.sql             — subscription_feedback table
│   └── 004_currency_and_anomaly.sql    — currency column, is_anomalous flag
├── model/
│   ├── weights.json                 — Logistic regression weights (retrained via scripts/trainModel.js)
├── scripts/
│   ├── localScan.js                 — CLI: scan a user's inbox locally
│   └── trainModel.js                — Retrain ML model from feedback data
└── package.json
```

---

## Auth flow

Every route extracts the Supabase JWT from `Authorization: Bearer <token>`, verifies it against `SUPABASE_JWT_SECRET`, and calls `verifyUserId(req, reply)` which returns `userId = decoded.sub`.

All DB queries are scoped `WHERE user_id = $1`. There is no session, no cookie, no API key.

---

## Data model

**`oauth_tokens`** — Google OAuth credentials per user
- `user_id` UUID, `provider` TEXT, `access_token`, `refresh_token`, `expiry_date`
- UNIQUE `(user_id, provider)`

**`subscriptions`** — Detected recurring charges
- `id` UUID PK, `user_id` UUID
- `merchant` TEXT, `renewal_amount` NUMERIC, `currency` TEXT (default `USD`)
- `renewal_date` TIMESTAMPTZ, `billing_interval` TEXT (`weekly` | `monthly` | `quarterly` | `semi-annual` | `yearly` | `unknown`)
- `confidence` NUMERIC (0–1), `is_active` BOOLEAN, `is_suggested` BOOLEAN
- `source` TEXT (`gmail` | `imap:{provider}`)
- `user_status` TEXT (`confirmed` | `cancelled` | `ignored` | NULL) — manual override
- `last_seen_at` TIMESTAMPTZ — drives staleness logic
- UNIQUE `(user_id, merchant)`

**`subscription_events`** — Full audit trail of detections
- `event_type` TEXT (`detected` | `resumed` | `cancelled` | `confirmed` | `ignored`)
- `is_anomalous` BOOLEAN — set by anomalyDetector

**`scan_metadata`** — Per-scan stats (messages, charges, execution time)

**`imap_credentials`** — Encrypted IMAP credentials per user+provider

**`subscription_feedback`** — ML training data: `label` (`confirmed` | `rejected`) + JSONB feature vector

---

## Confidence score thresholds

| Source | Confirmed | Suggested (isSuggested=true) |
|--------|-----------|------------------------------|
| Gmail  | ≥ 0.50    | 0.50–0.84                    |
| IMAP   | ≥ 0.70    | 0.70–0.84                    |

Staleness decay: subscriptions not seen in 2× their billing period are marked inactive (unless `user_status = 'confirmed'`).

---

## API routes

```
POST /scan                      — Trigger Gmail scan (sync or queued)
GET  /scan/:jobId/status        — Poll queued job status
GET  /scan/:jobId/events        — SSE stream of scan progress
GET  /subscriptions             — List subscriptions (paginated: ?limit=&offset=)
PATCH /subscriptions/:id        — Set user_status (confirmed/cancelled/ignored)
POST /subscriptions/:id/feedback — Submit ML feedback label
GET  /auth/google               — Initiate Google OAuth (redirects to consent screen)
GET  /auth/google/callback      — OAuth callback, saves tokens
POST /oauth/google/exchange     — PKCE token exchange for iOS native app
POST /scan/imap/verify          — Test IMAP credentials (no scan)
POST /scan/imap                 — Scan IMAP inbox
```

---

## Environment variables

```
PORT=8787
DATABASE_URL=postgresql://...
SUPABASE_URL=https://...
SUPABASE_JWT_SECRET=...
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
TOKEN_ENCRYPTION_KEY=   # 32-byte hex or base64 — AES key for crypto.js
QUEUE_ENABLED=false     # set true to enable BullMQ
REDIS_URL=              # only needed if QUEUE_ENABLED=true
```

---

## Commands

```bash
npm run dev        # node --watch src/server.js
npm start          # node src/server.js
npm run local:scan # scripts/localScan.js
```

---

## Rules for Claude working in this repo

- All DB queries must be scoped by `user_id` — never query without a user filter.
- Auth is Supabase JWT only — `verifyUserId()` in every route, no exceptions.
- The `user_id` in all tables is the Supabase `auth.users.id` (the JWT `sub` claim).
- When adding a new route, register it in `server.js`. No route logic in `server.js`.
- When adding a new DB function, it goes in `src/db/index.js`.
- Migrations go in `migrations/` numbered sequentially. Never modify existing migrations.

> Shared rules (ESM, no credential logging, no modifying detection engine) are in `C:/dev/CLAUDE.md`.

---

## What is NOT in this repo

- Frontend (lives in `sublytics/`)
- Stripe / payment handling
- Admin provisioning (those are in `subscan-api`)
- Model retraining automation (manual via `scripts/trainModel.js`)
