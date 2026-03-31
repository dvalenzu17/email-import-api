import pkg from "pg";
import { encryptCredential } from "../services/crypto.js";
import { detectAmountAnomaly } from "../services/anomalyDetector.js";
const { Pool } = pkg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// NOTE: findOrCreateUser() has been removed.
// public.users was dropped — auth users live in auth.users only.
// The Supabase user ID from the verified JWT is used directly in all queries.

// -------------------------
// OAUTH TOKENS
// -------------------------

export async function saveOAuthTokens(userId, tokens) {
  try {
    await pool.query(
      `INSERT INTO oauth_tokens (user_id, provider, access_token, refresh_token, expiry_date)
       VALUES ($1, 'google', $2, $3, NOW() + ($4 || ' seconds')::interval)
       ON CONFLICT (user_id, provider)
       DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expiry_date = EXCLUDED.expiry_date,
         updated_at = NOW()`,
      [userId, tokens.accessToken, tokens.refreshToken, tokens.expiresIn]
    );
  } catch (err) {
    throw new Error(`db_save_oauth_tokens_failed: ${err.message}`);
  }
}

export async function getOAuthToken(userId) {
  try {
    const result = await pool.query(
      "SELECT * FROM oauth_tokens WHERE user_id = $1 AND provider = 'google'",
      [userId]
    );
    return result.rows[0];
  } catch (err) {
    throw new Error(`db_get_oauth_token_failed: ${err.message}`);
  }
}

// -------------------------
// SUBSCRIPTIONS
// -------------------------

/**
 * Upserts all subscriptions for a user in a single transaction.
 * Also:
 *   - Sets last_seen_at = NOW() on every upserted row
 *   - Logs a detection event for each subscription (type = 'detected' or 'resumed')
 *   - Marks subscriptions not seen in 2× their billing period as inactive
 *     (respects user_status overrides — manual confirmations/cancellations are never touched)
 */
