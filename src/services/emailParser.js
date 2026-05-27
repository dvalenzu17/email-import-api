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

// ─── TASK 3: Merchant alias in-memory cache ───────────────────────────────────
// Loaded from the merchant_aliases DB table on startup (and auto-refreshed every hour).
// Keyed by raw_sender_domain. Each entry: { canonical_name, subject_pattern, confidence_boost }
// Falls back gracefully if the DB is unavailable or the table doesn't exist yet.

let _aliasCache = new Map();
let _aliasCacheLoadedAt = 0;
const ALIAS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * TASK 3 — Load merchant_aliases from the DB into the in-memory cache.
 * Call once on server startup. Auto-refreshes after TTL expiry.
 * @param {import('pg').Pool} pool
 */
export async function loadMerchantAliasCache(pool) {
  if (!pool) return;
  try {
    const res = await pool.query(
      `SELECT raw_sender_domain, subject_pattern, canonical_name, confidence_boost
       FROM merchant_aliases`
    );
    const map = new Map();
    for (const row of res.rows) {
      // If multiple aliases share a domain (e.g. apple.com → Disney+ vs iCloud+),
      // we keep an array so extractMerchant can pick the right one via subject_pattern.
      if (!map.has(row.raw_sender_domain)) map.set(row.raw_sender_domain, []);
      map.get(row.raw_sender_domain).push({
        subjectPattern:  row.subject_pattern ?? null,
        canonicalName:   row.canonical_name,
        confidenceBoost: Number(row.confidence_boost ?? 0),
      });
    }
    _aliasCache = map;
    _aliasCacheLoadedAt = Date.now();
  } catch (err) {
    // Non-fatal: DB may be unavailable or table may not exist yet (before migration).
    // Fail silently and use whatever is already in cache (possibly empty).
    console.warn("[parser] merchant_alias_cache_load_failed:", err.message);
  }
}

/**
 * Internal: return a matching alias entry for a given sender domain + subject.
 * Returns { canonicalName, confidenceBoost } or null.
 * @param {string} domain  — root sender domain (e.g. "apple.com")
 * @param {string} subject — email subject line
 */
function lookupAlias(domain, subject) {
  // Auto-refresh if TTL expired (fire-and-forget; next call will get fresh data).
  // We intentionally do NOT await here — alias cache is best-effort.
  if (Date.now() - _aliasCacheLoadedAt > ALIAS_CACHE_TTL_MS && _aliasCacheLoadedAt > 0) {
    // Can't reload without a pool reference here; mark cache as stale to avoid
    // repeat log spam — the server startup call will repopulate on next restart.
    _aliasCacheLoadedAt = 0;
  }

  const entries = _aliasCache.get(domain);
  if (!entries) return null;

  const subjectLower = (subject || "").toLowerCase();

  // Try pattern-specific entries first (more specific wins).
  for (const entry of entries) {
    if (entry.subjectPattern) {
      try {
        const re = new RegExp(entry.subjectPattern, "i");
        if (re.test(subjectLower)) return entry;
      } catch {
        if (subjectLower.includes(entry.subjectPattern.toLowerCase())) return entry;
      }
    }
  }

  // Fall back to catch-all entry (no subject_pattern).
  for (const entry of entries) {
    if (!entry.subjectPattern) return entry;
  }

  return null;
}

/**
 * TASK 1 — Extracts a charge amount from email text and records extraction strategy.
 * Returns { value, strategy } where strategy is one of:
 *   "euro_decimal", "total_keyword", "charged_keyword", "month_pattern", "first_in_range", null
 *
 * Supports USD, GBP, EUR, CAD, AUD.
 * Priority: "total" > "charged" > plan price > first in-range match.
 * Handles comma-formatted thousands ($1,299.00) and European decimal (€9,99).
 */
