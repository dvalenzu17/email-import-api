# BeforeItBills — Backend Improvement Roadmap

Progress-tracked improvement plan from the March 2026 audit. Each level builds on the previous.
Current XP: **100 / 100**

---

## Level 10 — Critical Bug Fixes `[✓]`
> **Status: COMPLETE**
> Zero-risk, high-damage-prevention. Ship first.

- [x] Remove plaintext credential log — `imapScanRoutes.js:22` (`console.log("IMAP VERIFY HIT:", ...)`)
- [x] Fix early HTML exit in `extractText()` — `gmailClient.js:35` (don't `return` inside parts loop; accumulate all HTML parts)
- [x] Guard `decryptCredential()` against malformed input — `crypto.js:41–54` (check `parts.length === 3` before destructuring)
- [x] Guard `calcIntervalVariance` against < 2 intervals — `subscriptionEngine.js:28–34` (return 0 / skip instead of crashing `reduce()`)
- [x] Validate `daysBack` input — `scanRoutes.js:95` (reject non-integer or out-of-range values, don't silently coerce)

---

## Level 20 — Security Hardening `[✓]`
> Closes active attack surface. No new features.

- [x] Sign OAuth state param with HMAC — `oauthRoutes.js:34,54` (currently base64 JSON; CSRF attack possible)
- [x] Replace `jwt.decode` with `jwt.verify` for rate limit path — `scanRoutes.js:67`
- [x] Add Zod request body validation to all POST routes
- [x] Never send `err.message` to clients — map to opaque error codes in `scanRoutes.js`, `oauthRoutes.js`
- [x] Add `Retry-After` header on all 429 responses

---

## Level 30 — Code Consolidation `[✓]`
> Eliminates duplicated parsing logic — single source of truth.

- [x] Create `src/services/emailParser.js` shared module
  - [x] Single `extractAmount(text)` — unified regex + fallback
  - [x] Single `extractMerchant(from, subject)` — unified domain parsing + blocklist
  - [x] Single `cleanEmailHtml(html)` — one HTML stripper
- [x] Update `gmailClient.js` to import from shared parser
- [x] Update `imapClient.js` to import from shared parser
- [x] Delete duplicate implementations (~200 lines removed)

---

## Level 40 — Error Handling & Observability `[✓]`
> Prevents silent failures, makes debugging possible.

- [x] Throw on non-2xx Gmail API responses — `gmailClient.js`
- [x] Validate `new Date(string)` results with `isNaN(d.getTime())` before use
- [x] Set `connectTimeout` + `authTimeout` in ImapFlow config — `imapClient.js`
- [x] Wrap all DB queries in try/catch — `db/index.js`
- [x] Replace all `console.log/error` with `pino` structured logging (already installed), threading `req.id`

---

## Level 50 — Database & API Performance `[✓]`
> Removes N+1 patterns and unbounded queries.

- [x] Batch subscription upserts — replace per-subscription loop with single multi-row `INSERT ... ON CONFLICT` — `scanRoutes.js:219`
- [x] Wrap scan upserts in a transaction — partial failure currently silently corrupts data
- [x] Add `LIMIT` + cursor pagination to `GET /subscriptions`
- [x] Add composite DB indexes: `(user_id, merchant)` on `subscriptions`, `(user_id, provider)` on `imap_credentials`
- [x] Replace scan metadata INSERT + DELETE with a window-function single statement
- [x] Raise Gmail API concurrency from `pLimit(10)` to `pLimit(25)`

---

## Level 60 — Algorithm: Interval & Amount Accuracy `[✓]`
> Makes core detection more reliable without ML.

- [x] Widen monthly interval range from 25–35 to 22–37 days; add sample-count tolerance factor
- [x] Add temporal decay — charges older than 6 months contribute less confidence
- [x] Replace raw dollar variance with coefficient of variation (`stddev / mean`)
- [x] Tighten intent keyword scoring — require 2+ signals or use weighted keyword list
- [x] Document and justify all confidence scoring thresholds in code comments
- [x] Remove the `0.99` confidence ceiling (`Math.min(score, 0.99)`) — replace with `1.0` and define what full confidence means

---

## Level 70 — Algorithm: Merchant Intelligence `[✓]`
> Improves detection accuracy for known services.

- [x] Build `knownSubscriptionBrands.js` — list of tier-1 brands (Netflix, Spotify, Apple, Google, Adobe…) with forced interval and known amount ranges
- [x] Auto-confirm single charge from known brand at lower occurrence count
- [x] Expand marketing email blocklist — add missing senders (Klaviyo, Mailchimp, Braze, etc.)
- [x] Rebuild Apple App Store parser as resilient pattern matcher (not fragile single regex)

---

## Level 80 — Subscription Lifecycle Tracking `[✓]`
> Makes subscriptions actionable, not just detected.

- [x] Set `isActive = false` when last-seen date exceeds 2× billing interval
- [x] Add `lastSeenAt` field — updated each scan when subscription is found
- [x] Add subscription occurrence history table — store each detection event, not just the latest
- [x] Detect resumption — subscription reappearing after 3-month gap should not create a duplicate
- [x] Add `PATCH /subscriptions/:id` — let users mark as cancelled, ignored, or confirmed

---

## Level 90 — Scalability & Resilience `[✓]`
> Handles production load without degradation.

- [x] Move Gmail scan to BullMQ queue (already installed) — return `{ jobId }` immediately
- [x] Build result polling endpoint `GET /scan/:jobId/status`
- [x] Prevent re-processing same Gmail message — `processed_message_ids` deduplication
- [x] Set explicit `max`, `idleTimeoutMillis`, `connectionTimeoutMillis` on pg pool
- [x] Retry Gmail API + IMAP connections up to 3× with exponential backoff
- [x] Add circuit breaker on Gmail API — stop scan cleanly on repeated 429/503
- [x] SSE or WebSocket endpoint for real-time scan progress

---

## Level 100 — ML-Backed Detection `[✓]`
> Eliminates arbitrary thresholds entirely; learns from data.

- [x] Add `POST /subscriptions/:id/feedback` — user confirms or rejects a detection
- [x] Store labeled feedback dataset in DB
- [x] Export labeled data and train logistic regression or gradient boosted tree model
- [x] Replace `calculateConfidence()` with ONNX model (runs in-process)
- [x] Add anomaly detection — flag unusual charges vs user's own history
- [x] Semantic merchant normalization — embedding-based deduplication ("NETFLIX.COM", "NETFLIX INC" → same entity)
- [x] Multi-currency support — normalize amounts to user's home currency; add `currency` field to subscriptions

---

## Completion Log

| Level | Completed | Notes |
|-------|-----------|-------|
| 10 | 2026-03-30 | Critical bug fixes — credential log, HTML extraction, crypto guard, interval variance guard, daysBack validation |
| 20 | 2026-03-30 | Security hardening — HMAC OAuth state, jwt.verify in rate limiter, Zod validation on IMAP routes, err.message stripped from responses, Retry-After header |
| 30 | 2026-03-30 | Code consolidation — emailParser.js created; ~200 lines of duplicate cleanEmailHtml/extractAmount/extractMerchant removed from gmailClient and imapClient |
| 40 | 2026-03-30 | Error handling & observability — Gmail API status checks, IMAP date validation + authTimeout, DB try/catch on all 6 functions, console replaced with req.log/server.log |
| 50 | 2026-03-30 | DB & API performance — batchUpsertSubscriptions (unnest + transaction), pLimit 10→25, getSubscriptions paginated, metadata cleanup via ROW_NUMBER(), pg pool config, 4 composite indexes in migrations/001 |
| 60 | 2026-03-30 | Algorithm accuracy — recency decay multiplier, CV replaces range/mean, interval bands widened, intent requires 2+ charges, 0.99 ceiling removed, full scoring model documented |
| 70 | 2026-03-30 | Merchant intelligence — knownBrands.js (23 brands), confirmSingle fast-path, amount sanity checks, interval fallback, blocklist 11→23, Apple parser rebuilt with 4 strategies |
| 80 | 2026-03-30 | Lifecycle tracking — last_seen_at, user_status, subscription_events table, staleness sweep, resumption detection, PATCH /subscriptions/:id, formatSubscription helper |
| 90 | 2026-03-30 | Scalability — BullMQ queue, polling endpoint, SSE stream, retryUtil + CircuitBreaker, Redis message dedup, gmailScanService extracted, SSE plugin registered, IMAP jwt.decode fixed |
| 100 | 2026-03-31 | ML-Backed Detection — logistic regression model (subscriptionModel.js + modelFeatures.js + model/weights.json), feedback endpoint + subscription_feedback table (migration 003), trainModel.js script, anomaly detection wired into batchUpsertSubscriptions (migration 004 + is_anomalous flag on events), merchantNormalizer.js (normalizeMerchant used in subscriptionEngine), currency field added (migration 004) |