export async function batchUpsertSubscriptions(userId, subscriptions) {
  if (!subscriptions.length) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Fetch the set of merchants that are currently inactive so we can detect resumptions.
    const inactiveRes = await client.query(
      `SELECT merchant FROM subscriptions WHERE user_id = $1 AND is_active = false`,
      [userId]
    );
    const inactiveMerchants = new Set(inactiveRes.rows.map((r) => r.merchant));

    // Upsert subscriptions. Always refresh last_seen_at and reset is_active to true
    // (the staleness sweep below re-marks stale ones after this scan).
    // user_status is intentionally not touched here — manual overrides persist.
    const upsertRes = await client.query(
      `INSERT INTO subscriptions
         (user_id, merchant, renewal_amount, currency, renewal_date,
          confidence, is_active, is_suggested, source, billing_interval, last_seen_at)
       SELECT * FROM unnest(
         $1::uuid[], $2::text[], $3::numeric[], $4::text[], $5::timestamptz[],
         $6::numeric[], $7::boolean[], $8::boolean[], $9::text[], $10::text[],
         $11::timestamptz[]
       ) AS t(user_id, merchant, renewal_amount, currency, renewal_date,
              confidence, is_active, is_suggested, source, billing_interval, last_seen_at)
       ON CONFLICT (user_id, merchant) DO UPDATE SET
         renewal_amount   = EXCLUDED.renewal_amount,
         renewal_date     = EXCLUDED.renewal_date,
         confidence       = EXCLUDED.confidence,
         is_suggested     = EXCLUDED.is_suggested,
         billing_interval = EXCLUDED.billing_interval,
         last_seen_at     = EXCLUDED.last_seen_at,
         is_active        = CASE
           WHEN subscriptions.user_status = 'cancelled'  THEN false
           WHEN subscriptions.user_status = 'confirmed'  THEN true
           ELSE true
         END,
         updated_at       = NOW()
       RETURNING id, merchant`,
      [
        subscriptions.map(() => userId),
        subscriptions.map((s) => s.merchant),
        subscriptions.map((s) => s.renewalAmount),
        subscriptions.map((s) => s.currency),
        subscriptions.map((s) => s.renewalDate),
        subscriptions.map((s) => s.confidence),
        subscriptions.map((s) => s.isActive),
        subscriptions.map((s) => s.isSuggested),
        subscriptions.map((s) => s.source),
        subscriptions.map((s) => s.billingInterval ?? null),
        subscriptions.map(() => new Date()),
      ]
    );

    // Log a detection event for each upserted subscription.
    if (upsertRes.rows.length) {
      const subMap = Object.fromEntries(subscriptions.map((s) => [s.merchant, s]));

      // Fetch historical amounts per subscription so we can flag anomalies.
      const subIds = upsertRes.rows.map((r) => r.id);
      const histRes = await client.query(
        `SELECT subscription_id, ARRAY_AGG(amount ORDER BY detected_at DESC) AS amounts
         FROM subscription_events
         WHERE subscription_id = ANY($1::uuid[])
         GROUP BY subscription_id`,
        [subIds]
      );
      const histMap = Object.fromEntries(
        histRes.rows.map((r) => [r.subscription_id, r.amounts.map(Number)])
      );

      const anomalyFlags = upsertRes.rows.map((r) => {
        const newAmount = subMap[r.merchant]?.renewalAmount;
        const historical = histMap[r.id] ?? [];
        if (newAmount == null) return false;
        return detectAmountAnomaly(newAmount, historical).anomalous;
      });

      await client.query(
        `INSERT INTO subscription_events
           (user_id, subscription_id, event_type, amount, source, is_anomalous)
         SELECT * FROM unnest(
           $1::uuid[], $2::uuid[], $3::text[], $4::numeric[], $5::text[], $6::boolean[]
         ) AS t(user_id, subscription_id, event_type, amount, source, is_anomalous)`,
        [
          upsertRes.rows.map(() => userId),
          upsertRes.rows.map((r) => r.id),
          upsertRes.rows.map((r) =>
            inactiveMerchants.has(r.merchant) ? "resumed" : "detected"
          ),
          upsertRes.rows.map((r) => subMap[r.merchant]?.renewalAmount ?? null),
          upsertRes.rows.map((r) => subMap[r.merchant]?.source ?? null),
          anomalyFlags,
        ]
      );
    }

    // Mark subscriptions as inactive when not seen in 2× their billing period.
    // Respects user_status: 'confirmed' locks isActive=true, 'cancelled' is already false.
    await client.query(
      `UPDATE subscriptions
       SET is_active = false, updated_at = NOW()
       WHERE user_id = $1
         AND is_active = true
         AND (user_status IS NULL OR user_status = 'ignored')
         AND last_seen_at < NOW() - (
           CASE billing_interval
             WHEN 'weekly'      THEN INTERVAL '14 days'
             WHEN 'monthly'     THEN INTERVAL '60 days'
             WHEN 'quarterly'   THEN INTERVAL '182 days'
             WHEN 'semi-annual' THEN INTERVAL '365 days'
             WHEN 'yearly'      THEN INTERVAL '730 days'
             ELSE                    INTERVAL '120 days'
           END
         )`,
      [userId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`db_batch_upsert_subscriptions_failed: ${err.message}`);
  } finally {
    client.release();
  }
}

/**
 * Sets user_status on a subscription. Returns the updated row, or null if not found.
 * Only modifies rows belonging to the requesting user.
 */
