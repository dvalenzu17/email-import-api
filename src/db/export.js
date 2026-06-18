import { pool } from "./pool.js";

export async function getUserDataExport(userId) {
  try {
    const [subscriptions, scanMetadata, events, feedback, oauthMeta, imapMeta] =
      await Promise.all([
        pool.query(
          `SELECT id, merchant, renewal_amount, currency, renewal_date, billing_interval,
                  confidence, is_active, is_suggested, user_status, source, sender_domain,
                  last_seen_at, created_at, updated_at
           FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC`,
          [userId]
        ),
        pool.query(
          `SELECT id, scanned_messages, detected_charges, execution_time_ms, created_at
           FROM scan_metadata WHERE user_id = $1 ORDER BY created_at DESC`,
          [userId]
        ),
        pool.query(
          `SELECT id, subscription_id, event_type, amount, source, is_anomalous, detected_at
           FROM subscription_events WHERE user_id = $1 ORDER BY detected_at DESC`,
          [userId]
        ),
        pool.query(
          `SELECT subscription_id, label, created_at
           FROM subscription_feedback WHERE user_id = $1 ORDER BY created_at DESC`,
          [userId]
        ),
        pool.query(
          `SELECT provider, expiry_date, created_at, updated_at
           FROM oauth_tokens WHERE user_id = $1`,
          [userId]
        ),
        pool.query(
          `SELECT provider, imap_user, created_at, updated_at
           FROM imap_credentials WHERE user_id = $1`,
          [userId]
        ),
      ]);

    return {
      subscriptions: subscriptions.rows,
      scanMetadata: scanMetadata.rows,
      subscriptionEvents: events.rows,
      feedback: feedback.rows,
      connectedAccounts: {
        oauth: oauthMeta.rows,
        imap: imapMeta.rows,
      },
    };
  } catch (err) {
    throw new Error(`db_get_user_data_export_failed: ${err.message}`);
  }
}
