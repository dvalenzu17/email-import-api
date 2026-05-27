import pkg from "pg";
import { encryptCredential } from "../services/crypto.js";
import { detectAmountAnomaly } from "../services/anomalyDetector.js";
import { normaliseMerchant } from "../lib/normaliseMerchant.js";
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
 *
 * TASK 1: Now also upserts extraction_log (jsonb) — the per-field extraction
 * strategy telemetry recorded by emailParser.parseEmailWithLog(). Stored for
 * each subscription so we can diagnose parsing failures in production.
 */
export async function batchUpsertSubscriptions(userId, subscriptions) {
  if (!subscriptions.length) return new Set();

  let writtenMerchants = new Set();
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
    // TASK 1: extraction_log column included — JSON.stringify to jsonb cast.
    //
    // Merge rules on conflict:
    //   renewal_amount, renewal_date, billing_interval — fill-null-only:
    //     keep the existing DB value if it is non-null; only write the new value
    //     when the DB field is currently null. This preserves manually corrected data.
    //   confidence — take the higher of the two values (never downgrade a subscription).
    const upsertRes = await client.query(
      `INSERT INTO subscriptions
         (user_id, merchant, renewal_amount, currency, renewal_date,
          confidence, is_active, is_suggested, source, billing_interval, last_seen_at,
          icon_url, sender_domain, extraction_log)
       SELECT * FROM unnest(
         $1::uuid[], $2::text[], $3::numeric[], $4::text[], $5::timestamptz[],
         $6::numeric[], $7::boolean[], $8::boolean[], $9::text[], $10::text[],
         $11::timestamptz[], $12::text[], $13::text[], $14::jsonb[]
       ) AS t(user_id, merchant, renewal_amount, currency, renewal_date,
              confidence, is_active, is_suggested, source, billing_interval, last_seen_at,
              icon_url, sender_domain, extraction_log)
       ON CONFLICT (user_id, LOWER(merchant)) DO UPDATE SET
         merchant         = EXCLUDED.merchant,
         renewal_amount   = COALESCE(subscriptions.renewal_amount,   EXCLUDED.renewal_amount),
         renewal_date     = COALESCE(subscriptions.renewal_date,     EXCLUDED.renewal_date),
         billing_interval = COALESCE(subscriptions.billing_interval, EXCLUDED.billing_interval),
         confidence       = GREATEST(subscriptions.confidence,       EXCLUDED.confidence),
         is_suggested     = EXCLUDED.is_suggested,
         last_seen_at     = EXCLUDED.last_seen_at,
         icon_url         = COALESCE(subscriptions.icon_url,      EXCLUDED.icon_url),
         sender_domain    = COALESCE(subscriptions.sender_domain, EXCLUDED.sender_domain),
         extraction_log   = COALESCE(subscriptions.extraction_log, EXCLUDED.extraction_log),
         is_active        = CASE
           WHEN subscriptions.user_status = 'cancelled'  THEN false
           WHEN subscriptions.user_status = 'confirmed'  THEN true
           ELSE true
         END,
         updated_at       = NOW()
       RETURNING id, merchant`,
      [
        subscriptions.map(() => userId),
        // TASK 5/6: normalise merchant to title case for consistent deduplication
        subscriptions.map((s) => normaliseMerchant(s.merchant)),
        subscriptions.map((s) => s.renewalAmount),
        subscriptions.map((s) => s.currency),
        subscriptions.map((s) => s.renewalDate),
        subscriptions.map((s) => s.confidence),
        subscriptions.map((s) => s.isActive),
        subscriptions.map((s) => s.isSuggested),
        subscriptions.map((s) => s.source),
        subscriptions.map((s) => s.billingInterval ?? null),
        subscriptions.map(() => new Date()),
        subscriptions.map((s) => s.iconUrl ?? null),
        subscriptions.map((s) => s.senderDomain ?? null),
        // TASK 1: Serialize extractionLog as JSON string; Postgres casts to jsonb.
        subscriptions.map((s) => s.extractionLog ? JSON.stringify(s.extractionLog) : null),
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
    writtenMerchants = new Set(upsertRes.rows.map((r) => r.merchant.toLowerCase()));
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`db_batch_upsert_subscriptions_failed: ${err.message}`);
  } finally {
    client.release();
  }
  return writtenMerchants;
}

/**
 * Returns a Map of { merchantKey → confidence } for all active subscriptions
 * belonging to the user. merchantKey is the lowercase merchant name.
 * Used by the IMAP bypass loop to check DB state before writing.
 */