export async function updateSubscriptionStatus(userId, subscriptionId, status) {
  try {
    const result = await pool.query(
      `UPDATE subscriptions
       SET user_status = $1,
           is_active   = CASE
             WHEN $1 = 'cancelled' THEN false
             WHEN $1 = 'confirmed' THEN true
             ELSE is_active
           END,
           updated_at  = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [status, subscriptionId, userId]
    );
    return result.rows[0] ?? null;
  } catch (err) {
    throw new Error(`db_update_subscription_status_failed: ${err.message}`);
  }
}

/**
 * Fetches a single subscription by id, scoped to the user.
 */
export async function getSubscriptionById(userId, subscriptionId) {
  try {
    const result = await pool.query(
      `SELECT * FROM subscriptions WHERE id = $1 AND user_id = $2`,
      [subscriptionId, userId]
    );
    return result.rows[0] ?? null;
  } catch (err) {
    throw new Error(`db_get_subscription_by_id_failed: ${err.message}`);
  }
}

/**
 * @param {object} opts
 * @param {number} opts.limit  — max rows to return (default 100, max 500)
 * @param {number} opts.offset — pagination offset (default 0)
 */
export async function getSubscriptions(userId, { limit = 100, offset = 0 } = {}) {
  try {
    const result = await pool.query(
      "SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
      [userId, limit, offset]
    );
    return result.rows;
  } catch (err) {
    throw new Error(`db_get_subscriptions_failed: ${err.message}`);
  }
}

// -------------------------
// SCAN METADATA
// -------------------------

export async function saveScanMetadata(userId, meta) {
  try {
    await pool.query(
      `INSERT INTO scan_metadata (user_id, scanned_messages, detected_charges, execution_time_ms)
       VALUES ($1,$2,$3,$4)`,
      [userId, meta.scannedMessages, meta.detectedCharges, meta.executionTimeMs]
    );
    // Keep only the 10 most recent scans per user, using ROW_NUMBER() to avoid
    // NOT IN subquery ambiguity and leverage the index on (user_id, created_at).
    await pool.query(
      `DELETE FROM scan_metadata
       WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
           FROM scan_metadata
           WHERE user_id = $1
         ) ranked
         WHERE rn > 10
       )`,
      [userId]
    );
  } catch (err) {
    throw new Error(`db_save_scan_metadata_failed: ${err.message}`);
  }
}

export async function getLatestScanMetadata(userId) {
  try {
    const result = await pool.query(
      `SELECT * FROM scan_metadata
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId]
    );
    return result.rows[0] || null;
  } catch (err) {
    throw new Error(`db_get_scan_metadata_failed: ${err.message}`);
  }
}

// -------------------------
// IMAP CREDENTIALS
// -------------------------

export async function saveImapCredentials(userId, { provider, user, pass }) {
  try {
    const encryptedPass = encryptCredential(pass);
    await pool.query(
      `INSERT INTO imap_credentials (user_id, provider, imap_user, imap_pass)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, provider)
       DO UPDATE SET
         imap_user  = EXCLUDED.imap_user,
         imap_pass  = EXCLUDED.imap_pass,
         updated_at = NOW()`,
      [userId, provider, user, encryptedPass]
    );
  } catch (err) {
    throw new Error(`db_save_imap_credentials_failed: ${err.message}`);
  }
}

export async function getImapCredentials(userId, provider) {
  try {
    const result = await pool.query(
      `SELECT * FROM imap_credentials WHERE user_id = $1 AND provider = $2`,
      [userId, provider]
    );
    return result.rows[0] ?? null;
  } catch (err) {
    throw new Error(`db_get_imap_credentials_failed: ${err.message}`);
  }
}

// -------------------------
// ML FEEDBACK
// -------------------------

/**
 * Upserts a user feedback label for a detected subscription.
 * One row per user+subscription — later feedback overwrites earlier.
 *
 * @param {string} userId
 * @param {string} subscriptionId
 * @param {'confirmed'|'rejected'} label
 * @param {object} features — feature vector snapshot at detection time
 */
export async function saveFeedback(userId, subscriptionId, label, features) {
  try {
    await pool.query(
      `INSERT INTO subscription_feedback (user_id, subscription_id, label, features)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, subscription_id)
       DO UPDATE SET label = EXCLUDED.label, features = EXCLUDED.features, created_at = NOW()`,
      [userId, subscriptionId, label, JSON.stringify(features)]
    );
  } catch (err) {
    throw new Error(`db_save_feedback_failed: ${err.message}`);
  }
}
