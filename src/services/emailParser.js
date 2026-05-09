import * as cheerio from "cheerio";
import he from "he";

/**
 * Strips HTML from an email body and returns clean, lowercased plain text.
 * Uses cheerio for accurate DOM-based extraction.
 */
export function cleanEmailHtml(html) {
  if (!html) return "";

  const $ = cheerio.load(html);
  $("style, script, head, meta, link").remove();

  let text = $("body").text();
  text = he.decode(text);
  text = text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return text;
}

/**
 * Extracts a charge amount from email text.
 * Supports USD, GBP, EUR, CAD, AUD.
 * Priority: "total" > "charged" > plan price > first in-range match.
 * Handles comma-formatted thousands ($1,299.00) and European decimal (€9,99).
 */
export function extractAmount(text) {
  const s = String(text).toLowerCase();

  // Normalised number parser — strips thousands commas before converting.
  function toNum(raw) {
    return parseFloat(raw.replace(/,/g, ''));
  }

  // European decimal format: €9,99 — comma is the decimal separator.
  const euroDecimal = s.match(/(?:€|eur)\s?([0-9]{1,4}),([0-9]{1,2})(?!\d)/);
  if (euroDecimal) {
    const v = parseFloat(`${euroDecimal[1]}.${euroDecimal[2]}`);
    if (v > 0 && v < 10_000) return v;
  }

  // Amount pattern: currency symbol/code + number (with optional comma thousands).
  const AMT = '([0-9]{1,3}(?:,[0-9]{3})*(?:\\.[0-9]{1,2})?|[0-9]+(?:\\.[0-9]{1,2})?)';
  const CUR = '(?:usd|us\\$|\\$|gbp|£|eur|€|cad|aud)';

  const totalMatch = s.match(new RegExp(`total\\s*[:\\-]?\\s*${CUR}\\s?${AMT}`));
  if (totalMatch) return toNum(totalMatch[1]);

  const chargedMatch = s.match(new RegExp(`charged\\s*${CUR}\\s?${AMT}`));
  if (chargedMatch) return toNum(chargedMatch[1]);

  const planMatch = s.match(new RegExp(`${CUR}\\s?${AMT}\\s*(?:\\/|\\s*per\\s*)(?:month|year|mo|yr)`));
  if (planMatch) return toNum(planMatch[1]);

  const fallback = s.match(new RegExp(`${CUR}\\s?${AMT}`));
  if (fallback) {
    const v = toNum(fallback[1]);
    if (v > 0 && v < 2_000) return v; // raised cap: enterprise plans can exceed $500
  }

  return null;
}

/**
 * Extracts a normalised merchant name from a "From" header string.
 *
 * @param {string} fromHeader - Raw "From" value: "Name <email@domain.com>" or "email@domain.com"
 * @param {string} bodyText   - Cleaned email body (used for Apple App Store extraction)
 */
export function extractMerchant(fromHeader, bodyText = "") {
  if (!fromHeader) return "unknown";

  const emailMatch = fromHeader.match(/<(.+?)>/);
  const address = emailMatch ? emailMatch[1] : fromHeader.trim();
  const domain = address.split("@")[1]?.toLowerCase() ?? "";

  const parts = domain.split(".");
  const root = parts.length >= 2 ? parts[parts.length - 2] : domain;

  if (root.includes("uber") || parts.some((p) => p.includes("uber"))) {
    // Any Uber billing email that reaches this point has already passed the hard-negative
    // filters ("trip with uber", "thanks for riding", "order with uber eats"), so it is
    // a membership/subscription email. Always map to "uber one".
    return "uber one";
  }

  // Email service providers and marketing platforms whose From domain is
  // never the actual billing merchant. All are definitively non-billing senders.
  const blocked = new Set([
    // Marketing automation & ESP platforms
    "klaviyo", "mailchimp", "sendgrid", "constantcontact", "brevo",
    "hubspot", "salesforce", "marketo", "iterable", "customerio",
    "activecampaign", "omnisend", "drip", "convertkit", "getresponse",
    "aweber", "moosend", "mailjet", "campaignmonitor", "sparkpost",
    "postmarkapp", "mandrillapp",
    // Marketing infra / CDPs
    "braze", "segment", "intercom",
    // Non-billing product domains
    "interactivebrokers", "hoyoverse", "gelato",
  ]);

  if (blocked.has(root)) return "unknown";

  const isApple = parts.some((p) => p === "apple");
  if (isApple && bodyText) {
    const appName = extractAppleAppName(bodyText);
    if (appName) return appName;
    return "apple";
  }

  const knownMap = {
    // AI / Dev
    openai: "openai", chatgpt: "openai", anthropic: "anthropic",
    // Streaming
    netflix: "netflix", hulu: "hulu", disney: "disney+",
    hbo: "hbo", max: "max", peacock: "peacock", paramount: "paramount",
    crunchyroll: "crunchyroll", twitch: "twitch",
    // Music / Audio
    spotify: "spotify", audible: "audible",
    // Cloud / Productivity
    apple: "apple", google: "google", youtube: "google",
    microsoft: "microsoft", adobe: "adobe", dropbox: "dropbox",
    slack: "slack", notion: "notion", figma: "figma",
    github: "github", linkedin: "linkedin", zoom: "zoom",
    canva: "canva", grammarly: "grammarly",
    // Commerce / Hosting
    amazon: "amazon", shopify: "shopify",
    squarespace: "squarespace", wix: "wix", webflow: "webflow",
    uber: "uber one",
    // Wellness / Learning
    duolingo: "duolingo", headspace: "headspace", calm: "calm",
    peloton: "peloton",
    // Creator
    substack: "substack", patreon: "patreon", medium: "medium",
    // Dev infra
    vercel: "vercel", netlify: "netlify", airtable: "airtable",
    hubspot: "hubspot", intercom: "intercom", zendesk: "zendesk",
    datadog: "datadog", sentry: "sentry",
  };

  for (const part of parts) {
    if (knownMap[part]) return knownMap[part];
    if (blocked.has(part)) return "unknown";
  }

  return knownMap[root] ?? root;
}

