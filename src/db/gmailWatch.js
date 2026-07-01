import { pool } from "./pool.js";

/**
 * Persistence for Gmail real-time push watches (see migrations/005_gmail_watch.sql).
 */

export async function upsertGmailWatch(userId, { email, historyId, expiration }) {
  try {
    await pool.query(
      `INSERT INTO gmail_watch (user_id, email, history_id, expiration, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         email      = EXCLUDED.email,
         history_id = EXCLUDED.history_id,
         expiration = EXCLUDED.expiration,
         updated_at = NOW()`,
      [userId, email, historyId ?? null, expiration ?? null]
    );
  } catch (err) {
    throw new Error(`db_upsert_gmail_watch_failed: ${err.message}`);
  }
}

/** Maps an incoming push (emailAddress) back to the owning user. */
export async function getWatchByEmail(email) {
  try {
    const res = await pool.query(
      "SELECT user_id, email, history_id FROM gmail_watch WHERE LOWER(email) = LOWER($1)",
      [email]
    );
    return res.rows[0] ?? null;
  } catch (err) {
    throw new Error(`db_get_gmail_watch_failed: ${err.message}`);
  }
}

/** Records the latest historyId seen for a user's mailbox. */
export async function updateWatchHistoryId(userId, historyId) {
  try {
    await pool.query(
      "UPDATE gmail_watch SET history_id = $2, updated_at = NOW() WHERE user_id = $1",
      [userId, historyId ?? null]
    );
  } catch (err) {
    throw new Error(`db_update_gmail_watch_history_failed: ${err.message}`);
  }
}

/** Watches expiring within `withinHours` (default 24) — driven by the renewal cron. */
export async function getExpiringWatches({ withinHours = 24, limit = 500 } = {}) {
  try {
    const res = await pool.query(
      `SELECT user_id, email FROM gmail_watch
       WHERE expiration IS NULL
          OR expiration <= NOW() + make_interval(hours => $1)
       LIMIT $2`,
      [withinHours, limit]
    );
    return res.rows;
  } catch (err) {
    throw new Error(`db_get_expiring_gmail_watches_failed: ${err.message}`);
  }
}
