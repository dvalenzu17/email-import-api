// db/index.js

import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });
// -------------------------
// USERS
// -------------------------

export async function findOrCreateUser(email) {
  const existing = await pool.query(
    "SELECT * FROM users WHERE email = $1",
    [email]
  );

  if (existing.rows.length) return existing.rows[0];

  const created = await pool.query(
    "INSERT INTO users (email) VALUES ($1) RETURNING *",
    [email]
  );

  return created.rows[0];
}

// -------------------------
// OAUTH TOKENS
// -------------------------

export async function saveOAuthTokens(userId, tokens) {
  await pool.query(
    `
    INSERT INTO oauth_tokens (user_id, provider, access_token, refresh_token, expiry_date)
    VALUES ($1, 'google', $2, $3, NOW() + ($4 || ' seconds')::interval)
    ON CONFLICT (user_id, provider)
    DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      expiry_date = EXCLUDED.expiry_date
    `,
    [
      userId,
      tokens.accessToken,
      tokens.refreshToken,
      tokens.expiresIn
    ]
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
    `
    INSERT INTO subscriptions (
      user_id,
      merchant,
      renewal_amount,
      currency,
      renewal_date,
      confidence,
      is_active,
      is_suggested,
      source
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (user_id, merchant)
    DO UPDATE SET
      renewal_amount = EXCLUDED.renewal_amount,
      renewal_date = EXCLUDED.renewal_date,
      confidence = EXCLUDED.confidence,
      is_active = EXCLUDED.is_active,
      is_suggested = EXCLUDED.is_suggested,
      updated_at = NOW()
    `,
    [
      userId,
      sub.merchant,
      sub.renewalAmount,
      sub.currency,
      sub.renewalDate,
      sub.confidence,
      sub.isActive,
      sub.isSuggested,
      sub.source
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
    `
    INSERT INTO scan_metadata (
      user_id,
      scanned_messages,
      detected_charges,
      execution_time_ms
    )
    VALUES ($1,$2,$3,$4)
    `,
    [
      userId,
      meta.scannedMessages,
      meta.detectedCharges,
      meta.executionTimeMs
    ]
  );
}

export async function getLatestScanMetadata(userId) {
  const result = await pool.query(
    `
    SELECT * FROM scan_metadata
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] || null;
}