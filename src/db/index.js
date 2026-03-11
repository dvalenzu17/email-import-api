import pkg from "pg";
const { Pool } = pkg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// -------------------------
// USERS
// -------------------------

export async function findOrCreateUser(supabaseId, email) {
  await pool.query(
    `INSERT INTO users (id, email)
     VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
    [supabaseId, email]
  );
}

// -------------------------
// OAUTH TOKENS
// -------------------------

export async function saveOAuthTokens(userId, tokens) {
  await pool.query(
    `INSERT INTO oauth_tokens (user_id, provider, access_token, refresh_token, expiry_date)
     VALUES ($1, 'google', $2, $3, NOW() + ($4 || ' seconds')::interval)
     ON CONFLICT (user_id, provider)
     DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expiry_date = EXCLUDED.expiry_date`,
    [userId, tokens.accessToken, tokens.refreshToken, tokens.expiresIn]
  );
}

export async function getOAuthToken(userId) {
  const result = await pool.query(
    "SELECT * FROM oauth_tokens WHERE user_id = $1 AND provider = 'google'",
    [userId]
  );
  return result.rows[0];
}

// -------------------------
// SUBSCRIPTIONS
// -------------------------

export async function upsertSubscription(userId, sub) {
  await pool.query(
    `INSERT INTO subscriptions (
      user_id,
      merchant,
      renewal_amount,
      currency,
      renewal_date,
      confidence,
      is_active,
      is_suggested,
      source,
      billing_interval
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (user_id, merchant)
    DO UPDATE SET
      renewal_amount = EXCLUDED.renewal_amount,
      renewal_date = EXCLUDED.renewal_date,
      confidence = EXCLUDED.confidence,
      is_active = EXCLUDED.is_active,
      is_suggested = EXCLUDED.is_suggested,
      billing_interval = EXCLUDED.billing_interval,
      updated_at = NOW()`,
    [
      userId,
      sub.merchant,
      sub.renewalAmount,
      sub.currency,
      sub.renewalDate,
      sub.confidence,
      sub.isActive,
      sub.isSuggested,
      sub.source,
      sub.billingInterval ?? null,
    ]
  );
}

export async function getSubscriptions(userId) {
  const result = await pool.query(
    "SELECT * FROM subscriptions WHERE user_id = $1",
    [userId]
  );
  return result.rows;
}

// -------------------------
// SCAN METADATA
// -------------------------

export async function saveScanMetadata(userId, meta) {
  await pool.query(
    `INSERT INTO scan_metadata (
      user_id,
      scanned_messages,
      detected_charges,
      execution_time_ms
    )
    VALUES ($1,$2,$3,$4)`,
    [userId, meta.scannedMessages, meta.detectedCharges, meta.executionTimeMs]
  );
}

export async function getLatestScanMetadata(userId) {
  const result = await pool.query(
    `SELECT * FROM scan_metadata
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

// -------------------------
// IMAP CREDENTIALS
// -------------------------

export async function saveImapCredentials(userId, { provider, user, pass }) {
  const { encryptCredential } = await import("../services/crypto.js");
  const encryptedPass = encryptCredential(pass);

  await pool.query(
    `INSERT INTO imap_credentials (user_id, provider, imap_user, imap_pass)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, provider)
     DO UPDATE SET
       imap_user = EXCLUDED.imap_user,
       imap_pass = EXCLUDED.imap_pass,
       updated_at = NOW()`,
    [userId, provider, user, encryptedPass]
  );
}

export async function getImapCredentials(userId, provider) {
  const result = await pool.query(
    `SELECT * FROM imap_credentials WHERE user_id = $1 AND provider = $2`,
    [userId, provider]
  );
  return result.rows[0] ?? null;
}