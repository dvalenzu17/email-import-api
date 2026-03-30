# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # Run production server (node src/server.js)
npm run dev        # Run with hot reload (node --watch src/server.js)
npm run local:scan # Run local scan script
```

No test or lint commands are configured.

## Architecture

**Fastify API** (`src/server.js`) with four route groups:
- `registerScanRoutes()` — Gmail scanning via OAuth tokens
- `registerOAuthRoutes()` — Google OAuth flow (web + PKCE/iOS native)
- `registerImapScanRoutes()` — IMAP scanning (Yahoo, Outlook, iCloud)
- `registerSubscriptionRoutes()` — Retrieve stored subscriptions

All authenticated routes verify Supabase JWTs from the `Authorization: Bearer` header.

### Core Detection Pipeline

1. **Email fetch**: Gmail API (`src/gmailClient.js`) or IMAP (`src/services/imapClient.js`) retrieves emails matching billing-related subject keywords
2. **Parsing**: `src/services/subscriptionEngine.js` extracts merchant, amount, renewal date, and subscription intent signals from email text/HTML
3. **Deduplication & scoring**: Groups charges by merchant, calculates confidence score based on occurrence count, interval consistency, and amount consistency
4. **Persistence**: Upserts into `subscriptions` table via `src/db/index.js`

### Confidence Score Thresholds
- Gmail: ≥ 0.5 confirmed, < 0.85 suggested
- IMAP: ≥ 0.7 confirmed, < 0.85 suggested

### Credential Storage
IMAP passwords and OAuth tokens are AES-256-GCM encrypted using `src/services/crypto.js` before storage. The encryption key is `TOKEN_ENC_KEY_BASE64` in `.env`.

### Key Files
- `src/server.js` — Entry point, route registration, Fastify plugins
- `src/services/subscriptionEngine.js` — Core subscription detection logic (amount regex, merchant extraction, confidence scoring)
- `src/db/index.js` — All PostgreSQL queries (Supabase)
- `src/services/imapClient.js` — IMAP two-pass scan (envelopes first, then full source)
- `src/googleOAuth.js` — OAuth token exchange and refresh

## Environment

Requires a `.env` file with:
- `PORT`, `SUPABASE_JWT_SECRET`, `SUPABASE_URL`, `DATABASE_URL`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
- `TOKEN_ENC_KEY_BASE64` (AES key for encrypting stored credentials)
- `REDIS_URL`, `QUEUE_ENABLED` (optional BullMQ queue support)

## Database Tables

- `oauth_tokens` — Google OAuth tokens per user
- `subscriptions` — Detected subscriptions with confidence, billing interval, amounts
- `scan_metadata` — Per-scan stats (messages scanned, charges detected, execution time)
- `imap_credentials` — Encrypted IMAP credentials per provider per user
