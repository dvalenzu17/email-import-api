/**
 * Shared Gmail access-token acquisition: read the stored OAuth token, refresh
 * it if expired, and persist the refresh. Mirrors the logic inside
 * runGmailScan so the push/watch code authenticates identically without
 * touching the tested scan path.
 */
import { getOAuthToken, saveOAuthTokens } from "../db/index.js";
import { decryptCredential } from "./crypto.js";
import { refreshAccessToken } from "../googleOAuth.js";

function maybeDecrypt(val) {
  if (!val) return val;
  const parts = String(val).split(":");
  if (parts.length === 3 && parts[0].length === 24) {
    try { return decryptCredential(val); } catch { return val; }
  }
  return val;
}

/**
 * @param {string} userId
 * @returns {Promise<string>} a valid Gmail access token
 */
export async function getGmailAccessToken(userId) {
  const rec = await getOAuthToken(userId);
  if (!rec) throw new Error("gmail_not_connected");

  let accessToken = rec.access_token;
  const rawRefreshToken = maybeDecrypt(rec.refresh_token);

  if (new Date(rec.expiry_date) < new Date()) {
    const refreshed = await refreshAccessToken({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken: rawRefreshToken,
    });
    accessToken = refreshed.accessToken;
    await saveOAuthTokens(userId, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? rawRefreshToken,
      expiresIn: refreshed.expiresIn,
    });
  }

  return accessToken;
}
