/**
 * Core Gmail scan logic, decoupled from the HTTP request/response cycle.
 * Called by the synchronous route handler (QUEUE_ENABLED=false) and by the
 * BullMQ Worker (QUEUE_ENABLED=true).
 *
 * @param {{
 *   userId: string,
 *   daysBack?: number,
 *   onProgress?: (pct: number, message: string) => void
 * }} opts
 * @returns {Promise<{ detectedSubscriptions: number, scannedMessages: number, detectedCharges: number, executionTimeMs: number }>}
 */

import {
  fetchMessage,
  extractText,
  extractAmount,
  extractRenewalDate,
  extractMerchant,
  cleanEmailHtml,
} from "../gmailClient.js";
import { extractCurrencyCode } from "./emailParser.js";
import { detectRecurringSubscriptions } from "./subscriptionEngine.js";
import { getOAuthToken, batchUpsertSubscriptions, saveScanMetadata, saveOAuthTokens } from "../db/index.js";
import { decryptCredential } from "./crypto.js";
import { refreshAccessToken } from "../googleOAuth.js";
import { withRetry, CircuitBreaker } from "./retryUtil.js";
import { filterUnprocessedIds, markProcessedIds } from "./messageCache.js";
import pLimit from "p-limit";

const SUBSCRIPTION_NEGATIVE_PATTERNS = [
  "trip with uber", "thanks for riding", "order with uber eats",
  "your uber eats order", "you've earned", "reward", "you ordered",
  "is on its way", "out for delivery", "has been shipped",
  "tracking number", "your order has", "rate your experience",
  "left a review", "survey", "unsubscribe from marketing",
  "you've been charged a late fee", "one-time", "one time purchase",
  "your amazon.com order", "order confirmation", "items ordered",
  "estimated delivery", "shipping confirmation", "your package",
  "arriving", "payment declined", "update your payment",
  "unable to process your payment", "trouble authorizing", "failed payment",
];

const SUBSCRIPTION_POSITIVE_DOMAINS = [
  "netflix.com", "spotify.com", "openai.com", "adobe.com",
  "apple.com", "google.com", "amazon.com", "microsoft.com",
  "dropbox.com", "slack.com", "notion.so", "figma.com",
  "github.com", "anthropic.com", "chatgpt.com", "hulu.com",
  "disneyplus.com", "youtube.com", "linkedin.com", "zoom.us",
  "shopify.com", "squarespace.com", "wix.com", "webflow.io",
];

function maybeDecrypt(val) {
  if (!val) return val;
  const parts = String(val).split(":");
  if (parts.length === 3 && parts[0].length === 24) {
    try { return decryptCredential(val); } catch { return val; }
  }
  return val;
}