export async function getActiveSubscriptionConfidences(userId) {
  const result = await pool.query(
    `SELECT LOWER(merchant) AS merchant_key, confidence
     FROM subscriptions
     WHERE user_id = $1 AND is_active = true`,
    [userId]
  );
  return new Map(result.rows.map((r) => [r.merchant_key, parseFloat(r.confidence)]));
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
// ADMIN — ALL USERS
// -------------------------

/**
 * Returns every subscription across all users, grouped with per-user scan stats.
 * Used exclusively by the internal admin dashboard (protected by ADMIN_SECRET).
 */
export async function getAdminUsersData() {
  try {
    const [subRes, scanRes] = await Promise.all([
      pool.query(`
        SELECT id, user_id, merchant, renewal_amount, currency, billing_interval,
               confidence, is_active, is_suggested, user_status, source, last_seen_at, created_at
        FROM subscriptions
        ORDER BY user_id, created_at DESC
      `),
      pool.query(`
        SELECT DISTINCT ON (user_id)
          user_id, scanned_messages, detected_charges, created_at AS last_scan_at
        FROM scan_metadata
        ORDER BY user_id, created_at DESC
      `),
    ]);

    // Group subscriptions by user_id
    const byUser = {};
    for (const row of subRes.rows) {
      if (!byUser[row.user_id]) byUser[row.user_id] = [];
      byUser[row.user_id].push(row);
    }

    const scanMap = Object.fromEntries(scanRes.rows.map((r) => [r.user_id, r]));

    return Object.entries(byUser).map(([userId, subs]) => ({
      userId,
      subscriptions: subs,
      lastScan: scanMap[userId] ?? null,
    }));
  } catch (err) {
    throw new Error(`db_get_admin_users_failed: ${err.message}`);
  }
}

// -------------------------
// LIFECYCLE EVENTS
// -------------------------

/**
 * Upserts subscriptions detected from cancellation/expiry emails.
 * Saves them with is_active = false so they appear in the UI as cancelled.
 * On conflict: updates amount/currency but never sets is_active = true.
 * Skips merchants already saved as active in the same scan (caller filters these out).
 *
 * @param {string} userId
 * @param {Array<{ merchant, renewalAmount, currency, renewalDate, source }>} subscriptions
 */
export async function upsertCancelledSubscriptions(userId, subscriptions) {
  if (!subscriptions.length) return;
  try {
    await pool.query(
      `INSERT INTO subscriptions
         (user_id, merchant, renewal_amount, currency, renewal_date,
          confidence, is_active, is_suggested, source, billing_interval, last_seen_at,
          icon_url, sender_domain)
       SELECT * FROM unnest(
         $1::uuid[], $2::text[], $3::numeric[], $4::text[], $5::timestamptz[],
         $6::numeric[], $7::boolean[], $8::boolean[], $9::text[], $10::text[],
         $11::timestamptz[], $12::text[], $13::text[]
       ) AS t(user_id, merchant, renewal_amount, currency, renewal_date,
              confidence, is_active, is_suggested, source, billing_interval, last_seen_at,
              icon_url, sender_domain)
       ON CONFLICT (user_id, LOWER(merchant)) DO UPDATE SET
         merchant       = EXCLUDED.merchant,
         renewal_amount = EXCLUDED.renewal_amount,
         currency       = EXCLUDED.currency,
         last_seen_at   = EXCLUDED.last_seen_at,
         icon_url       = COALESCE(EXCLUDED.icon_url, subscriptions.icon_url),
         sender_domain  = COALESCE(EXCLUDED.sender_domain, subscriptions.sender_domain),
         is_active      = CASE
           WHEN subscriptions.user_status = 'confirmed' THEN true
           ELSE false
         END,
         updated_at     = NOW()`,
      [
        subscriptions.map(() => userId),
        // TASK 5/6: normalise merchant to title case for consistent deduplication
        subscriptions.map((s) => normaliseMerchant(s.merchant)),
        subscriptions.map((s) => s.renewalAmount),
        subscriptions.map((s) => s.currency),
        subscriptions.map((s) => s.renewalDate ?? null),
        subscriptions.map(() => 0.6),
        subscriptions.map(() => false),  // is_active = false
        subscriptions.map(() => false),  // is_suggested = false (real sub, just cancelled)
        subscriptions.map((s) => s.source),
        subscriptions.map(() => null),
        subscriptions.map(() => new Date()),
        subscriptions.map((s) => s.iconUrl ?? null),
        subscriptions.map((s) => s.senderDomain ?? null),
      ]
    );
  } catch (err) {
    throw new Error(`db_upsert_cancelled_subscriptions_failed: ${err.message}`);
  }
}

/**
 * Attempts to update renewal_date on an existing active subscription matched by
 * amount (±$0.50) and billing_interval. Used when an Apple "Subscription is Expiring"
 * email cannot identify the app name — the merchant can't be written, but the
 * renewal date extracted from the email can still be patched onto the matched record.
 *
 * Returns { updated: boolean, merchant: string|null }.
 */
export async function updateRenewalDateByAmountAndInterval(userId, { amount, billingInterval, renewalDate }) {
  if (!renewalDate || !amount) return { updated: false, merchant: null };
  try {
    const result = await pool.query(
      `UPDATE subscriptions
       SET renewal_date = $3,
           updated_at   = NOW()
       WHERE id = (
         SELECT id FROM subscriptions
         WHERE user_id = $1
           AND is_active = true
           AND renewal_amount IS NOT NULL
           AND ABS(renewal_amount::numeric - $2::numeric) <= 0.50
           AND ($4::text IS NULL OR billing_interval = $4)
         ORDER BY last_seen_at DESC
         LIMIT 1
       )
       RETURNING merchant`,
      [userId, amount, renewalDate, billingInterval ?? null]
    );
    return {
      updated:  result.rows.length > 0,
      merchant: result.rows[0]?.merchant ?? null,
    };
  } catch (err) {
    throw new Error(`db_update_renewal_date_failed: ${err.message}`);
  }
}

/**
 * Marks a subscription as cancelled by merchant name.
 * Only updates rows that haven't been manually set to 'confirmed' by the user.
 * Used when the scan detects a cancellation email for a known merchant.
 */
export async function cancelSubscriptionByMerchant(userId, merchant) {
  try {
    await pool.query(
      `UPDATE subscriptions
       SET user_status = 'cancelled',
           is_active   = false,
           updated_at  = NOW()
       WHERE user_id = $1
         AND LOWER(merchant) = LOWER($2)
         AND (user_status IS NULL OR user_status NOT IN ('confirmed'))`,
      [userId, merchant]
    );
  } catch (err) {
    throw new Error(`db_cancel_subscription_failed: ${err.message}`);
  }
}

// -------------------------
// TASK 4: MERCHANT CONFIRMATIONS
// -------------------------

/**
 * TASK 4 — Saves a user's explicit confirmation or rejection of a detected
 * subscription to the merchant_confirmations table. Accumulates signal used
 * by POST /admin/merchant-aliases/rebuild to auto-promote high-confidence
 * domain→canonical_name mappings into merchant_aliases.
 *
 * @param {string} userId
 * @param {{ merchantDomain: string, canonicalName: string, confirmed: boolean, amount?: number, interval?: string }} opts
 */
export async function saveMerchantConfirmation(userId, { merchantDomain, canonicalName, confirmed, amount, interval }) {
  try {
    await pool.query(
      `INSERT INTO merchant_confirmations (user_id, merchant_domain, canonical_name, confirmed, amount, interval)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, merchantDomain, canonicalName, confirmed, amount ?? null, interval ?? null]
    );
  } catch (err) {
    throw new Error(`db_save_merchant_confirmation_failed: ${err.message}`);
  }
}

/**
 * TASK 4 — Returns aggregate confirmation counts per merchant_domain.
 * Used by /admin/merchant-aliases/rebuild to decide which domains to promote
 * to merchant_aliases and by how much to boost confidence.
 *
 * Returns rows: [{ merchant_domain, canonical_name, confirmed_count, total_count }]
 * canonical_name is the most frequently confirmed name for that domain.
 */
export async function aggregateMerchantConfirmations() {
  try {
    const res = await pool.query(`
      SELECT
        merchant_domain,
        canonical_name,
        COUNT(*) FILTER (WHERE confirmed = true)  AS confirmed_count,
        COUNT(*)                                   AS total_count
      FROM merchant_confirmations
      GROUP BY merchant_domain, canonical_name
      ORDER BY confirmed_count DESC, merchant_domain
    `);
    return res.rows;
  } catch (err) {
    throw new Error(`db_aggregate_merchant_confirmations_failed: ${err.message}`);
  }
}

// -------------------------
// ML FEEDBACK
// -------------------------

/**
 * Returns a map of { [merchantKey: string]: 'confirmed'|'rejected' } for a user.
 * Used by the detection engine to personalise confidence scores at inference time
 * without retraining — the free-tier intelligence graph.
 */
export async function getFeedbackMerchantMap(userId) {
  try {
    const result = await pool.query(
      `SELECT LOWER(s.merchant) AS merchant, sf.label
       FROM subscription_feedback sf
       JOIN subscriptions s ON sf.subscription_id = s.id
       WHERE sf.user_id = $1`,
      [userId]
    );
    return Object.fromEntries(result.rows.map((r) => [r.merchant, r.label]));
  } catch {
    // Non-fatal: if feedback lookup fails, detection proceeds without personalisation.
    return {};
  }
}

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
