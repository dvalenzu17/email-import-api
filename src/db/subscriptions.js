import { pool } from "./pool.js";
import { detectAmountAnomaly } from "../services/anomalyDetector.js";
import { normaliseMerchant } from "../lib/normaliseMerchant.js";

/**
 * Upserts all subscriptions for a user in a single transaction.
 * Also:
 *   - Sets last_seen_at = NOW() on every upserted row
 *   - Logs a detection event for each subscription (type = 'detected' or 'resumed')
 *   - Marks subscriptions not seen in 2× their billing period as inactive
 *     (respects user_status overrides — manual confirmations/cancellations are never touched)
 */
export async function batchUpsertSubscriptions(userId, subscriptions) {
  if (!subscriptions.length) return { writtenMerchants: new Set(), inserted: [] };

  let writtenMerchants = new Set();
  // Brand-new rows (first time ever for this user), used to fire "new
  // subscription detected" push notifications. Detected via Postgres `xmax = 0`,
  // which is true for an INSERT and false for an ON CONFLICT update.
  let inserted = [];
  // Re-detected charges on a subscription the user marked cancelled ("zombie"
  // charges), and significant upward price changes — both surfaced for pushes.
  let zombieCharges = [];
  let priceIncreases = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const inactiveRes = await client.query(
      `SELECT merchant FROM subscriptions WHERE user_id = $1 AND is_active = false`,
      [userId]
    );
    const inactiveMerchants = new Set(inactiveRes.rows.map((r) => r.merchant));

    // Merchants the user explicitly cancelled — re-detecting a charge here is a
    // "zombie charge" worth alerting on. Compared case-insensitively.
    const cancelledRes = await client.query(
      `SELECT LOWER(merchant) AS merchant_key FROM subscriptions
       WHERE user_id = $1 AND user_status = 'cancelled'`,
      [userId]
    );
    const cancelledMerchants = new Set(cancelledRes.rows.map((r) => r.merchant_key));

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
       RETURNING id, merchant, (xmax = 0) AS inserted`,
      [
        subscriptions.map(() => userId),
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
        subscriptions.map((s) => s.extractionLog ? JSON.stringify(s.extractionLog) : null),
      ]
    );

    if (upsertRes.rows.length) {
      const subMap = Object.fromEntries(subscriptions.map((s) => [s.merchant, s]));

      // Collect genuinely-new rows for new-subscription notifications.
      inserted = upsertRes.rows
        .filter((r) => r.inserted)
        .map((r) => {
          const s = subMap[r.merchant];
          return {
            id: r.id,
            merchant: r.merchant,
            renewalAmount: s?.renewalAmount ?? null,
            currency: s?.currency ?? "USD",
            billingInterval: s?.billingInterval ?? null,
            isActive: s?.isActive !== false,
            senderDomain: s?.senderDomain ?? null,
          };
        });

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

      // Surface alert-worthy changes (histMap holds amounts from PRIOR scans
      // only — this scan's events are inserted just below).
      upsertRes.rows.forEach((r, i) => {
        const s = subMap[r.merchant];
        const newAmount = s?.renewalAmount;
        if (newAmount == null) return;

        // Zombie charge: a charge re-detected for a subscription the user cancelled.
        if (cancelledMerchants.has(r.merchant.toLowerCase())) {
          zombieCharges.push({
            merchant: r.merchant,
            amount: newAmount,
            currency: s?.currency ?? "USD",
            billingInterval: s?.billingInterval ?? null,
          });
        }

        // Price hike: anomalous change AND the new amount is meaningfully higher
        // than the most recent prior amount (ignore drops and rounding noise).
        const prevAmount = histMap[r.id]?.[0];
        if (anomalyFlags[i] && prevAmount != null && newAmount > prevAmount * 1.05) {
          priceIncreases.push({
            merchant: r.merchant,
            oldAmount: prevAmount,
            newAmount,
            currency: s?.currency ?? "USD",
            billingInterval: s?.billingInterval ?? null,
          });
        }
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
  return { writtenMerchants, inserted, zombieCharges, priceIncreases };
}

export async function getActiveSubscriptionConfidences(userId) {
  const result = await pool.query(
    `SELECT LOWER(merchant) AS merchant_key, confidence
     FROM subscriptions
     WHERE user_id = $1 AND is_active = true AND (is_suggested = false OR is_suggested IS NULL)`,
    [userId]
  );
  return new Map(result.rows.map((r) => [r.merchant_key, parseFloat(r.confidence)]));
}

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
        subscriptions.map((s) => normaliseMerchant(s.merchant)),
        subscriptions.map((s) => s.renewalAmount),
        subscriptions.map((s) => s.currency),
        subscriptions.map((s) => s.renewalDate ?? null),
        subscriptions.map(() => 0.6),
        subscriptions.map(() => false),
        subscriptions.map(() => false),
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
 * Marks a subscription dead in response to a detected cancellation email.
 *
 * A cancellation email is authoritative — it marks the sub dead even if the
 * user had manually confirmed it (you confirm a sub, then later cancel it;
 * BIB must stop nudging). Two safeguards keep that from wiping a live sub:
 *   1. The caller only passes merchants NOT seen active in the same scan
 *      (re-subscribe guard in applyLifecycleCancellations).
 *   2. Temporal guard here: skip if a charge is newer than the cancellation
 *      (last_seen_at > cancelDate) — covers annual subs that won't have a
 *      charge in the scan window. A null cancelDate falls back to permissive.
 *
 * @returns {Promise<number>} rows marked cancelled
 */
export async function cancelSubscriptionByMerchant(userId, merchant, cancelDate = null) {
  try {
    const res = await pool.query(
      `UPDATE subscriptions
       SET user_status = 'cancelled',
           is_active   = false,
           updated_at  = NOW()
       WHERE user_id = $1
         AND LOWER(merchant) = LOWER($2)
         AND user_status IS DISTINCT FROM 'cancelled'
         AND ($3::timestamptz IS NULL OR last_seen_at IS NULL OR last_seen_at <= $3::timestamptz)
       RETURNING id`,
      [userId, merchant, cancelDate]
    );
    return res.rows.length;
  } catch (err) {
    throw new Error(`db_cancel_subscription_failed: ${err.message}`);
  }
}
