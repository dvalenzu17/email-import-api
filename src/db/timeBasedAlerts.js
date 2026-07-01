import { pool } from "./pool.js";

/**
 * Time-based subscription alerts (run by the background cron):
 *   - big-renewal heads-up: large/annual charges renewing soon
 *   - trial-ending: free trials about to convert
 *
 * These queries return every due row within the ladder window (each row
 * carries days_until so the caller can pick the escalating rung); dedup is
 * handled entirely by the caller via reserveAlert() with a per-rung period_key
 * ("<date>#<rung>"), the atomic gate that fires each rung exactly once.
 */

/**
 * Subscriptions with a large or annual renewal coming up that haven't been
 * alerted yet for that renewal date. Only users with an opted-in push token.
 */
export async function getDueRenewalAlerts({ withinDays = 2, minAmount = 30, limit = 500 } = {}) {
  const result = await pool.query(
    `SELECT s.id, s.user_id, s.merchant, s.renewal_amount, s.currency,
            s.billing_interval, s.renewal_date,
            to_char(s.renewal_date, 'YYYY-MM-DD') AS period_key,
            (s.renewal_date::date - CURRENT_DATE) AS days_until
     FROM subscriptions s
     WHERE s.is_active = true
       AND (s.user_status IS NULL OR s.user_status NOT IN ('cancelled', 'ignored'))
       AND s.renewal_date IS NOT NULL
       AND s.renewal_date::date >= CURRENT_DATE
       AND s.renewal_date::date <= (CURRENT_DATE + make_interval(days => $1))::date
       AND (s.renewal_amount >= $2 OR s.billing_interval IN ('yearly', 'annual'))
       AND EXISTS (
         SELECT 1 FROM push_tokens p
         WHERE p.user_id = s.user_id AND p.new_sub_alerts IS NOT FALSE
       )
     LIMIT $3`,
    [withinDays, minAmount, limit]
  );
  return result.rows;
}

/**
 * Subscriptions whose free trial ends soon and haven't been alerted yet.
 */
export async function getDueTrialAlerts({ withinDays = 2, limit = 500 } = {}) {
  const result = await pool.query(
    `SELECT s.id, s.user_id, s.merchant, s.renewal_amount, s.currency,
            s.billing_interval, s.trial_end,
            to_char(s.trial_end, 'YYYY-MM-DD') AS period_key,
            (s.trial_end::date - CURRENT_DATE) AS days_until
     FROM subscriptions s
     WHERE s.trial_end IS NOT NULL
       AND (s.user_status IS NULL OR s.user_status NOT IN ('cancelled', 'ignored'))
       AND s.trial_end::date >= CURRENT_DATE
       AND s.trial_end::date <= (CURRENT_DATE + make_interval(days => $1))::date
       AND EXISTS (
         SELECT 1 FROM push_tokens p
         WHERE p.user_id = s.user_id AND p.new_sub_alerts IS NOT FALSE
       )
     LIMIT $2`,
    [withinDays, limit]
  );
  return result.rows;
}

/**
 * Atomically reserve an alert occurrence. Returns true only if this is the
 * first reservation (i.e. the alert should be sent now). Safe against races
 * and overlapping cron cycles via the unique constraint.
 */
export async function reserveAlert(userId, subscriptionId, alertType, periodKey) {
  try {
    const res = await pool.query(
      `INSERT INTO subscription_alerts (user_id, subscription_id, alert_type, period_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (subscription_id, alert_type, period_key) DO NOTHING
       RETURNING id`,
      [userId, subscriptionId, alertType, periodKey]
    );
    return res.rows.length > 0;
  } catch (err) {
    // Best-effort: if we can't reserve, don't send (avoids duplicate pushes).
    throw new Error(`db_reserve_alert_failed: ${err.message}`);
  }
}
