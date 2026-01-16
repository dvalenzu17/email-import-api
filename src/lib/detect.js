// src/lib/detect.js
import crypto from "node:crypto";
import { htmlToText } from "html-to-text";
import * as chrono from "chrono-node";
import { resolveMerchantFromSender } from "./merchantResolver.js";

const MERCHANT_HINTS = [
  { name: "Netflix", domains: ["netflix.com"], keywords: ["netflix"] },
  { name: "Uber One", domains: ["uber.com"], keywords: ["uber one", "uberone", "uber"] },
  { name: "Spotify", domains: ["spotify.com"], keywords: ["spotify"] },
  { name: "Apple", domains: ["apple.com", "icloud.com"], keywords: ["apple", "icloud"] },
  { name: "Google", domains: ["google.com"], keywords: ["google", "youtube"] },
  { name: "Amazon", domains: ["amazon.com"], keywords: ["amazon", "prime"] },
  { name: "Microsoft", domains: ["microsoft.com"], keywords: ["microsoft", "xbox", "office 365"] },
  { name: "Adobe", domains: ["adobe.com"], keywords: ["adobe", "creative cloud"] },
  { name: "Dropbox", domains: ["dropbox.com"], keywords: ["dropbox"] },
  { name: "Disney+", domains: ["disneyplus.com", "disney.com"], keywords: ["disney+"] },
  { name: "LinkedIn", domains: ["linkedin.com"], keywords: ["linkedin"] },
];

const SUBJECT_KEYWORDS = [
  "receipt",
  "invoice",
  "payment",
  "charged",
  "subscription",
  "renewal",
  "trial",
  "membership",
  "plan",
  "billing",
  "confirmation",
  "expires",
  "expiring",
];

const BODY_KEYWORDS = [
  "renews",
  "renewal date",
  "next billing date",
  "billed",
  "trial ends",
  "payment was successful",
  "valid until",
  "renewal price",
  "subscription confirmed",
  "subscription expiring",
  "your subscription",
];

const WELCOME_KEYWORDS = ["welcome", "thanks for joining", "start watching", "your account information"];

export function buildCandidate({ from, subject, date, text, html, directory, overrides, knownSubs }) {
  const plainOriginal = normalizeText(text ?? "") || normalizeText(htmlToTextSafe(html ?? ""));
  const haystackOriginal = `${subject}\n${from}\n${plainOriginal}`.trim();
  const haystack = haystackOriginal.toLowerCase();

  // Sender resolution (directory + user overrides)
  const senderHit = resolveMerchantFromSender({ from, directory, overrides });

  // Apple subscription / receipt parsing (merchant extraction)
  const apple = parseAppleSubscription({ from, subject, text: haystackOriginal, messageDate: date });

  // fallback merchant guessing
  const guessed = guessMerchant({ from, subject, text: plainOriginal });

  // Canonical merchant selection order
  const merchant =
    senderHit.canonicalName ??
    apple?.merchant ??
    guessed ??
    "Unknown merchant";

  const subjectLower = String(subject || "").toLowerCase();
  const subjectSignal = SUBJECT_KEYWORDS.some((k) => subjectLower.includes(k));
  const bodySignal = BODY_KEYWORDS.some((k) => haystack.includes(k));

  const isWelcomeLike =
    merchant !== "Unknown merchant" &&
    WELCOME_KEYWORDS.some((k) => haystack.includes(k));

  const hasSignal = subjectSignal || bodySignal || isWelcomeLike;
  if (!hasSignal) return null;

  const amountInfo = apple?.amountInfo ?? extractAmount(haystackOriginal);
  const cadence = apple?.cadence ?? guessCadence(haystack);
  const nextDate = apple?.nextDate ?? guessNextDate({ haystack: haystackOriginal, messageDate: date });

  // --- Confidence signals (deterministic) ---
  const keywordMatch = !!guessed && guessed !== "Unknown merchant";
  const pastAmountMatch = matchesPastAmount({ knownSubs, merchant, amount: amountInfo?.amount });
  const cadenceMatch = matchesPastCadence({ knownSubs, merchant, cadence });

  const conflict =
    !!senderHit.canonicalName &&
    !!guessed &&
    senderHit.canonicalName.toLowerCase() !== guessed.toLowerCase() &&
    guessed !== "Unknown merchant";

  const confidence = computeConfidence({
    senderMatchType: senderHit.matchType,
    keywordMatch,
    pastAmountMatch: !!pastAmountMatch,
    cadenceMatch: !!cadenceMatch,
    conflict: !!conflict,

    // new real signals so unknown merchants can pass
    subjectSignal: !!subjectSignal,
    bodySignal: !!bodySignal,
    hasAmount: !!(amountInfo && Number.isFinite(Number(amountInfo.amount))),
    hasCadence: !!cadence,
    hasNextDate: !!nextDate,
    isAppleExtracted: !!apple?.merchant && apple?.merchant !== "Apple",
  });

  const confidenceLabel = labelConfidence(confidence);

  // Floors: welcome emails can be lower, unknown merchants can be medium if signals are strong
  const isUnknown = String(merchant).toLowerCase() === "unknown merchant";
  const floor = isWelcomeLike ? 30 : (isUnknown ? 35 : 40);
  if (confidence < floor) return null;

  const fingerprint = makeFingerprint({ from, subject, amount: amountInfo?.amount, merchant, date });

  return {
    fingerprint,
    merchant,
    amount: amountInfo?.amount,
    currency: amountInfo?.currency,
    cadenceGuess: cadence,
    nextDateGuess: nextDate,
    confidence,
    confidenceLabel,
    confidenceSignals: {
      senderMatchType: senderHit.matchType,
      keywordMatch,
      pastAmountMatch: !!pastAmountMatch,
      cadenceMatch: !!cadenceMatch,
      conflict: !!conflict,
      subjectSignal: !!subjectSignal,
      bodySignal: !!bodySignal,
      hasAmount: !!(amountInfo && Number.isFinite(Number(amountInfo.amount))),
      hasCadence: !!cadence,
      hasNextDate: !!nextDate,
      isAppleExtracted: !!apple?.merchant && apple?.merchant !== "Apple",
    },
    evidence: {
      from: compact(from),
      subject: compact(subject),
      date: date.toISOString(),
    },
  };
}