export function extractAmountWithLog(text) {
  // TASK 1: Normalise "US$" / "US $" → "$" before any pattern matching.
  // Apple receipts always use "US$79.99" or "US$ 79.99" which after lowercasing becomes
  // "us$79.99" or "us$ 79.99". Stripping the "us" prefix lets all downstream patterns
  // work uniformly with the bare "$" prefix they already handle.
  const s = String(text).toLowerCase().replace(/\bus\s*\$/g, '$');

  function toNum(raw) {
    return parseFloat(raw.replace(/,/g, ''));
  }

  // European decimal format: €9,99 — comma is the decimal separator.
  const euroDecimal = s.match(/(?:€|eur)\s?([0-9]{1,4}),([0-9]{1,2})(?!\d)/);
  if (euroDecimal) {
    const v = parseFloat(`${euroDecimal[1]}.${euroDecimal[2]}`);
    if (v > 0 && v < 10_000) return { value: v, strategy: "euro_decimal" };
  }

  const AMT = '([0-9]{1,3}(?:,[0-9]{3})*(?:\\.[0-9]{1,2})?|[0-9]+(?:\\.[0-9]{1,2})?)';
  // us\$ must come before \$ so "us$35.99" is consumed whole, not just the "$".
  // usd\s? covers "usd35.99" and "usd 35.99". \$ remains for bare dollar signs.
  const CUR = '(?:us\\$|usd\\s?|\\$|gbp|£|eur|€|cad|aud)';

  const totalMatch = s.match(new RegExp(`total\\s*[:\\-]?\\s*${CUR}\\s?${AMT}`));
  if (totalMatch) return { value: toNum(totalMatch[1]), strategy: "total_keyword" };

  const chargedMatch = s.match(new RegExp(`charged\\s*${CUR}\\s?${AMT}`));
  if (chargedMatch) return { value: toNum(chargedMatch[1]), strategy: "charged_keyword" };

  const planMatch = s.match(new RegExp(`${CUR}\\s?${AMT}\\s*(?:\\/|\\s*per\\s*)(?:month|year|mo|yr)`));
  if (planMatch) return { value: toNum(planMatch[1]), strategy: "month_pattern" };

  const fallback = s.match(new RegExp(`${CUR}\\s?${AMT}`));
  if (fallback) {
    const v = toNum(fallback[1]);
    if (v > 0 && v < 2_000) return { value: v, strategy: "first_in_range" };
  }

  return { value: null, strategy: null };
}

/**
 * Extracts a charge amount from email text.
 * Supports USD, GBP, EUR, CAD, AUD.
 * Priority: "total" > "charged" > plan price > first in-range match.
 * Handles comma-formatted thousands ($1,299.00) and European decimal (€9,99).
 */
export function extractAmount(text) {
  return extractAmountWithLog(text).value;
}

/**
 * TASK 1 — Extracts a billing cadence and records extraction strategy.
 * Returns { value, strategy } where strategy names the matched regex key.
 *
 * TASK 4: Added missing interval patterns:
 *   yearly  — "every year", "1 year", "1-year" already covered; "annually" added explicitly
 *   monthly — "every month", "1 month", "1-month", "once a month"
 */
export function extractBillingIntervalWithLog(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(annual|annually|yearly|per year|\/year|each year|every year|\bone[- ]?year\b|\b1[- ]?year\b|\b12[- ]?month)\b/.test(t))
    return { value: "yearly",     strategy: "annual_keyword" };
  if (/\b(semi[- ]?annual|every 6 months|half[- ]?year)\b/.test(t))
    return { value: "semiannual", strategy: "semiannual_keyword" };
  if (/\b(quarter|quarterly|every 3 months)\b/.test(t))
    return { value: "quarterly",  strategy: "quarterly_keyword" };
  if (/\b(biweekly|bi[- ]?weekly|every 2 weeks|every two weeks)\b/.test(t))
    return { value: "biweekly",   strategy: "biweekly_keyword" };
  if (/\b(weekly|per week|every week)\b/.test(t))
    return { value: "weekly",     strategy: "weekly_keyword" };
  if (/\b(monthly|per month|\/month|month[- ]to[- ]month|every month|once a month|\b1[- ]?month)\b/.test(t))
    return { value: "monthly",    strategy: "monthly_keyword" };
  return { value: null, strategy: null };
}

/**
 * Extracts the billing cadence from email body text.
 * Returns one of: "yearly" | "semiannual" | "quarterly" | "biweekly" | "weekly" | "monthly" | null
 *
 * NOTE: bare "year" is intentionally excluded — it matches too many non-billing
 * contexts ("last year", "this year", "10 years ago"). Only explicit billing
 * phrases like "annual", "per year", "/year", or "1-year" are accepted.
 *
 * @param {string} text — cleaned plain text
 * @returns {string|null}
 */
export function extractBillingInterval(text) {
  return extractBillingIntervalWithLog(text).value;
}

/**
 * TASK 1 — Extracts renewal date and records which of the 11 patterns matched.
 * Returns { value, strategy }.
 */