export async function runGmailScan({ userId, daysBack = 180, onProgress }) {
  const progress = onProgress ?? (() => {});
  const started = Date.now();

  // ── Step 1: Resolve access token ─────────────────────────────────────────
  progress(5, "Resolving access token");

  const tokenRecord = await getOAuthToken(userId);
  if (!tokenRecord) throw new Error("gmail_not_connected");

  let accessToken = tokenRecord.access_token;
  const rawRefreshToken = maybeDecrypt(tokenRecord.refresh_token);

  if (new Date(tokenRecord.expiry_date) < new Date()) {
    const refreshed = await withRetry(
      () => refreshAccessToken({
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        refreshToken: rawRefreshToken,
      }),
      { maxAttempts: 2, baseDelayMs: 1000 }
    );
    accessToken = refreshed.accessToken;
    await saveOAuthTokens(userId, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? rawRefreshToken,
      expiresIn: refreshed.expiresIn,
    });
  }

  // ── Step 2: List messages ─────────────────────────────────────────────────
  progress(10, "Fetching message list");

  const query = `newer_than:${daysBack}d (subject:receipt OR subject:invoice OR subject:subscription OR subject:renewal OR subject:payment OR subject:billing OR subject:membership OR subject:plan OR subject:welcome OR subject:"order confirmation")`;
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=500&q=${encodeURIComponent(query)}`;

  const listRes = await withRetry(
    async () => {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error(`gmail_list_failed: ${res.status}`);
      return res.json();
    },
    { maxAttempts: 3, baseDelayMs: 800, retryOn: (e) => CircuitBreaker.isTransient(e) }
  );

  const allIds = (listRes.messages ?? []).map((m) => m.id);

  // ── Step 3: Deduplicate (skip already-processed messages) ─────────────────
  progress(15, "Deduplicating message list");
  const newIds = await filterUnprocessedIds(userId, allIds);

  progress(20, `Fetching ${newIds.length} new messages`);

  // ── Step 4: Fetch messages with retry + circuit breaker ───────────────────
  const breaker = new CircuitBreaker({ threshold: 5 });
  const limit = pLimit(25);

  const fullMessages = await Promise.all(
    newIds.map((id) =>
      limit(async () => {
        try {
          const msg = await withRetry(
            async () => {
              const res = await fetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
                { headers: { Authorization: `Bearer ${accessToken}` } }
              );
              if (res.status === 429 || res.status >= 500) {
                const err = new Error(`gmail_fetch_failed: ${res.status}`);
                breaker.failure(err); // throws circuit_open at threshold
                throw err;
              }
              if (!res.ok) return null; // skip non-retryable errors (404 etc.)
              breaker.success();
              return res.json();
            },
            { maxAttempts: 3, baseDelayMs: 600, retryOn: (e) => CircuitBreaker.isTransient(e) }
          );
          return msg;
        } catch (err) {
          if (err.message === "circuit_open") throw err; // propagate to abort
          return null; // individual message failure is non-fatal
        }
      })
    )
  );

  progress(60, "Parsing messages");

  // ── Step 5: Extract charges ───────────────────────────────────────────────
  const charges = [];
  const processedIds = [];

  for (const full of fullMessages) {
    if (!full?.payload) continue;

    const headers = full.payload.headers;
    const rawHtml = extractText(full.payload);
    if (!rawHtml) continue;

    const text = cleanEmailHtml(rawHtml);
    if (!text || text.length < 30) continue;

    const isNegative = SUBSCRIPTION_NEGATIVE_PATTERNS.some((p) => text.includes(p));
    if (isNegative) continue;

    const transactional =
      text.includes("payment") || text.includes("charged") ||
      text.includes("invoice") || text.includes("successfully subscribed") ||
      text.includes("receipt") || text.includes("billing") || text.includes("renewal");

    if (!transactional) continue;

    const fromHeader = headers.find((h) => h.name === "From")?.value ?? "";
    const isKnownDomain = SUBSCRIPTION_POSITIVE_DOMAINS.some((d) =>
      fromHeader.toLowerCase().includes(d)
    );

    let amount = extractAmount(text);
    if (!amount && isKnownDomain) {
      const m = text.match(/(?:us\$|\$)([0-9]+(?:\.[0-9]{2})?)\s*(?:\/|\s*per\s*)(?:mo|month|yr|year)/i);
      if (m) amount = parseFloat(m[1]);
    }

    if (!amount || amount > 500) continue;

    const merchant = extractMerchant(fromHeader, text);
    if (merchant === "unknown") continue;

    const date = new Date(Number(full.internalDate));
    const renewalDate = extractRenewalDate(text);

    let intentScore = 0;
    if (text.includes("subscription"))              intentScore += 2;
    if (text.includes("membership"))                intentScore += 2;
    if (text.includes("automatically renew"))        intentScore += 3;
    if (text.includes("renews on"))                  intentScore += 3;
    if (text.includes("next billing"))               intentScore += 3;
    if (text.includes("/month") || text.includes("per month")) intentScore += 2;
    if (text.includes("/year")  || text.includes("per year"))  intentScore += 2;
    if (text.includes("valid until"))                intentScore += 2;
    if (text.includes("cancel anytime"))             intentScore += 3;
    if (text.includes("free trial"))                 intentScore += 2;
    if (text.includes("your plan"))                  intentScore += 2;
    if (text.includes("plan"))                       intentScore += 1;
    if (isKnownDomain)                               intentScore += 3;

    charges.push({ merchant, amount, currency: extractCurrencyCode(text), date, subscriptionIntent: intentScore >= 4, renewalDate });
    if (full.id) processedIds.push(full.id);
  }

  progress(80, "Detecting subscriptions");

  // ── Step 6: Detect + persist ──────────────────────────────────────────────
  const subscriptions = detectRecurringSubscriptions(charges);
  await batchUpsertSubscriptions(userId, subscriptions);

  await saveScanMetadata(userId, {
    scannedMessages: allIds.length,
    detectedCharges: charges.length,
    executionTimeMs: Date.now() - started,
  });

  // Mark processed IDs so they're skipped on the next scan.
  await markProcessedIds(userId, processedIds);

  progress(100, "Done");

  return {
    detectedSubscriptions: subscriptions.length,
    scannedMessages: allIds.length,
    detectedCharges: charges.length,
    executionTimeMs: Date.now() - started,
  };
}
