import jwt from "jsonwebtoken";
import {
  fetchMessage,
  extractText,
  extractAmount,
  extractMerchant,
  cleanEmailHtml,
} from "../gmailClient.js";

import { detectRecurringSubscriptions } from "../services/subscriptionEngine.js";
import { getOAuthToken, upsertSubscription, saveScanMetadata, saveOAuthTokens } from "../db/index.js";
import pLimit from "p-limit";
import { refreshAccessToken } from "../googleOAuth.js";

const SUBSCRIPTION_NEGATIVE_PATTERNS = [
  "trip with uber",
  "thanks for riding",
  "order with uber eats",
  "your uber eats order",
  "you've earned",
  "reward",
  "you ordered",
  "is on its way",
  "out for delivery",
  "has been shipped",
  "tracking number",
  "your order has",
  "rate your experience",
  "left a review",
  "survey",
  "unsubscribe from marketing",
  "you've been charged a late fee",
  "one-time",
  "one time purchase",
  "your amazon.com order",
  "order confirmation",
  "items ordered",
  "estimated delivery",
  "shipping confirmation",
  "your package",
  "arriving",
  "payment declined",
  "update your payment",
  "unable to process your payment",
  "trouble authorizing",
  "failed payment",
  "action required",
];

const SUBSCRIPTION_POSITIVE_DOMAINS = [
  "netflix.com", "spotify.com", "openai.com", "adobe.com",
  "apple.com", "google.com", "amazon.com", "microsoft.com",
  "dropbox.com", "slack.com", "notion.so", "figma.com",
  "github.com", "anthropic.com", "chatgpt.com", "hulu.com",
  "disneyplus.com", "youtube.com", "linkedin.com", "zoom.us",
  "shopify.com", "squarespace.com", "wix.com", "webflow.io",
];

const SCAN_RATE_LIMIT = {
  max: 3,
  timeWindow: "15 minutes",
  keyGenerator: (req) => {
    try {
      const token = req.headers.authorization?.split(" ")[1];
      const decoded = jwt.decode(token);
      return decoded?.sub ?? req.ip;
    } catch {
      return req.ip;
    }
  },
  errorResponseBuilder: () => ({
    error: "rate_limited",
    message: "Too many scans. Please wait 15 minutes before scanning again.",
  }),
};

export function registerScanRoutes(server) {
  server.post("/scan", { config: { rateLimit: SCAN_RATE_LIMIT } }, async (req, reply) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(" ")[1];

    if (!token) return reply.code(401).send({ error: "unauthorized" });

    let userId;
    try {
      const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
      userId = decoded.sub;
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }

    if (!userId) return reply.code(401).send({ error: "unauthorized" });

    const daysBack = Math.min(Number(req.body?.daysBack) || 180, 730);
    const started = Date.now();

    try {
      const tokenRecord = await getOAuthToken(userId);
      if (!tokenRecord) {
        return reply.code(400).send({ error: "gmail_not_connected" });
      }

      let accessToken = tokenRecord.access_token;

      if (new Date(tokenRecord.expiry_date) < new Date()) {
        const refreshed = await refreshAccessToken({
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          refreshToken: tokenRecord.refresh_token,
        });

        accessToken = refreshed.accessToken;

        await saveOAuthTokens(userId, {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? tokenRecord.refresh_token,
          expiresIn: refreshed.expiresIn,
        });
      }

      const query = `newer_than:${daysBack}d (subject:receipt OR subject:invoice OR subject:subscription OR subject:renewal OR subject:payment OR subject:billing OR subject:membership OR subject:plan OR subject:welcome OR subject:"order confirmation")`;
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=500&q=${encodeURIComponent(query)}`;
      const listRes = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const listData = await listRes.json();
      const ids = listData.messages || [];

      const limit = pLimit(10);
      const fullMessages = await Promise.all(
        ids.map((m) => limit(() => fetchMessage(accessToken, m.id)))
      );

      const charges = [];

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
          text.includes("payment") ||
          text.includes("charged") ||
          text.includes("invoice") ||
          text.includes("successfully subscribed") ||
          text.includes("receipt") ||
          text.includes("billing") ||
          text.includes("renewal");

        if (!transactional) continue;

        // Check known domain early — needed for plan price fallback
        const fromHeader = headers.find((h) => h.name === "From")?.value ?? "";
        const isKnownDomain = SUBSCRIPTION_POSITIVE_DOMAINS.some((d) =>
          fromHeader.toLowerCase().includes(d)
        );

        let amount = extractAmount(text);

        // For known subscription domains, fall back to plan price if no transaction amount
        if (!amount && isKnownDomain) {
          const planMatch = text.match(/\$([0-9]+(?:\.[0-9]{2})?)\s*(?:\/|\s*per\s*)(?:mo|month|yr|year)/i);
          if (planMatch) amount = parseFloat(planMatch[1]);
        }

        if (!amount) continue;
        if (amount > 100) continue;

        const merchant = extractMerchant(headers);
        if (merchant === "unknown") continue;

        const date = new Date(Number(full.internalDate));

        let intentScore = 0;
        if (text.includes("subscription")) intentScore += 2;
        if (text.includes("membership")) intentScore += 2;
        if (text.includes("automatically renew")) intentScore += 3;
        if (text.includes("renews on")) intentScore += 3;
        if (text.includes("next billing")) intentScore += 3;
        if (text.includes("/month") || text.includes("per month")) intentScore += 2;
        if (text.includes("/year") || text.includes("per year")) intentScore += 2;
        if (text.includes("valid until")) intentScore += 2;
        if (text.includes("cancel anytime")) intentScore += 3;
        if (text.includes("free trial")) intentScore += 2;
        if (text.includes("your plan")) intentScore += 2;
        if (text.includes("plan")) intentScore += 1;
        if (isKnownDomain) intentScore += 3;

        const subscriptionIntent = intentScore >= 4;

        charges.push({ merchant, amount, date, subscriptionIntent });
      }

      const subscriptions = detectRecurringSubscriptions(charges);

      for (const sub of subscriptions) {
        if (sub.confidence >= 0.6) {
          await upsertSubscription(userId, sub);
        }
      }

      await saveScanMetadata(userId, {
        scannedMessages: ids.length,
        detectedCharges: charges.length,
        executionTimeMs: Date.now() - started,
      });

      return {
        success: true,
        detectedSubscriptions: subscriptions.length,
        meta: {
          scannedMessages: ids.length,
          detectedCharges: charges.length,
          executionTimeMs: Date.now() - started,
        },
      };
    } catch (err) {
      console.error("SCAN ERROR:", err);
      return reply.code(500).send({ error: "scan_failed", details: err.message });
    }
  });
}