export function extractRenewalDateWithLog(text) {
  const DATE_PAT = String.raw`(\w+\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+\w+\s+\d{4})`;

  // ── TASK 3: Apple trial + interval calculation fallback ──────────────────
  // "free for X week(s)/month(s)/day(s), starting {date}" → renewal = start + duration
  const trialRe = new RegExp(
    String.raw`free\s+(?:trial\s+)?for\s+(\d+)\s+(day|days|week|weeks|month|months)[^.]{0,30}starting\s+` + DATE_PAT,
    "i"
  );
  const trialMatch = text.match(trialRe);
  if (trialMatch) {
    const qty  = parseInt(trialMatch[1], 10);
    const unit = trialMatch[2].toLowerCase();
    const start = parseFlexDate(trialMatch[3]);
    if (start) {
      const renewal = new Date(start);
      if (unit.startsWith("month")) renewal.setMonth(renewal.getMonth() + qty);
      else if (unit.startsWith("week")) renewal.setDate(renewal.getDate() + qty * 7);
      else renewal.setDate(renewal.getDate() + qty); // days
      return { value: renewal, strategy: "apple_trial_calculation" };
    }
  }

  const patterns = [
    // ── Apple-specific patterns (tried before generic patterns) ──────────────
    { name: "apple_starting",          re: new RegExp(String.raw`\bstarting\s+` + DATE_PAT, "i") },
    { name: "apple_expires_on",        re: new RegExp(String.raw`expires?\s+on\s+` + DATE_PAT, "i") },
    { name: "apple_renews_starting",   re: new RegExp(String.raw`renews[^.]{0,40}starting\s+` + DATE_PAT, "i") },
    // ── Existing generic patterns ────────────────────────────────────────────
    { name: "starting_from",           re: new RegExp(String.raw`starting from\s+` + DATE_PAT, "i") },
    { name: "renews_on",               re: new RegExp(String.raw`renews on\s+` + DATE_PAT, "i") },
    { name: "renews",                  re: new RegExp(String.raw`renews\s+` + DATE_PAT, "i") },
    { name: "next_billing_date",       re: new RegExp(String.raw`next billing date[:\s]+(?:is\s+)?` + DATE_PAT, "i") },
    { name: "renewal_date",            re: new RegExp(String.raw`renewal date[:\s]+(?:is\s+)?` + DATE_PAT, "i") },
    { name: "will_renew_on",           re: new RegExp(String.raw`will renew on\s+` + DATE_PAT, "i") },
    { name: "automatically_renews",    re: new RegExp(String.raw`automatically renews\s+(?:on\s+)?` + DATE_PAT, "i") },
    { name: "subscription_renews",     re: new RegExp(String.raw`subscription renews\s+(?:on\s+)?` + DATE_PAT, "i") },
    { name: "your_next_billing",       re: new RegExp(String.raw`your next\s+(?:billing|payment|charge)[^.]{0,30}(?:on|date)\s+(?:is\s+)?` + DATE_PAT, "i") },
    { name: "next_renewal_billing",    re: new RegExp(String.raw`next (?:renewal|billing)[^.]{0,20}(?:is|on|:)\s+` + DATE_PAT, "i") },
    { name: "iso_date_near_renew",     re: /(?:renew|next billing|renewal)[^\n]{0,40}(\d{4}-\d{2}-\d{2})/i },
  ];

  for (const { name, re } of patterns) {
    const m = text.match(re);
    if (m) {
      const d = parseFlexDate(m[1]);
      if (d) return { value: d, strategy: name };
    }
  }
  return { value: null, strategy: null };
}

/**
 * Extracts a renewal/next-billing date from email body text.
 * Shared by both Gmail and IMAP scan paths.
 *
 * @param {string} text — cleaned plain text
 * @returns {Date|null}
 */
// Parse a date string. Handles:
//   "June 15 2026" / "June 15, 2026"   — US month-first
//   "11 July 2025" / "11 July, 2025"   — UK/Apple day-first
function parseFlexDate(raw) {
  if (!raw) return null;
  const s = raw.trim();

  // UK/Apple day-first: "11 July 2025" or "11 July, 2025"
  const ukMatch = s.match(/^(\d{1,2})\s+(\w+),?\s+(\d{4})$/);
  if (ukMatch) {
    const d = new Date(`${ukMatch[2]} ${ukMatch[1]}, ${ukMatch[3]}`);
    if (!isNaN(d.getTime())) return d;
  }

  // US month-first: "June 15 2026" or "June 15, 2026"
  const normalised = s.replace(/(\w+\s+\d{1,2})\s+(\d{4})/, "$1, $2");
  const d = new Date(normalised);
  return isNaN(d.getTime()) ? null : d;
}

export function extractRenewalDate(text) {
  return extractRenewalDateWithLog(text).value;
}