// ---------------- Confidence model ----------------

function computeConfidence({
  senderMatchType,
  keywordMatch,
  pastAmountMatch,
  cadenceMatch,
  conflict,
  subjectSignal,
  bodySignal,
  hasAmount,
  hasCadence,
  hasNextDate,
  isAppleExtracted,
}) {
  let score = 0;

  // Sender directory / overrides
  if (senderMatchType === "override_email" || senderMatchType === "directory_email") score += 40;
  if (senderMatchType === "override_domain" || senderMatchType === "directory_domain") score += 25;

  // Merchant hints / keyword guess
  if (keywordMatch) score += 20;

  // Real "this looks like a subscription" evidence
  if (subjectSignal) score += 10;
  if (bodySignal) score += 10;
  if (hasAmount) score += 15;
  if (hasNextDate) score += 15;
  if (hasCadence) score += 10;

  // Apple subscription emails: extracting the real app is strong signal
  if (isAppleExtracted) score += 15;

  // Behavioral confidence (optional)
  if (pastAmountMatch) score += 10;
  if (cadenceMatch) score += 10;

  if (conflict) score -= 30;

  return clamp(score, 0, 100);
}

function labelConfidence(score) {
  if (score >= 80) return "High";
  if (score >= 50) return "Medium";
  return "Low";
}

function matchesPastAmount({ knownSubs, merchant, amount }) {
  if (!amount || !Number.isFinite(Number(amount))) return false;
  const a = Number(amount);
  const m = String(merchant || "").trim().toLowerCase();
  if (!m || m === "unknown merchant") return false;

  for (const row of knownSubs || []) {
    const rm = String(row.merchant || "").trim().toLowerCase();
    if (!rm) continue;
    if (rm !== m) continue;

    const ra = Number(row.amount ?? 0);
    if (!Number.isFinite(ra)) continue;

    if (Math.abs(ra - a) <= 0.05) return true;
    const denom = Math.max(ra, a, 1);
    if (Math.abs(ra - a) / denom <= 0.02) return true;
  }

  return false;
}

function matchesPastCadence({ knownSubs, merchant, cadence }) {
  const c = String(cadence || "").trim().toLowerCase();
  const m = String(merchant || "").trim().toLowerCase();
  if (!c || !m || m === "unknown merchant") return false;

  for (const row of knownSubs || []) {
    const rm = String(row.merchant || "").trim().toLowerCase();
    const rc = String(row.cadence || "").trim().toLowerCase();
    if (rm === m && rc && rc === c) return true;
  }

  return false;
}

// ---------------- Apple parsing ----------------

