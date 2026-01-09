import crypto from "node:crypto";
import { htmlToText } from "html-to-text";
import * as chrono from "chrono-node";

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
];

const BODY_KEYWORDS = [
  "renews",
  "renewal date",
  "next billing date",
  "monthly",
  "per month",
  "annual",
  "yearly",
  "per year",
  "billed",
  "trial ends",
  "payment was successful",
  "valid until",
  "account information",
];

const WELCOME_KEYWORDS = ["welcome", "thanks for joining", "start watching", "your account information"];

export function buildCandidate({ from, subject, date, text, html }) {
  const plain = normalizeText(text ?? "") || normalizeText(htmlToTextSafe(html ?? ""));
  const haystack = `${subject}\n${from}\n${plain}`.toLowerCase();

  const merchant = guessMerchant({ from, subject, text: plain }) ?? "Unknown merchant";

  const isWelcomeLike =
    merchant !== "Unknown merchant" &&
    WELCOME_KEYWORDS.some((k) => haystack.includes(k));

  const hasSignal =
    SUBJECT_KEYWORDS.some((k) => subject.toLowerCase().includes(k)) ||
    BODY_KEYWORDS.some((k) => haystack.includes(k)) ||
    isWelcomeLike;

  if (!hasSignal) return null;

  const amountInfo = extractAmount(haystack);
  const cadence = guessCadence(haystack);
  const nextDate = guessNextDate({ haystack, messageDate: date });

  let confidence = 20;
  if (merchant !== "Unknown merchant") confidence += 25;

  confidence += Math.min(25, keywordScore(subject.toLowerCase(), SUBJECT_KEYWORDS));
  confidence += Math.min(20, keywordScore(haystack, BODY_KEYWORDS));

  if (amountInfo?.amount) confidence += 20;
  if (nextDate) confidence += 15;
  if (isWelcomeLike) confidence += 10;

  confidence = clamp(confidence, 0, 100);

  // welcome-like emails are allowed at a slightly lower floor
  const floor = isWelcomeLike ? 30 : 40;
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
    evidence: {
      from: compact(from),
      subject: compact(subject),
      date: date.toISOString(),
    },
  };
}

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
function keywordScore(text, keywords) {
  let score = 0;
  for (const k of keywords) if (text.includes(k)) score += 5;
  return score;
}

function domainFromFromHeader(from) {
  const m = from.match(/<([^>]+)>/);
  const addr = (m?.[1] ?? from).trim();
  const at = addr.lastIndexOf("@");
  if (at === -1) return null;
  return addr.slice(at + 1).toLowerCase();
}

function guessMerchant({ from, subject, text }) {
  const fromLower = from.toLowerCase();
  const subjectLower = subject.toLowerCase();
  const textLower = text.toLowerCase();
  const domain = domainFromFromHeader(from);

  for (const hint of MERCHANT_HINTS) {
    if (domain && hint.domains.some((d) => domain.endsWith(d))) return hint.name;
    if (hint.keywords.some((k) => fromLower.includes(k))) return hint.name;
    if (hint.keywords.some((k) => subjectLower.includes(k))) return hint.name;
    if (hint.keywords.some((k) => textLower.includes(k))) return hint.name;
  }

  const display = from.split("<")[0].trim();
  if (display && display.length <= 40 && !/no-?reply|notification|billing/i.test(display)) return display;

  return null;
}

function extractAmount(text) {
  const lines = text.split(/\n|\r/).slice(0, 250);
  const targetLines = lines
    .filter((l) => /(total|amount|charged|payment|paid|price|plan)/i.test(l))
    .concat(lines);

  for (const line of targetLines) {
    const hit = matchCurrencyAmount(line);
    if (hit) return hit;
  }
  return null;
}

function matchCurrencyAmount(s) {
  const usd = s.match(/(?:\$|usd\s?)(\d{1,6}(?:[\.,]\d{2})?)/i);
  if (usd) {
    const amount = parseFloat(usd[1].replace(",", "."));
    if (Number.isFinite(amount) && amount > 0 && amount < 100000) return { amount, currency: "USD" };
  }
  const eur = s.match(/(?:€|eur\s?)(\d{1,6}(?:[\.,]\d{2})?)/i);
  if (eur) {
    const amount = parseFloat(eur[1].replace(",", "."));
    if (Number.isFinite(amount) && amount > 0 && amount < 100000) return { amount, currency: "EUR" };
  }
  return null;
}

function guessCadence(text) {
  if (/\bweekly\b|every week|per week/i.test(text)) return "weekly";
  if (/\bquarterly\b|every 3 months|per quarter/i.test(text)) return "quarterly";
  if (/\bannual\b|\byearly\b|per year|every year/i.test(text)) return "yearly";
  if (/\bmonthly\b|per month|every month/i.test(text)) return "monthly";
  return undefined;
}

function guessNextDate({ haystack, messageDate }) {
  const idx = haystack.search(/renews|renewal date|next billing date|billed on|trial ends|valid until/i);
  const focus = idx >= 0 ? haystack.slice(idx, Math.min(haystack.length, idx + 500)) : haystack.slice(0, 700);

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