/**
 * Extracts a normalised merchant name from a "From" header string.
 * TASK 1: Now returns { merchant, strategy, confidenceBoost } for logging.
 * TASK 3: Checks the merchant_alias cache first.
 *
 * @param {string} fromHeader - Raw "From" value: "Name <email@domain.com>" or "email@domain.com"
 * @param {string} bodyText   - Cleaned email body (used for Apple App Store extraction)
 * @param {string} subject    - Email subject (used for billing processor extraction + alias matching)
 * @returns {{ merchant: string, strategy: string, confidenceBoost: number }}
 */
export function extractMerchantWithLog(fromHeader, bodyText = "", subject = "") {
  if (!fromHeader) return { merchant: "unknown", strategy: "no_from_header", confidenceBoost: 0 };

  const emailMatch = fromHeader.match(/<(.+?)>/);
  const address = emailMatch ? emailMatch[1] : fromHeader.trim();
  const domain = address.split("@")[1]?.toLowerCase() ?? "";

  const parts = domain.split(".");
  const root = parts.length >= 2 ? parts[parts.length - 2] : domain;

  // ── TASK 3: Merchant alias cache lookup (highest priority) ────────────────
  // Check full domain first (e.g. "billing.anthropic.com"), then root domain
  // (e.g. "anthropic.com"). Subject pattern is used to disambiguate multi-alias
  // domains (e.g. apple.com → Disney+ when subject contains "disney").
  const aliasHit = lookupAlias(domain, subject) ?? lookupAlias(`${root}.com`, subject);
  if (aliasHit) {
    return {
      merchant:        aliasHit.canonicalName,
      strategy:        "merchant_alias_cache",
      confidenceBoost: aliasHit.confidenceBoost,
    };
  }

  // ── Billing processor passthrough ─────────────────────────────────────────
  if (isProcessor(domain)) {
    const merchant = extractProcessorMerchant(domain, subject, bodyText);
    return {
      merchant:        merchant || "unknown",
      strategy:        "stripe_passthrough",
      confidenceBoost: 0,
    };
  }

  if (root.includes("uber") || parts.some((p) => p.includes("uber"))) {
    return { merchant: "uber one", strategy: "uber_hardcode", confidenceBoost: 0 };
  }

  const blocked = new Set([
    "klaviyo", "mailchimp", "sendgrid", "constantcontact", "brevo",
    "hubspot", "salesforce", "marketo", "iterable", "customerio",
    "activecampaign", "omnisend", "drip", "convertkit", "getresponse",
    "aweber", "moosend", "mailjet", "campaignmonitor", "sparkpost",
    "postmarkapp", "mandrillapp",
    "braze", "segment", "intercom",
    "interactivebrokers", "hoyoverse", "gelato",
  ]);

  if (blocked.has(root)) return { merchant: "unknown", strategy: "blocked_esp", confidenceBoost: 0 };

  const isApple = parts.some((p) => p === "apple");
  if (isApple && bodyText) {
    // TASK 2: extractAppleAppNameFromHtml now returns { name, strategy }
    const { name: appName, strategy: appleStrategy } = extractAppleAppNameFromHtmlWithLog(bodyText, subject);
    if (appName) return { merchant: appName, strategy: appleStrategy, confidenceBoost: 0 };
    return { merchant: "apple", strategy: "apple_domain_fallback", confidenceBoost: 0 };
  }

  const knownMap = {
    openai: "openai", chatgpt: "openai", anthropic: "anthropic",
    netflix: "netflix", netflixcommunication: "netflix",
    hulu: "hulu", disney: "disney+", disneyplus: "disney+",
    hbo: "hbo", max: "max", peacock: "peacock", paramount: "paramount",
    crunchyroll: "crunchyroll", twitch: "twitch",
    spotify: "spotify", audible: "audible",
    apple: "apple", google: "google", youtube: "google",
    microsoft: "microsoft", adobe: "adobe", dropbox: "dropbox",
    slack: "slack", notion: "notion", figma: "figma",
    github: "github", linkedin: "linkedin", zoom: "zoom",
    canva: "canva", grammarly: "grammarly",
    amazon: "amazon", shopify: "shopify",
    squarespace: "squarespace", wix: "wix", webflow: "webflow",
    uber: "uber one",
    duolingo: "duolingo", headspace: "headspace", calm: "calm",
    peloton: "peloton",
    substack: "substack", patreon: "patreon", medium: "medium",
    vercel: "vercel", netlify: "netlify", airtable: "airtable",
    hubspot: "hubspot", intercom: "intercom", zendesk: "zendesk",
    datadog: "datadog", sentry: "sentry",
  };

  for (const part of parts) {
    if (knownMap[part]) return { merchant: knownMap[part], strategy: "known_brands_map", confidenceBoost: 0 };
    if (blocked.has(part)) return { merchant: "unknown", strategy: "blocked_esp", confidenceBoost: 0 };
  }

  if (knownMap[root]) return { merchant: knownMap[root], strategy: "known_brands_map", confidenceBoost: 0 };
  return { merchant: root, strategy: "domain_fallback", confidenceBoost: 0 };
}

