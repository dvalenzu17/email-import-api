import { pool } from "./pool.js";

/**
 * Time-based subscription alerts (run by the background cron):
 *   - big-renewal heads-up: large/annual charges renewing soon
 *   - trial-ending: free trials about to convert
 *
 * Dedup is handled by the subscription_alerts ledger via reserveAlert():
 * an alert fires once per occurrence (period_key = the date being alerted).
 * Queries already exclude rows that have been alerted for the current period,
 * and reserveAlert() is the atomic gate before sending.
 */

/**
 * Subscriptions with a large or annual renewal coming up that haven't been
 * alerted yet for that renewal date. Only users with an opted-in push token.
 */
export async function getDueRenewalAlerts({ withinDays = 3, minAmount = 30, limit = 500 } = {}) {
  const result = await pool.query(
    `SELECT s.id, s.user_id, s.merchant, s.renewal_amount, s.currency,
            s.billing_interval, s.renewal_date,
            to_char(s.renewal_date, 'YYYY-MM-DD') AS period_key
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
       AND NOT EXISTS (
         SELECT 1 FROM subscription_alerts a
         WHERE a.subscription_id = s.id
           AND a.alert_type = 'renewal'
           AND a.period_key = to_char(s.renewal_date, 'YYYY-MM-DD')
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
            to_char(s.trial_end, 'YYYY-MM-DD') AS period_key
     FROM subscriptions s
     WHERE s.trial_end IS NOT NULL
       AND (s.user_status IS NULL OR s.user_status NOT IN ('cancelled', 'ignored'))
       AND s.trial_end::date >= CURRENT_DATE
       AND s.trial_end::date <= (CURRENT_DATE + make_interval(days => $1))::date
       AND EXISTS (
         SELECT 1 FROM push_tokens p
         WHERE p.user_id = s.user_id AND p.new_sub_alerts IS NOT FALSE
       )
       AND NOT EXISTS (
         SELECT 1 FROM subscription_alerts a
         WHERE a.subscription_id = s.id
           AND a.alert_type = 'trial_ending'
           AND a.period_key = to_char(s.trial_end, 'YYYY-MM-DD')
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
