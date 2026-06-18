import { pool } from "./pool.js";

export async function getAdminUsersData({ limit = 100, offset = 0 } = {}) {
  try {
    // Get paginated user IDs first, then fetch their data.
    // This prevents unbounded full-table scans at scale.
    const userIdsRes = await pool.query(
      `SELECT DISTINCT user_id FROM subscriptions ORDER BY user_id LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const userIds = userIdsRes.rows.map((r) => r.user_id);
    if (!userIds.length) return [];

    const [subRes, scanRes] = await Promise.all([
      pool.query(`
        SELECT id, user_id, merchant, renewal_amount, currency, billing_interval,
               confidence, is_active, is_suggested, user_status, source, last_seen_at, created_at
        FROM subscriptions
        WHERE user_id = ANY($1::uuid[])
        ORDER BY user_id, created_at DESC
      `, [userIds]),
      pool.query(`
        SELECT DISTINCT ON (user_id)
          user_id, scanned_messages, detected_charges, created_at AS last_scan_at
        FROM scan_metadata
        WHERE user_id = ANY($1::uuid[])
        ORDER BY user_id, created_at DESC
      `, [userIds]),
    ]);

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