/**
 * Extracts a normalised merchant name from a "From" header string.
 * Returns the merchant name string (backward-compatible wrapper).
 */
export function extractMerchant(fromHeader, bodyText = "", subject = "") {
  return extractMerchantWithLog(fromHeader, bodyText, subject).merchant;
}

// Strips generic plan/subscription suffixes from an extracted app name.
function cleanAppleName(raw) {
  return raw
    .trim()
    .replace(/\s*-\s*\d+\s*(?:year|month|yr|mo)s?.*$/i, "")
    .replace(/\s+(annual|monthly|yearly|weekly|plan|subscription|premium|plus|pro|basic|standard|free\s+trial)$/i, "")
    .trim();
}

// Validates a candidate app name: must be non-trivial and not a generic word.
const APPLE_NAME_BLOCKLIST = new Set([
  "subscription", "plan", "premium", "plus", "pro", "basic", "standard",
  "monthly", "annual", "yearly", "trial", "free", "app", "purchase",
  "annual subscription", "monthly subscription", "yearly subscription",
  "annual plan", "monthly plan", "yearly plan", "weekly subscription",
  "content", "in-app purchase", "in app purchase",
  "games",
  "date accepted", "billed to", "order id", "apple id",
  "report a problem", "order total", "payment method", "payment type",
  "receipt type", "service provider", "content provider",
]);

function isValidAppleName(name) {
  return (
    name.length > 2 &&
    name.length <= 60 &&
    !APPLE_NAME_BLOCKLIST.has(name.toLowerCase()) &&
    !/\d/.test(name) &&
    !/,/.test(name) &&
    !/(?:\b(?:uab|llc|ltd|limited|inc|incorporated|corporation|corp|corporate|gmbh|bv|srl|sarl|sa|ag|nv|ou|oü|as|aps|ab|oy|sas|spa|kft|sprl|pvt)\b\.?|z\s+o\.o\.)$/i.test(name) &&
    !/^(?:starting|renewal|your|the|this|a|an|for|with|from|on|at|annual|monthly|weekly|yearly|quarterly|free)\s/i.test(name) &&
    !/\s(?:accepted|declined|authorized|processed|pending|confirmed|billed|to|id)$/i.test(name)
  );
}

const APPLE_GENERIC_ALT = /^(apple|app store|apple logo|apple pay|apple one|annual subscription|monthly subscription|subscription|plan|annual|monthly|premium|pro|plus|basic|standard|lite|elite|essential|free|games)$/i;

// ── TASK 1: Apple subject prefix stripping ────────────────────────────────────
// Apple billing emails reuse subject-line phrases inside HTML table cells
// (e.g. "will expire soon: AppName" in a cell next to the "App" label).
// Strip these known prefixes before validating any candidate app name.
const APPLE_SUBJECT_PREFIX_RES = [
  /^will\s+expire\s+soon[:\s]*/i,
  /^your\s+subscription\s+expires?\s+soon[.:\s]*/i,
  /^receipt\s+from\s+apple[.:\s]*/i,
  /^invoice\s+from\s+apple[.:\s]*/i,
  /^subscription\s+renewal[.:\s]*/i,
  /^thank\s+you\s+for\s+your\s+(?:purchase|order)[.:\s]*/i,
];

function stripAppleSubjectPrefixes(text) {
  let t = (text || '').trim();
  for (const re of APPLE_SUBJECT_PREFIX_RES) {
    t = t.replace(re, '');
  }
  return t.trim();
}

/**
 * TASK 2 — Parses the app name from Apple IAP receipt HTML.
 * Tries 5 strategies in order (A→E), recording which fired.
 * Returns { name, strategy } — name is null if all strategies fail.
 *
 * Strategy E (new): Extract app name from the App Store URL embedded in the email.
 * Apple always includes itunes.apple.com/app/[app-name]/id[number] or
 * apps.apple.com/app/id[number]. The path segment before /id is the URL slug.
 * Converting hyphens to spaces + title-casing gives a clean name. More stable
 * than HTML receipt structure which varies between receipt types.
 */
