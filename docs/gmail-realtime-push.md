# Gmail real-time push (users.watch + Pub/Sub)

Replaces the 6h polling cron (for Gmail) with near-instant reaction: a trial /
renewal / cancellation email is scanned the moment it lands. IMAP inboxes
(iCloud/Yahoo/etc.) can't push and stay on the polling cron.

**The code is inert until the two env vars below are set** — registration and
renewal no-op, and the webhook rejects everything.

## Env vars

```
GMAIL_PUBSUB_TOPIC=projects/<PROJECT_ID>/topics/gmail-push
GMAIL_PUSH_VERIFICATION_TOKEN=<long-random-secret>   # shared secret in the push URL
```

## One-time GCP setup

1. **Enable APIs**: Gmail API + Pub/Sub API in the GCP project.
2. **Create the topic**: `gmail-push` (matches `GMAIL_PUBSUB_TOPIC`).
3. **Grant Gmail permission to publish**: give the special service account
   `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role on
   the topic. (Gmail refuses `users.watch` without this.)
4. **Create a push subscription** on the topic with delivery type **Push** and
   endpoint:
   ```
   https://email-import-api.onrender.com/webhooks/gmail/push?token=<GMAIL_PUSH_VERIFICATION_TOKEN>
   ```
   Set the ack deadline to ~30s. (The webhook acks immediately and scans in the
   background, so this is comfortable.)
5. **OAuth scope**: the existing `gmail.readonly` scope is sufficient for `watch`.

## Runtime behavior (once configured)

- On Gmail connect (`/auth/google/callback` and `/oauth/google/exchange`) the
  server calls `users.watch` and stores `{ email, historyId, expiration }` in
  the `gmail_watch` table (migration `005_gmail_watch.sql`).
- Pub/Sub POSTs `{ emailAddress, historyId }` → `/webhooks/gmail/push` verifies
  the token, maps the email to a user, and triggers an incremental scan
  (coalesced per user; message-cache dedup keeps it cheap).
- Watches last ~7 days; the hourly alert scheduler renews any expiring within
  24h via `renewExpiringWatches`.
- If push is ever down, the 6h polling cron is still running as a safety net —
  the two are complementary, not exclusive.

## Rollout

1. Run migration `005_gmail_watch.sql`.
2. Set the two env vars on Render.
3. Reconnect a Gmail account (or wait for the renewal cron) to register the first watch.
4. Send yourself a test email; confirm a `gmail_push_scan_failed`-free log line
   and a near-instant scan.
