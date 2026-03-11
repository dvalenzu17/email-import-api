import * as cheerio from "cheerio";
import he from "he";

export async function listRecentMessages(accessToken) {
  const url =
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=500&q=newer_than:180d";
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  return data.messages || [];
}

export async function fetchMessage(accessToken, messageId) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.json();
}

export function decodeBody(data) {
  if (!data) return "";
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

export function extractText(payload) {
  if (!payload) return "";

  if (payload.body?.data) {
    return decodeBody(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (
        (part.mimeType === "text/plain" || part.mimeType === "text/html") &&
        part.body?.data
      ) {
        return decodeBody(part.body.data);
      }

      if (part.parts) {
        for (const nested of part.parts) {
          if (
            (nested.mimeType === "text/plain" || nested.mimeType === "text/html") &&
            nested.body?.data
          ) {
            return decodeBody(nested.body.data);
          }
        }
      }
    }
  }

  return "";
}

export function cleanEmailHtml(html) {
  if (!html) return "";

  const $ = cheerio.load(html);

  $("style").remove();
  $("script").remove();
  $("head").remove();
  $("meta").remove();
  $("link").remove();

  let text = $("body").text();

  text = he.decode(text);

  text = text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return text;
}

export function extractAmount(text) {
  const totalMatch = text.match(/total\s*[:\-]?\s*\$([0-9]+(?:\.[0-9]{2})?)/i);
  if (totalMatch) return parseFloat(totalMatch[1]);

  const chargedMatch = text.match(/charged\s*\$([0-9]+(?:\.[0-9]{2})?)/i);
  if (chargedMatch) return parseFloat(chargedMatch[1]);

  // Plan price — catches "$8.99/month", "US$14.99/year"
  const planMatch = text.match(/(?:us\$|\$)([0-9]+(?:\.[0-9]{2})?)\s*(?:\/|\s*per\s*)(?:month|year|mo|yr)/i);
  if (planMatch) return parseFloat(planMatch[1]);

  const allMatches = [...text.matchAll(/\$([0-9]+(?:\.[0-9]{2})?)/g)];
  if (!allMatches.length) return null;

  const filtered = allMatches.filter((m) => parseFloat(m[1]) <= 100);
  if (!filtered.length) return null;

  return parseFloat(filtered[filtered.length - 1][1]);
}

export function extractRenewalDate(text) {
  const patterns = [
    /starting from\s+(\d{1,2}\s+\w+\s+\d{4})/i,
    /renews on\s+(\w+\s+\d{1,2},?\s+\d{4})/i,
    /renews\s+(\w+\s+\d{1,2},?\s+\d{4})/i,
    /next billing date[:\s]+(\w+\s+\d{1,2},?\s+\d{4})/i,
    /renewal date[:\s]+(\w+\s+\d{1,2},?\s+\d{4})/i,
    /will renew on\s+(\w+\s+\d{1,2},?\s+\d{4})/i,
    /automatically renews\s+(?:on\s+)?(\w+\s+\d{1,2},?\s+\d{4})/i,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const d = new Date(m[1]);
      if (!isNaN(d.getTime())) return d;
    }
  }

  return null;
}

function extractAppleAppName(text) {
  // Apple renewal emails follow the pattern (lowercased after cleanEmailHtml):
  // "... app name app name plan name (duration) us$x.xx/year ..."
  // We extract the text that appears just before the price line.

  // Try to find "X (1 year)" or "X premium (1 year)" style plan descriptor
  const planDescriptor = text.match(
    /([a-z0-9][a-z0-9\s\-\+\:]+?)\s+\([0-9]+\s+(?:year|month|yr|mo)s?\)/i
  );
  if (planDescriptor) {
    const raw = planDescriptor[1].trim();
    // Strip trailing plan/subscription keywords
    const cleaned = raw
      .replace(/\s+(premium|plus|pro|basic|standard|annual|monthly|plan|subscription)$/i, "")
      .trim();
    if (cleaned.length > 2) return cleaned;
  }

  // Fallback: text immediately before "us$X.XX/year" or "us$X.XX/month"
  const priceAnchor = text.match(
    /([a-z0-9][a-z0-9\s\-\+]{2,40}?)\s+us\$[0-9]+(?:\.[0-9]{2})?\/(?:year|month|yr|mo)/i
  );
  if (priceAnchor) {
    const raw = priceAnchor[1].trim();
    const cleaned = raw
      .replace(/\s+(premium|plus|pro|basic|standard|annual|monthly|plan|subscription)$/i, "")
      .trim();
    if (cleaned.length > 2) return cleaned;
  }

  return null;
}

export function extractMerchant(headers, text = "") {
  const from = headers.find((h) => h.name === "From")?.value;
  if (!from) return "unknown";

  const emailMatch = from.match(/<(.+?)>/);
  const address = emailMatch ? emailMatch[1] : from;
  const domain = address.split("@")[1]?.toLowerCase() ?? "";

  const parts = domain.split(".");
  const root = parts.length >= 2 ? parts[parts.length - 2] : domain;

  if (root.includes("uber") || parts.some((p) => p.includes("uber"))) {
    return from.toLowerCase().includes("uber one") ? "uber one" : "uber";
  }

  const blocked = new Set([
    "klaviyo", "mailchimp", "sendgrid", "constantcontact",
    "interactivebrokers", "hoyoverse", "gelato", "brevo",
    "hubspot", "salesforce", "marketo",
  ]);

  if (blocked.has(root)) return "unknown";

  // Apple — extract actual app name from body
  const isApple = parts.some((p) => p === "apple");
  if (isApple && text) {
    const appName = extractAppleAppName(text);
    if (appName) return appName;
    return "apple";
  }

  const knownMap = {
    openai: "openai",
    chatgpt: "openai",
    netflix: "netflix",
    spotify: "spotify",
    apple: "apple",
    google: "google",
    youtube: "google",
    microsoft: "microsoft",
    adobe: "adobe",
    dropbox: "dropbox",
    slack: "slack",
    amazon: "amazon",
    hulu: "hulu",
    disney: "disney+",
    notion: "notion",
    figma: "figma",
    github: "github",
    anthropic: "anthropic",
    linkedin: "linkedin",
    zoom: "zoom",
  };

  for (const part of parts) {
    if (knownMap[part]) return knownMap[part];
    if (blocked.has(part)) return "unknown";
  }

  return knownMap[root] ?? root;
}