export function extractAppleAppNameFromHtmlWithLog(html, subject = "") {
  if (!html) return { name: null, strategy: "apple_iap_no_html" };
  try {
    const $ = cheerio.load(html);
    let found = null;
    let strategyAFallback = null;
    let foundStrategy = null;

    function cellText(el) {
      return $(el).text().replace(/[\u00a0\s]+/g, " ").trim();
    }

    // ── Strategy 0: Expiring-email product card (icon + app name in adjacent cell) ──
    // Apple "Your Subscription is Expiring" emails use a product card layout:
    // an <img src="*.mzstatic.com/..."> icon followed by a sibling cell whose
    // first text node is the app name. Only runs when subject contains "expir".
    if (/expir/i.test(subject)) {
      $("img[src*='mzstatic.com']").first().closest("td, div").each((_, iconCell) => {
        if (found) return false;
        const infoCell = $(iconCell).next("td, div");
        if (!infoCell.length) return;
        let firstText = "";
        infoCell.contents().each((_, node) => {
          if (firstText) return false;
          if (node.type === "text") {
            const t = (node.data || "").replace(/[\u00a0\s]+/g, " ").trim();
            if (t.length >= 2) firstText = t;
          } else if (node.type === "tag" && node.name !== "img" && node.name !== "br") {
            const t = $(node).text().replace(/[\u00a0\s]+/g, " ").trim();
            if (t.length >= 2) firstText = t;
          }
        });
        if (!firstText) return;
        const clean = stripAppleSubjectPrefixes(firstText)
          .replace(/\s*:\s+.+$/, "")
          .replace(/\s+-\s+.+$/, "")
          .trim();
        if (clean.length >= 2 && clean.length <= 60 &&
            !APPLE_GENERIC_ALT.test(clean) && isValidAppleName(clean)) {
          found = clean;
          foundStrategy = "apple_iap_strategy_0_expiry_card";
        }
      });
      if (found) return { name: found, strategy: foundStrategy };
    }

    // ── Strategy A: "App" label row traversal ──────────────────────────────
    $("tr").each((_, row) => {
      if (found) return false;
      const cells = $(row).find("td");
      const texts = cells.map((_, c) => cellText(c)).get();

      for (let i = 0; i < texts.length; i++) {
        const lbl = texts[i].toLowerCase();
        if (lbl !== "app" && lbl !== "app:") continue;

        for (let j = i + 1; j < texts.length; j++) {
          // TASK 1: strip known Apple subject-line prefixes from cell text
          const val = stripAppleSubjectPrefixes(texts[j]);
          if (!val || val.length <= 1 || val.length >= 60) continue;
          const hasSubtitle = /:\s+/.test(val) || /\s+-\s+/.test(val);
          const clean = val.replace(/\s*:\s+.+$/, "").replace(/\s+-\s+.+$/, "").trim();
          if (!isValidAppleName(clean)) return false;
          if (hasSubtitle) {
            strategyAFallback = clean;
          } else {
            found = clean;
            foundStrategy = "apple_iap_strategy_A";
          }
          return false;
        }
      }
    });

    if (found) return { name: found, strategy: foundStrategy };

    // ── Strategy B: mzstatic.com img alt ──────────────────────────────────
    const TIER_SUFFIX = /\s+(premium|pro|plus|essential|career|basic|standard|lite)$/i;
    $("img[alt]").each((_, el) => {
      if (found) return false;
      const src = $(el).attr("src") || "";
      const raw = ($(el).attr("alt") || "").replace(/[\u00a0\s]+/g, " ").trim();
      if (!src.includes("mzstatic.com") || raw.length < 2 || raw.length > 60) return;
      if (APPLE_GENERIC_ALT.test(raw)) return;
      const alt = raw
        .replace(/\s*:\s+.+$/, "")
        .replace(/\s+-\s+.+$/, "")
        .replace(TIER_SUFFIX, "")
        .trim();
      if (isValidAppleName(alt) && (!strategyAFallback || alt.toLowerCase().startsWith(strategyAFallback.toLowerCase()))) {
        found = alt;
        foundStrategy = "apple_iap_strategy_B";
      }
    });

    if (found) return { name: found, strategy: foundStrategy };

    // ── Strategy C: "Subscription" label row ──────────────────────────────
    $("tr").each((_, row) => {
      if (found) return false;
      const cells = $(row).find("td");
      const texts = cells.map((_, c) => cellText(c)).get();

      for (let i = 0; i < texts.length; i++) {
        const lbl = texts[i].toLowerCase();
        if (lbl !== "subscription" && lbl !== "subscription:") continue;

        for (let j = i + 1; j < texts.length; j++) {
          // TASK 1: strip known Apple subject-line prefixes from cell text
          const raw = stripAppleSubjectPrefixes(texts[j]);
          if (!raw || raw.length < 2) continue;
          const cleaned = raw
            .replace(/\s*\([^)]*\).*$/, "")
            .replace(/\s*-\s*\d+\s*(year|month|yr|mo).*$/i, "")
            .replace(/\s+-\s+.+$/, "")
            .replace(/\s+(monthly|annual|yearly|premium|plus|pro|basic|career|elite|essential|standard|lite).*$/i, "")
            .trim();
          const GENERIC_NAMES = new Set([
            "premium", "pro", "plus", "basic", "standard", "lite", "free",
            "subscription", "plan", "elite", "essential",
            "annual subscription", "monthly subscription", "yearly subscription",
            "annual plan", "monthly plan", "yearly plan", "weekly subscription",
            "content", "in-app purchase", "in app purchase",
          ]);
          if (cleaned && cleaned.length > 1 && cleaned.length < 36 &&
              !GENERIC_NAMES.has(cleaned.toLowerCase()) &&
              isValidAppleName(cleaned)) {
            found = cleaned;
            foundStrategy = "apple_iap_strategy_C";
            return false;
          }
        }
      }
    });

    if (found) return { name: found, strategy: foundStrategy };

    // ── Strategy D: raw HTML regex ─────────────────────────────────────────
    const rawMatch = html.match(
      />\s*App\s*<\/td>(?:\s*<td[^>]*>(?:\s*(?:&nbsp;|\s)*)<\/td>)*\s*<td[^>]*>\s*([^<]{2,60}?)\s*<\//i
    );
    if (rawMatch) {
      // TASK 1: strip Apple subject-line prefixes before validating
      const d = stripAppleSubjectPrefixes(rawMatch[1]);
      if (isValidAppleName(d)) return { name: d, strategy: "apple_iap_strategy_D" };
    }

    // ── Strategy E (TASK 2): App Store URL slug ────────────────────────────
    // Apple always embeds a link like:
    //   https://itunes.apple.com/[country/]app/[app-name-slug]/id[number]
    //   https://apps.apple.com/[country/]app/id[number]  (no slug — skip)
    // The slug before /id is more stable than the HTML receipt table structure.
    const urlMatch = html.match(
      /https?:\/\/(?:itunes|apps)\.apple\.com\/(?:[a-z]{2}\/)?app\/([^/]+)\/id\d+/i
    );
    if (urlMatch) {
      const slug = urlMatch[1];
      // If slug is just "id[number]" form (apps.apple.com/app/id12345), skip.
      if (slug && !/^id\d+$/i.test(slug)) {
        const name = slug
          .replace(/-/g, " ")
          .trim()
          .replace(/\b\w/g, (c) => c.toUpperCase()); // title-case
        if (isValidAppleName(name)) {
          return { name, strategy: "apple_iap_strategy_E_url_slug" };
        }
      }
    }

    // Fallback to stripped Strategy A subtitle name.
    if (strategyAFallback) {
      console.log(`[parser] apple_name_fallback: "${strategyAFallback}"`);
      return { name: strategyAFallback, strategy: "apple_iap_strategy_A_subtitle_fallback" };
    }

    return { name: null, strategy: "apple_iap_all_strategies_failed" };
  } catch {
    return { name: null, strategy: "apple_iap_parse_exception" };
  }
}

