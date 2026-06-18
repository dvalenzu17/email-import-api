import { pool } from "./pool.js";
import { encryptCredential } from "../services/crypto.js";

export async function saveImapCredentials(userId, { provider, user, pass }) {
  try {
    const encryptedPass = encryptCredential(pass);
    await pool.query(
      `INSERT INTO imap_credentials (user_id, provider, imap_user, imap_pass)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, provider)
       DO UPDATE SET
         imap_user  = EXCLUDED.imap_user,
         imap_pass  = EXCLUDED.imap_pass,
         updated_at = NOW()`,
      [userId, provider, user, encryptedPass]
    );
  } catch (err) {
    throw new Error(`db_save_imap_credentials_failed: ${err.message}`);
  }
}

export async function getImapCredentials(userId, provider) {
  try {
    const result = await pool.query(
      `SELECT * FROM imap_credentials WHERE user_id = $1 AND provider = $2`,
      [userId, provider]
    );
    return result.rows[0] ?? null;
  } catch (err) {
    throw new Error(`db_get_imap_credentials_failed: ${err.message}`);
  }
}