function parseAppleSubscription({ from, subject, text, messageDate }) {
  const fromLower = String(from || "").toLowerCase();
  const subjLower = String(subject || "").toLowerCase();

  const looksAppleSender = fromLower.includes("email.apple.com") || fromLower.includes("apple.com");
  const looksAppleSub = subjLower.includes("subscription") || String(text || "").toLowerCase().includes("subscription");

  if (!looksAppleSender || !looksAppleSub) return null;

  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let appName = null;

  for (const l of lines) {
    const m = l.match(/^App\s*[:\-]\s*(.+)$/i);
    if (m?.[1]) {
      appName = m[1].trim();
      break;
    }
  }

  if (!appName) {
    for (const l of lines.slice(0, 50)) {
      if (/subscription confirmed|subscription expiring|dear\s/i.test(l)) continue;
      if (l.length < 3 || l.length > 80) continue;
      if (/^apple$/i.test(l)) continue;
      if (/^[a-z0-9][a-z0-9 &:+\-'.()]{2,}$/i.test(l)) {
        appName = l.trim();
        break;
      }
    }
  }

  const merchant = canonicalizeAppleAppName(appName);
  if (!merchant) return null;

  const amt = extractAmount(String(text || ""));
  const cadence = guessCadence(String(text || "").toLowerCase()) || (String(text || "").includes("/month") ? "monthly" : undefined);
  const nextDate = guessNextDate({ haystack: String(text || ""), messageDate });

  return { merchant, amountInfo: amt, cadence, nextDate };
}

function canonicalizeAppleAppName(appName) {
  const raw = String(appName || "").trim();
  if (!raw) return null;
  const cut = raw.split(":")[0].trim();
  if (cut && cut.length <= 40) return cut;
  return raw;
}

// ---------------- Helpers ----------------

function htmlToTextSafe(html) {
  if (!html) return "";
  try {
    return htmlToText(html, {
      wordwrap: 120,
      selectors: [{ selector: "a", options: { ignoreHref: true } }],
    });
  } catch {
    return "";
  }
}

function normalizeText(s) {
  return String(s).replace(/\s+/g, " ").trim();
}
function compact(s) {
  return String(s).replace(/\s+/g, " ").trim().slice(0, 180);
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function domainFromFromHeader(from) {
  const m = String(from || "").match(/<([^>]+)>/);
  const addr = (m?.[1] ?? from ?? "").trim();
  const at = addr.lastIndexOf("@");
  if (at === -1) return null;
  return addr.slice(at + 1).toLowerCase();
}

function guessMerchant({ from, subject, text }) {
  const fromLower = String(from || "").toLowerCase();
  const subjectLower = String(subject || "").toLowerCase();
  const textLower = String(text || "").toLowerCase();
  const domain = domainFromFromHeader(from);

  for (const hint of MERCHANT_HINTS) {
    if (domain && hint.domains.some((d) => domain.endsWith(d))) return hint.name;
    if (hint.keywords.some((k) => fromLower.includes(k))) return hint.name;
    if (hint.keywords.some((k) => subjectLower.includes(k))) return hint.name;
    if (hint.keywords.some((k) => textLower.includes(k))) return hint.name;
  }

  const display = String(from || "").split("<")[0].trim();
  if (display && display.length <= 40 && !/no-?reply|notification|billing/i.test(display)) return display;

  return null;
}

function extractAmount(text) {
  const s = String(text || "");
  const lines = s.split(/\n|\r/).slice(0, 250);
  const targetLines = lines
    .filter((l) => /(total|amount|charged|payment|paid|price|plan|renewal price)/i.test(l))
    .concat(lines);

  for (const line of targetLines) {
    const hit = matchCurrencyAmount(line);
    if (hit) return hit;
  }
  return null;
}

function matchCurrencyAmount(s) {
  const usd = String(s).match(/(?:US\$\s?|\$|usd\s?)(\d{1,6}(?:[\.,]\d{2})?)/i);
  if (usd) {
    const amount = parseFloat(usd[1].replace(",", "."));
    if (Number.isFinite(amount) && amount > 0 && amount < 100000) return { amount, currency: "USD" };
  }
  const eur = String(s).match(/(?:€|eur\s?)(\d{1,6}(?:[\.,]\d{2})?)/i);
  if (eur) {
    const amount = parseFloat(eur[1].replace(",", "."));
    if (Number.isFinite(amount) && amount > 0 && amount < 100000) return { amount, currency: "EUR" };
  }
  return null;
}

function guessCadence(text) {
  const t = String(text || "");
  if (/\bweekly\b|every week|per week/i.test(t)) return "weekly";
  if (/\bquarterly\b|every 3 months|per quarter/i.test(t)) return "quarterly";
  if (/\bannual\b|\byearly\b|per year|every year|\/year/i.test(t)) return "yearly";
  if (/\bmonthly\b|per month|every month|\/month/i.test(t)) return "monthly";
  return undefined;
}

function guessNextDate({ haystack, messageDate }) {
  const h = String(haystack || "");
  const idx = h.search(/renews|renewal date|next billing date|billed on|trial ends|valid until|starting|expires|expiring/i);
  const focus = idx >= 0 ? h.slice(idx, Math.min(h.length, idx + 900)) : h.slice(0, 1000);

  const parsed = chrono.parse(focus, messageDate);
  if (!parsed.length) return undefined;

  const now = new Date();
  const future = parsed
    .map((c) => c.start?.date())
    .filter((d) => d instanceof Date)
    .filter((d) => d.getTime() >= now.getTime() - 24 * 3600 * 1000)
    .filter((d) => d.getTime() <= now.getTime() + 400 * 24 * 3600 * 1000)
    .sort((a, b) => a.getTime() - b.getTime());

  if (!future.length) return undefined;
  return toISODate(future[0]);
}

function toISODate(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function makeFingerprint({ from, subject, merchant, amount, date }) {
  const base = `${merchant}|${from}|${subject}|${amount ?? ""}|${toISODate(date)}`;
  return crypto.createHash("sha256").update(base).digest("hex").slice(0, 24);
}
