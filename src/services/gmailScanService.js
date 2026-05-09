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
import { getOAuthToken, batchUpsertSubscriptions, saveScanMetadata, saveOAuthTokens, cancelSubscriptionByMerchant, getFeedbackMerchantMap } from "../db/index.js";
import { classifyEmail, EMAIL_TYPES } from "./emailClassifier.js";
import { decryptCredential } from "./crypto.js";
import { refreshAccessToken } from "../googleOAuth.js";
import { withRetry, CircuitBreaker } from "./retryUtil.js";
import { filterUnprocessedIds, markProcessedIds, clearUserCache } from "./messageCache.js";
import pLimit from "p-limit";

// Hard negatives — always filter regardless of domain.
// These are unambiguous non-subscription signals.
const SUBSCRIPTION_NEGATIVE_PATTERNS = [
  "trip with uber", "thanks for riding",
  "your uber eats order",
  "is on its way", "out for delivery", "has been shipped",
  "tracking number", "your order has",
  "unsubscribe from marketing",
  "you've been charged a late fee", "one-time", "one time purchase",
  "your amazon.com order", "items ordered",
  "money sent", "you sent a payment", "you paid",
  "estimated delivery", "shipping confirmation", "your package",
  "arriving", "unable to process your payment", "failed payment",
];

// Soft negatives — only applied to emails NOT from a known positive domain.
// These phrases sometimes appear in footers of valid billing emails from known
// services (e.g. Netflix includes "survey" links, Uber One says "you've earned
// Uber Cash", billing confirmations say "rate your experience").
const SUBSCRIPTION_SOFT_NEGATIVES = [
  "order confirmation", "payment declined", "update your payment",
  "trouble authorizing", "reward",
  "you've earned", "you ordered",
  "rate your experience", "left a review", "survey",
];

const SUBSCRIPTION_POSITIVE_DOMAINS = [
  "netflix.com", "netflixcommunication.com", "spotify.com", "openai.com", "adobe.com",
  "apple.com", "google.com", "amazon.com", "microsoft.com",
  "dropbox.com", "slack.com", "notion.so", "figma.com",
  "github.com", "anthropic.com", "chatgpt.com", "hulu.com",
  "disneyplus.com", "youtube.com", "linkedin.com", "zoom.us",
  "shopify.com", "squarespace.com", "wix.com", "webflow.io",
  "uber.com", "canva.com", "grammarly.com", "duolingo.com",
  "headspace.com", "calm.com", "peloton.com", "substack.com",
  "patreon.com", "medium.com", "crunchyroll.com", "twitch.tv",
  "audible.com", "vercel.com", "netlify.com", "airtable.com",
  "hubspot.com", "intercom.com", "zendesk.com",
];

function maybeDecrypt(val) {
  if (!val) return val;
  const parts = String(val).split(":");
  if (parts.length === 3 && parts[0].length === 24) {
    try { return decryptCredential(val); } catch { return val; }
  }
  return val;
}

