import { pool } from "./pool.js";

/**
 * Returns the Expo push tokens registered for a user.
 * The `push_tokens` table is written by the mobile app (lib/push.js):
 *   columns: user_id (uuid), token (text), device (text).
 * Scoped by user_id — never returns another user's tokens.
 *
 * @param {string} userId
 * @returns {Promise<string[]>} list of Expo push tokens
 */
export async function getPushTokensForUser(userId) {
  if (!userId) return [];
  try {
    const result = await pool.query(
      `SELECT token FROM push_tokens WHERE user_id = $1 AND token IS NOT NULL`,
      [userId]
    );
    return result.rows.map((r) => r.token).filter(Boolean);
  } catch (err) {
    // Best-effort: a missing table or query error must never break a scan.
    throw new Error(`db_get_push_tokens_failed: ${err.message}`);
  }
}