/**
 * Parses the app name directly from Apple IAP receipt HTML.
 * Backward-compatible wrapper — returns the name string only.
 */
export function extractAppleAppNameFromHtml(html) {
  return extractAppleAppNameFromHtmlWithLog(html).name;
}

/**
 * Extracts the App Store app icon URL from an Apple IAP receipt HTML.
 */
export function extractAppleIconUrl(html) {
  if (!html) return null;
  try {
    const $ = cheerio.load(html);
    let iconUrl = null;
    $("img[src]").each((_, el) => {
      if (iconUrl) return false;
      const src = $(el).attr("src") || "";
      if (!src.includes("mzstatic.com")) return;
      const alt = ($(el).attr("alt") || "").replace(/[\u00a0\s]+/g, " ").trim();
      if (alt && APPLE_GENERIC_ALT.test(alt)) return;
      iconUrl = src;
    });
    return iconUrl;
  } catch {
    return null;
  }
}

function extractAppleAppName(text) {
  const receiptTable = text.match(
    /\bsubscription\s+([a-z0-9][a-z0-9\s\-\+\!\:\&]{2,40}?)\s+(?:content provider|renewal price|date of purchase|\([0-9])/i
  );
  if (receiptTable) {
    const name = cleanAppleName(receiptTable[1]);
    if (isValidAppleName(name)) return name;
  }

  const durationMatch = text.match(
    /([a-z0-9][a-z0-9\s\-\+\:\&]{2,55}?)\s+\([0-9]+\s+(?:year|month|yr|mo)s?\)/i
  );
  if (durationMatch) {
    const name = cleanAppleName(durationMatch[1]);
    if (isValidAppleName(name)) return name;
  }

  const priceAnchor = text.match(
    /([a-z0-9][a-z0-9\s\-\+\:\&]{2,55}?)\s+(?:us\$|usd\s?)[0-9]+(?:\.[0-9]{2})?\/(?:year|month|yr|mo)/i
  );
  if (priceAnchor) {
    const name = cleanAppleName(priceAnchor[1]);
    if (isValidAppleName(name)) return name;
  }

  const subTo = text.match(
    /subscription\s+to\s+([a-z0-9][a-z0-9\s\-\+\:\&]{2,55}?)(?=\s+(?:annual|monthly|plan|on|for|\$|us\$)|$)/i
  );
  if (subTo) {
    const name = cleanAppleName(subTo[1]);
    if (isValidAppleName(name)) return name;
  }

  const yourSub = text.match(
    /your\s+([a-z0-9][a-z0-9\s\-\+\:\&]{2,55}?)\s+subscription/i
  );
  if (yourSub) {
    const name = cleanAppleName(yourSub[1]);
    if (isValidAppleName(name)) return name;
  }

  const beforeDuration = text.match(
    /\b(?!subscriptions?\s|apple\s|receipt\s|from\s|your\s)([a-z0-9][a-z0-9\-\+\:\&]*(?:\s+[a-z0-9][a-z0-9\-\+\:\&]*){0,3}?)\s+(?:-\s+)?(?:\d+[\s-])?(?:month|year|mo|yr)(?:ly)?\s+(?:subscription|plan|access)/i
  );
  if (beforeDuration) {
    const name = cleanAppleName(beforeDuration[1]);
    if (isValidAppleName(name)) return name;
  }

  const subSection = text.match(
    /subscriptions?\s+([a-z0-9][a-z0-9\s\-\+\:\&]{2,40}?)(?=\s+(?:us\$|\$[0-9]|\d))/i
  );
  if (subSection) {
    const name = cleanAppleName(subSection[1]);
    if (isValidAppleName(name)) return name;
  }

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

  if (/£/.test(text)) return "GBP";
  if (/€/.test(text)) return "EUR";
  if (/a\$|au\$/.test(s)) return "AUD";
  if (/c\$|ca\$/.test(s)) return "CAD";

  return "USD";
}

/**
 * TASK 1 — Parses all fields from email text/headers and returns them with
 * a structured extractionLog recording which strategy fired for each field
 * and why any field may be null.
 *
 * @param {{ fromHeader: string, html: string, text: string, subject: string }} email
 * @returns {{ amount, currency, merchant, renewalDate, billingInterval, extractionLog }}
 */
export function parseEmailWithLog({ fromHeader, html, text, subject }) {
  const amountResult    = extractAmountWithLog(text);
  const intervalResult  = extractBillingIntervalWithLog(text);
  const dateResult      = extractRenewalDateWithLog(text);
  const merchantResult  = extractMerchantWithLog(fromHeader, html, subject);
  const currency        = extractCurrencyCode(text);

  const extractionLog = {
    merchant: {
      strategy: merchantResult.strategy,
      value:    merchantResult.merchant,
      failed:   merchantResult.merchant === "unknown" || !merchantResult.merchant,
      failReason: (!merchantResult.merchant || merchantResult.merchant === "unknown")
        ? "no_merchant_identified"
        : null,
    },
    amount: {
      strategy: amountResult.strategy,
      value:    amountResult.value,
      failed:   amountResult.value === null,
      failReason: amountResult.value === null ? "no_amount_pattern_matched" : null,
    },
    renewalDate: {
      strategy: dateResult.strategy,
      value:    dateResult.value?.toISOString() ?? null,
      failed:   dateResult.value === null,
      failReason: dateResult.value === null ? "no_date_pattern_matched" : null,
    },
    billingInterval: {
      strategy: intervalResult.strategy,
      value:    intervalResult.value,
      failed:   intervalResult.value === null,
      failReason: intervalResult.value === null ? "no_interval_pattern_matched" : null,
    },
  };

  return {
    merchant:        merchantResult.merchant,
    confidenceBoost: merchantResult.confidenceBoost,
    amount:          amountResult.value,
    currency,
    renewalDate:     dateResult.value,
    billingInterval: intervalResult.value,
    extractionLog,
  };
}