export async function runGmailScan({ userId, daysBack = 180, onProgress, force = false }) {
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

  const query = [
    `newer_than:${daysBack}d`,
    '(subject:receipt OR subject:invoice OR subject:subscription OR subject:renewal',
    'OR subject:payment OR subject:billing OR subject:membership OR subject:plan',
    'OR subject:charged OR subject:billed OR subject:"your subscription"',
    'OR subject:"payment confirmation" OR subject:"payment received"',
    'OR subject:"thanks for subscribing" OR subject:"thank you for subscribing"',
    'OR subject:"auto-renew" OR subject:"next billing")',
    '-subject:shipped -subject:delivered -subject:delivery -subject:tracking',
    '-subject:"order confirmation" -subject:"your order" -subject:"order has"',
    '-subject:"security code" -subject:"verify your" -subject:"confirm your email"',
    '-subject:"sign in" -subject:password -subject:refund -subject:"gift card"',
  ].join(' ');
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
  console.log(`[scan] gmail_query_results: ${allIds.length} messages found for userId=${userId} force=${force}`);

  // ── Step 3: Deduplicate (skip already-processed messages) ─────────────────
  progress(15, "Deduplicating message list");
  if (force) await clearUserCache(userId);
  const newIds = force ? allIds : await filterUnprocessedIds(userId, allIds);
  console.log(`[scan] after_dedup: ${newIds.length} new messages (${allIds.length - newIds.length} already cached)`);

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
  const cancellations = []; // merchants whose cancellation emails were detected

  // Diagnostic counters — returned alongside scan results for visibility.
  let filtered_no_payload = 0, filtered_no_text = 0, filtered_negative = 0,
      filtered_not_transactional = 0, filtered_no_amount = 0, filtered_no_merchant = 0,
      filtered_lifecycle = 0;

  for (const full of fullMessages) {
    if (!full?.payload) { filtered_no_payload++; continue; }

    const headers = full.payload.headers;
    const rawHtml = extractText(full.payload);
    if (!rawHtml) { filtered_no_text++; continue; }

    const text = cleanEmailHtml(rawHtml);
    if (!text || text.length < 30) { filtered_no_text++; continue; }

    const fromHeader = headers.find((h) => h.name === "From")?.value ?? "";
    const subject    = headers.find((h) => h.name === "Subject")?.value ?? "";

    // ── Email type classification ───────────────────────────────────────────
    const emailType = classifyEmail(subject, text);

    if (emailType === EMAIL_TYPES.CANCELLATION) {
      // Extract which merchant was cancelled and queue for lifecycle update.
      const merchant = extractMerchant(fromHeader, text, subject);
      if (merchant && merchant !== "unknown") cancellations.push(merchant);
      filtered_lifecycle++;
      continue; // not a charge
    }

    if (emailType === EMAIL_TYPES.FAILED_PAYMENT) {
      filtered_lifecycle++;
      continue; // payment failed — not a successful charge
    }

    // trial_start, trial_ending, upgrade, renewal_notice, receipt → continue
    // to charge extraction (they may carry an amount we want to track).

    const isKnownDomain = SUBSCRIPTION_POSITIVE_DOMAINS.some((d) =>
      fromHeader.toLowerCase().includes(d)
    );

    // Hard negatives apply to all emails. Soft negatives only apply to emails
    // not from a known billing domain (to avoid filtering valid receipts that
    // mention "update your payment" in their footer).
    const isNegative =
      SUBSCRIPTION_NEGATIVE_PATTERNS.some((p) => text.includes(p)) ||
      (!isKnownDomain && SUBSCRIPTION_SOFT_NEGATIVES.some((p) => text.includes(p)));
    if (isNegative) { filtered_negative++; continue; }

    // Broadened transactional check — subscription billing emails may use
    // "member", "subscript", "charge", "paid", "auto-renew" without the older
    // keywords. Known-domain emails bypass this check entirely since any charge
    // from netflix.com / anthropic.com etc. is by definition transactional.
    const transactional =
      isKnownDomain ||
      text.includes("payment") || text.includes("charged") ||
      text.includes("invoice") || text.includes("successfully subscribed") ||
      text.includes("receipt") || text.includes("billing") || text.includes("renewal") ||
      text.includes("subscript") || text.includes("member") ||
      text.includes("paid") || text.includes("charge") || text.includes("auto-renew");

    if (!transactional) { filtered_not_transactional++; continue; }

    let amount = extractAmount(text);
    if (!amount && isKnownDomain) {
      const m = text.match(/(?:us\$|\$)([0-9]+(?:\.[0-9]{2})?)\s*(?:\/|\s*per\s*)(?:mo|month|yr|year)/i);
      if (m) amount = parseFloat(m[1]);
    }

    if (!amount) { filtered_no_amount++; continue; }

    const merchant = extractMerchant(fromHeader, text, subject);
    if (merchant === "unknown") { filtered_no_merchant++; continue; }

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

    // Threshold lowered from 4 → 2: a single mention of "subscription" or
    // "membership" is enough intent signal when paired with a valid amount.
    charges.push({ merchant, amount, currency: extractCurrencyCode(text), date, subscriptionIntent: intentScore >= 2, renewalDate, _msgId: full.id });
  }

  console.log(`[scan] charges_extracted: ${charges.length} | filters: noPayload=${filtered_no_payload} noText=${filtered_no_text} negative=${filtered_negative} notTransactional=${filtered_not_transactional} noAmount=${filtered_no_amount} noMerchant=${filtered_no_merchant} lifecycle=${filtered_lifecycle} cancellations=${cancellations.length}`);
  if (charges.length > 0) {
    const byMerchant = {};
    for (const c of charges) byMerchant[c.merchant] = (byMerchant[c.merchant] ?? 0) + 1;
    console.log(`[scan] charges_by_merchant:`, JSON.stringify(byMerchant));
  }

  progress(80, "Detecting subscriptions");

  // ── Step 6: Detect + persist ──────────────────────────────────────────────
  // Fetch per-user feedback labels to personalise confidence scores.
  const feedbackMap = await getFeedbackMerchantMap(userId);

  const subscriptions = detectRecurringSubscriptions(charges, { feedbackMap });
  console.log(`[scan] subscriptions_detected: ${subscriptions.length}`, subscriptions.map(s => `${s.merchant}(${s.confidence})`));
  const confident = subscriptions.filter((s) => s.confidence >= 0.7);
  console.log(`[scan] subscriptions_above_threshold: ${confident.length}`);
  await batchUpsertSubscriptions(userId, confident);

  // ── Step 7: Lifecycle events ──────────────────────────────────────────────
  // Apply cancellations detected during scan (cancellation emails auto-mark
  // the matching subscription inactive without the user needing to do it manually).
  if (cancellations.length) {
    console.log(`[scan] lifecycle_cancellations: ${cancellations.join(", ")}`);
    await Promise.allSettled(
      cancellations.map((merchant) => cancelSubscriptionByMerchant(userId, merchant))
    );
  }

  await saveScanMetadata(userId, {
    scannedMessages: allIds.length,
    detectedCharges: charges.length,
    executionTimeMs: Date.now() - started,
  });

  // Only mark messages as processed if their merchant produced a detected subscription.
  // This ensures that emails filtered by tight thresholds can be re-evaluated on the
  // next scan (e.g. after filters are loosened or more charges accumulate).
  const detectedMerchants = new Set(subscriptions.map((s) => s.merchant));
  const processedIds = charges
    .filter((c) => detectedMerchants.has(c.merchant) && c._msgId)
    .map((c) => c._msgId);

  await markProcessedIds(userId, processedIds);

  progress(100, "Done");

  return {
    // Return subscriptions so the frontend can display them directly without
    // falling back to GET /subscriptions (which returns all providers).
    subscriptions: confident,
    detectedSubscriptions: subscriptions.length,
    scannedMessages: allIds.length,
    newMessages: newIds.length,
    detectedCharges: charges.length,
    executionTimeMs: Date.now() - started,
    filterBreakdown: {
      noPayload: filtered_no_payload,
      noText: filtered_no_text,
      negativePattern: filtered_negative,
      notTransactional: filtered_not_transactional,
      noAmount: filtered_no_amount,
      noMerchant: filtered_no_merchant,
    },
  };
}
