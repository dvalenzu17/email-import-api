import * as cheerio from "cheerio";
import he from "he";
import { isProcessor, extractProcessorMerchant } from "./billingProcessor.js";

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
 * @param {string} subject    - Email subject (used for billing processor extraction)
 */
export function extractMerchant(fromHeader, bodyText = "", subject = "") {
  if (!fromHeader) return "unknown";

  const emailMatch = fromHeader.match(/<(.+?)>/);
  const address = emailMatch ? emailMatch[1] : fromHeader.trim();
  const domain = address.split("@")[1]?.toLowerCase() ?? "";

  const parts = domain.split(".");
  const root = parts.length >= 2 ? parts[parts.length - 2] : domain;

  // ── Billing processor passthrough ─────────────────────────────────────────
  // Stripe, Paddle, PayPal, Lemon Squeezy etc. send receipts on behalf of the
  // actual merchant. Extract the real merchant from subject/body, not the sender.
  if (isProcessor(domain)) {
    const merchant = extractProcessorMerchant(domain, subject, bodyText);
    return merchant || "unknown"; // unknown if we can't parse the real merchant
  }

  if (root.includes("uber") || parts.some((p) => p.includes("uber"))) {
    // Any Uber billing email that reaches this point has already passed the hard-negative
    // filters ("trip with uber", "thanks for riding", "your uber eats order"), so it is
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
    netflix: "netflix", netflixcommunication: "netflix",
    hulu: "hulu", disney: "disney+", disneyplus: "disney+",
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
    // Strip " - 1 Year Subscription" / " - 3 Month Plan" Apple receipt suffixes
    .replace(/\s*-\s*\d+\s*(?:year|month|yr|mo)s?.*$/i, "")
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
    !APPLE_NAME_BLOCKLIST.has(name.toLowerCase()) &&
    !/\d/.test(name) &&  // reject date/number fragments like "starting 19 march 2026"
    !/^(?:starting|renewal|your|the|this|a|an|for|with|from|on|at)\s/i.test(name)
  );
}

/**
 * Parses the app name directly from Apple IAP receipt HTML using the table
 * cell structure. Far more reliable than regex on cleaned text because it
 * targets the specific <td> labels Apple always uses.
 *
 * Apple receipt tables always have a "App" label cell whose next sibling is
 * the app name. Falls back to the "Subscription" cell (strips the plan suffix).
 */
export function extractAppleAppNameFromHtml(html) {
  if (!html) return null;
  try {
    const $ = cheerio.load(html);
    let found = null;

    const LABEL_NAMES = ["app", "app:", "subscription", "subscription:"];

    // Helper: normalize cell text — collapses all whitespace including &nbsp; (\u00a0)
    // Apple pads label cells with &nbsp;, which `.trim()` does NOT remove.
    function cellText(el) {
      return $(el).text().replace(/[\u00a0\s]+/g, " ").trim();
    }

    // Iterate every <tr>, collect its <td> texts, find "App" label
    // and grab the next non-empty value cell — skips spacer <td>s Apple uses.
    $("tr").each((_, row) => {
      if (found) return false;
      const cells = $(row).find("td");
      const texts = cells.map((_, c) => cellText(c)).get();

      for (let i = 0; i < texts.length; i++) {
        const lbl = texts[i].toLowerCase();
        if (lbl !== "app" && lbl !== "app:") continue;

        // Scan forward for the first non-empty cell (skip spacers)
        for (let j = i + 1; j < texts.length; j++) {
          const val = texts[j];
          if (val && val.length > 1 && val.length < 50) {
            found = val;
            return false;
          }
        }
      }
    });

    if (found) return found;

    // Fallback: "Subscription" row — value cell, strip plan duration + description suffix.
    // Apple subscription names often look like "App Name - Plan Description (1 year)".
    // Take only the part before " - " and strip trailing plan words.
    $("tr").each((_, row) => {
      if (found) return false;
      const cells = $(row).find("td");
      const texts = cells.map((_, c) => cellText(c)).get();

      for (let i = 0; i < texts.length; i++) {
        const lbl = texts[i].toLowerCase();
        if (lbl !== "subscription" && lbl !== "subscription:") continue;

        for (let j = i + 1; j < texts.length; j++) {
          const raw = texts[j];
          if (!raw || raw.length < 2) continue;
          const cleaned = raw
            .replace(/\s*\([^)]*\).*$/, "")          // strip "(1 month)..."
            .replace(/\s*-\s*\d+\s*(year|month|yr|mo).*$/i, "")  // "- 1 Year..."
            .replace(/\s+-\s+.+$/, "")               // strip " - Plan/Description suffix"
            .replace(/\s+(monthly|annual|yearly|premium|plus|pro|basic).*$/i, "")
            .trim();
          // Keep stricter length limit for Subscription row (app names rarely exceed 35 chars)
          if (cleaned && cleaned.length > 1 && cleaned.length < 36) {
            found = cleaned;
            return false;
          }
        }
      }
    });

    if (found) return found;

    // Last resort: raw HTML regex — catches layouts cheerio misses.
    // Looks for the "App" label cell text and grabs the adjacent value cell.
    const rawMatch = html.match(
      />\s*App\s*<\/td>(?:\s*<td[^>]*>(?:\s*(?:&nbsp;|\s)*)<\/td>)*\s*<td[^>]*>\s*([^<]{2,60}?)\s*<\//i
    );
    if (rawMatch) return rawMatch[1].trim();

    return null;
  } catch {
    return null;
  }
}

