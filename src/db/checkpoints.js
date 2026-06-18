import { pool } from "./pool.js";

export async function getScanCheckpoint(userId, provider) {
  try {
    const result = await pool.query(
      `SELECT last_message_date, last_message_id FROM scan_checkpoints
       WHERE user_id = $1 AND provider = $2`,
      [userId, provider]
    );
    return result.rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function saveScanCheckpoint(userId, provider, { lastMessageDate, lastMessageId }) {
  try {
    await pool.query(
      `INSERT INTO scan_checkpoints (user_id, provider, last_message_date, last_message_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, provider)
       DO UPDATE SET
         last_message_date = EXCLUDED.last_message_date,
         last_message_id = EXCLUDED.last_message_id,
         updated_at = NOW()`,
      [userId, provider, lastMessageDate, lastMessageId]
    );
  } catch {
    // Non-fatal: worst case we do a full scan next time.
  }
}
