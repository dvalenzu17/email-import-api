import { pool } from "./pool.js";

export async function saveOAuthTokens(userId, tokens) {
  try {
    await pool.query(
      `INSERT INTO oauth_tokens (user_id, provider, access_token, refresh_token, expiry_date)
       VALUES ($1, 'google', $2, $3, NOW() + ($4 || ' seconds')::interval)
       ON CONFLICT (user_id, provider)
       DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expiry_date = EXCLUDED.expiry_date,
         updated_at = NOW()`,
      [userId, tokens.accessToken, tokens.refreshToken, tokens.expiresIn]
    );
  } catch (err) {
    throw new Error(`db_save_oauth_tokens_failed: ${err.message}`);
  }
}

export async function getOAuthToken(userId) {
  try {
    const result = await pool.query(
      "SELECT * FROM oauth_tokens WHERE user_id = $1 AND provider = 'google'",
      [userId]
    );
    return result.rows[0];
  } catch (err) {
    throw new Error(`db_get_oauth_token_failed: ${err.message}`);
  }
}
