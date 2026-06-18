import { pool } from "./pool.js";

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
    return {};
  }
}

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
