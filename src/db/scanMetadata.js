import { pool } from "./pool.js";

export async function getUserScanCount(userId) {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) AS count FROM scan_metadata WHERE user_id = $1`,
      [userId]
    );
    return parseInt(result.rows[0].count, 10);
  } catch (err) {
    throw new Error(`db_get_user_scan_count_failed: ${err.message}`);
  }
}

export async function saveScanMetadata(userId, meta) {
  try {
    await pool.query(
      `INSERT INTO scan_metadata (user_id, scanned_messages, detected_charges, execution_time_ms)
       VALUES ($1,$2,$3,$4)`,
      [userId, meta.scannedMessages, meta.detectedCharges, meta.executionTimeMs]
    );
    await pool.query(
      `DELETE FROM scan_metadata
       WHERE id IN (
         SELECT id FROM scan_metadata
         WHERE user_id = $1
         ORDER BY created_at DESC
         OFFSET 10
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