// Strips generic plan/subscription suffixes from an extracted app name.
function cleanAppleName(raw) {
  return raw
    .trim()
    .replace(/\s+(annual|monthly|yearly|weekly|plan|subscription|premium|plus|pro|basic|standard|free\s+trial)$/i, "")
    .trim();
}

// Validates a candidate app name: must be non-trivial and not a generic word.
const APPLE_NAME_BLOCKLIST = new Set([
  "subscription", "plan", "premium", "plus", "pro", "basic", "standard",
  "monthly", "annual", "yearly", "trial", "free", "app", "purchase",
]);

function isValidAppleName(name) {
  return (
    name.length > 2 &&
    name.length <= 60 &&
    !APPLE_NAME_BLOCKLIST.has(name.toLowerCase())
  );
}

function extractAppleAppName(text) {
  // Strategy 1: "App Name (1 year)" or "App Name Premium (1 month)" — most reliable
  const durationMatch = text.match(
    /([a-z0-9][a-z0-9\s\-\+\:\&]{2,55}?)\s+\([0-9]+\s+(?:year|month|yr|mo)s?\)/i
  );
  if (durationMatch) {
    const name = cleanAppleName(durationMatch[1]);
    if (isValidAppleName(name)) return name;
  }

  // Strategy 2: price anchor "App Name US$X.XX/year"
  const priceAnchor = text.match(
    /([a-z0-9][a-z0-9\s\-\+\:\&]{2,55}?)\s+(?:us\$|usd\s?)[0-9]+(?:\.[0-9]{2})?\/(?:year|month|yr|mo)/i
  );
  if (priceAnchor) {
    const name = cleanAppleName(priceAnchor[1]);
    if (isValidAppleName(name)) return name;
  }

  // Strategy 3: "subscription to App Name" phrasing
  const subTo = text.match(
    /subscription\s+to\s+([a-z0-9][a-z0-9\s\-\+\:\&]{2,55}?)(?=\s+(?:annual|monthly|plan|on|for|\$|us\$)|$)/i
  );
  if (subTo) {
    const name = cleanAppleName(subTo[1]);
    if (isValidAppleName(name)) return name;
  }

  // Strategy 4: "Your [App Name] subscription" phrasing
  const yourSub = text.match(
    /your\s+([a-z0-9][a-z0-9\s\-\+\:\&]{2,55}?)\s+subscription/i
  );
  if (yourSub) {
    const name = cleanAppleName(yourSub[1]);
    if (isValidAppleName(name)) return name;
  }

  return null;
}

/**
 * Detects the currency code from email text based on symbols or ISO codes.
 * Returns the 3-letter ISO 4217 code, defaulting to "USD" if none is found.
 *
 * @param {string} text — cleaned plain text
 * @returns {string} — e.g. "USD", "GBP", "EUR", "CAD", "AUD"
 */
export function extractCurrencyCode(text) {
  if (!text) return "USD";
  const s = text.toLowerCase();

  // Check ISO code mentions first (more specific than symbols).
  if (/\bgbp\b/.test(s)) return "GBP";
  if (/\beur\b/.test(s)) return "EUR";
  if (/\bcad\b/.test(s)) return "CAD";
  if (/\baud\b/.test(s)) return "AUD";
  if (/\bnzd\b/.test(s)) return "NZD";
  if (/\bchf\b/.test(s)) return "CHF";
  if (/\bjpy\b/.test(s)) return "JPY";
  if (/\bbrl\b/.test(s)) return "BRL";
  if (/\bmxn\b/.test(s)) return "MXN";
  if (/\bsek\b/.test(s)) return "SEK";

  // Symbol-based fallback.
  if (/£/.test(text)) return "GBP";
  if (/€/.test(text)) return "EUR";
  if (/a\$|au\$/.test(s)) return "AUD";
  if (/c\$|ca\$/.test(s)) return "CAD";

  return "USD";
}