function extractAppleAppName(text) {
  // Strategy 0: Apple receipt table — "Subscription [Name] Content Provider" or
  // "Subscription [Name] Renewal Price" or "Subscription [Name] Date of Purchase".
  // This is the most direct read of the structured Apple IAP email table.
  const receiptTable = text.match(
    /\bsubscription\s+([a-z0-9][a-z0-9\s\-\+\!\:\&]{2,40}?)\s+(?:content provider|renewal price|date of purchase|\([0-9])/i
  );
  if (receiptTable) {
    const name = cleanAppleName(receiptTable[1]);
    if (isValidAppleName(name)) return name;
  }

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

  // Strategy 5: "App Name  1 Month Subscription" or "App Name - 1 Year Subscription"
  // Apple receipt table layout (no parens). Handles both "App Name 1 Month Subscription"
  // and the more common "App Name - 1 Year Subscription" (dash separator).
  const beforeDuration = text.match(
    /\b(?!subscriptions?\s|apple\s|receipt\s|from\s|your\s)([a-z0-9][a-z0-9\-\+\:\&]*(?:\s+[a-z0-9][a-z0-9\-\+\:\&]*){0,3}?)\s+(?:-\s+)?(?:\d+[\s-])?(?:month|year|mo|yr)(?:ly)?\s+(?:subscription|plan|access)/i
  );
  if (beforeDuration) {
    const name = cleanAppleName(beforeDuration[1]);
    if (isValidAppleName(name)) return name;
  }

  // Strategy 6: "subscriptions  App Name  US$X.XX / digit" — section header in Apple receipt.
  // Apple receipts have a "SUBSCRIPTIONS" label before the line item.
  const subSection = text.match(
    /subscriptions?\s+([a-z0-9][a-z0-9\s\-\+\:\&]{2,40}?)(?=\s+(?:us\$|\$[0-9]|\d))/i
  );
  if (subSection) {
    const name = cleanAppleName(subSection[1]);
    if (isValidAppleName(name)) return name;
  }

  // Strategy 7: "App Name  US$X.XX" or "App Name - US$X.XX" — bare price anchor (Apple receipt).
  // Skips same common header words as strategy 5.
  const barePrice = text.match(
    /\b(?!subscriptions?\s|apple\s|receipt\s|from\s|your\s)([a-z0-9][a-z0-9\-\+\:\&]*(?:\s+[a-z0-9][a-z0-9\-\+\:\&]*){0,3}?)\s+(?:-\s+)?us\$[0-9]+\.[0-9]{2}/i
  );
  if (barePrice) {
    const name = cleanAppleName(barePrice[1]);
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

/**
 * Extracts a renewal/next-billing date from email body text.
 * Shared by both Gmail and IMAP scan paths.
 *
 * @param {string} text — cleaned plain text
 * @returns {Date|null}
 */
// Parse a date string that may or may not have a comma: "June 15 2026" or "June 15, 2026".
function parseFlexDate(raw) {
  if (!raw) return null;
  // Normalise: ensure a comma between day and year for JS Date parsing
  const normalised = raw.trim().replace(/(\w+\s+\d{1,2})\s+(\d{4})/, "$1, $2");
  const d = new Date(normalised);
  return isNaN(d.getTime()) ? null : d;
}

export function extractRenewalDate(text) {
  // DATE_PAT: "Month D, YYYY" or "Month D YYYY" or "D Month YYYY"
  const DATE_PAT = String.raw`(\w+\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+\w+\s+\d{4})`;
  const patterns = [
    new RegExp(String.raw`starting from\s+` + DATE_PAT, "i"),
    new RegExp(String.raw`renews on\s+` + DATE_PAT, "i"),
    new RegExp(String.raw`renews\s+` + DATE_PAT, "i"),
    new RegExp(String.raw`next billing date[:\s]+(?:is\s+)?` + DATE_PAT, "i"),
    new RegExp(String.raw`renewal date[:\s]+(?:is\s+)?` + DATE_PAT, "i"),
    new RegExp(String.raw`will renew on\s+` + DATE_PAT, "i"),
    new RegExp(String.raw`automatically renews\s+(?:on\s+)?` + DATE_PAT, "i"),
    new RegExp(String.raw`subscription renews\s+(?:on\s+)?` + DATE_PAT, "i"),
    new RegExp(String.raw`your next\s+(?:billing|payment|charge)[^.]{0,30}(?:on|date)\s+(?:is\s+)?` + DATE_PAT, "i"),
    new RegExp(String.raw`next (?:renewal|billing)[^.]{0,20}(?:is|on|:)\s+` + DATE_PAT, "i"),
    // ISO date format: "2026-06-15"
    /(?:renew|next billing|renewal)[^\n]{0,40}(\d{4}-\d{2}-\d{2})/i,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const d = parseFlexDate(m[1]);
      if (d) return d;
    }
  }

  return null;
}
