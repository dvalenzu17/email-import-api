import { pool } from "./pool.js";

/**
 * Returns users eligible for a background (cron) scan.
 *
 * A user is "due" when they:
 *   - have a connected account (a Google OAuth token and/or IMAP credentials), AND
 *   - have at least one registered push token (no point scanning to push nowhere), AND
 *   - have not been scanned within the last `minHoursSinceLastScan` hours.
 *
 * Returns the provider mix per user so the scanner knows what to run:
 *   { user_id, has_gmail: boolean, imap_providers: string[] }
 *
 * @param {{ minHoursSinceLastScan?: number, limit?: number }} opts
 */
export async function getUsersDueForScan({ minHoursSinceLastScan = 12, limit = 200 } = {}) {
  try {
    const result = await pool.query(
      `SELECT
         u.user_id,
         EXISTS (
           SELECT 1 FROM oauth_tokens o
           WHERE o.user_id = u.user_id AND o.provider = 'google'
         ) AS has_gmail,
         COALESCE(
           ARRAY(SELECT provider FROM imap_credentials i WHERE i.user_id = u.user_id),
           '{}'
         ) AS imap_providers
       FROM (
         SELECT user_id FROM oauth_tokens WHERE provider = 'google'
         UNION
         SELECT user_id FROM imap_credentials
       ) u
       WHERE EXISTS (SELECT 1 FROM push_tokens p WHERE p.user_id = u.user_id)
         AND NOT EXISTS (
           SELECT 1 FROM scan_metadata sm
           WHERE sm.user_id = u.user_id
             AND sm.created_at > NOW() - make_interval(hours => $1)
         )
       ORDER BY u.user_id
       LIMIT $2`,
      [minHoursSinceLastScan, limit]
    );
    return result.rows.map((r) => ({
      userId: r.user_id,
      hasGmail: r.has_gmail === true,
      imapProviders: Array.isArray(r.imap_providers) ? r.imap_providers : [],
    }));
  } catch (err) {
    throw new Error(`db_get_users_due_for_scan_failed: ${err.message}`);
  }
}
